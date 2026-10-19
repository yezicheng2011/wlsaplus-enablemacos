import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Original offline format reader, not a database engine. Never opens LOCK or
/// modifies the source. The caller must ensure the legacy app has exited.
/// Format references: Google LevelDB log/table documentation, Google's Snappy
/// format description, and CCL's Chromium storage format research. No library
/// implementation source is incorporated.
enum LegacyStore {
    struct Snapshot {
        let values: [String: String]
        let warnings: [String]
    }
    static let allowed: Set<String> = ["wlsaplus:schedule", "wlsaplus:progress", "wlsaplus:todos", "wlsaplus:settings", "wlsaplus:vpn-node", "wlsaplus:vpn-source"]
    private static let maximumFile = 64 * 1024 * 1024
    private static let maximumTotal = 256 * 1024 * 1024
    private static let maximumValue = 16 * 1024 * 1024
    private struct Value { var sequence: UInt64; var bytes: [UInt8]? }
    private struct Table { var level: UInt64; var size: UInt64 }
    private struct Version {
        var tables: [UInt64: Table] = [:]
        var log: UInt64?
        var previousLog: UInt64 = 0
        var sequence: UInt64?
        var comparator: String?
    }
    private struct Cursor {
        let bytes: [UInt8]
        var offset = 0
        var remaining: Int { bytes.count - offset }
        mutating func fixed(_ count: Int) throws -> UInt64 {
            guard count >= 0, count <= 8, count <= remaining else { throw failure("truncated integer") }
            var number: UInt64 = 0
            for index in 0..<count { number |= UInt64(bytes[offset + index]) << (index * 8) }
            offset += count
            return number
        }
        mutating func varint() throws -> UInt64 {
            var number: UInt64 = 0
            for shift in stride(from: 0, through: 63, by: 7) {
                guard remaining > 0 else { throw failure("truncated varint") }
                let byte = bytes[offset]; offset += 1
                if shift == 63 && byte > 1 { throw failure("varint overflow") }
                number |= UInt64(byte & 127) << shift
                if byte < 128 { return number }
            }
            throw failure("varint overflow")
        }
        mutating func take(_ count: Int) throws -> [UInt8] {
            guard count >= 0, count <= remaining else { throw failure("truncated field") }
            let value = Array(bytes[offset..<(offset + count)]); offset += count; return value
        }
        mutating func string(limit: Int = maximumValue) throws -> [UInt8] {
            let count = try varint()
            guard count <= UInt64(limit), count <= UInt64(remaining) else { throw failure("oversized field") }
            return try take(Int(count))
        }
    }
    private static func failure(_ detail: String) -> AppError { AppError("Legacy data could not be read safely (\(detail)). The original files were left untouched.") }

    static func read(directory: URL) throws -> Snapshot {
        let files = try OfflineFiles(directory)
        let current = try files.load("CURRENT", maximum: 128)
        guard let currentText = String(bytes: current, encoding: .utf8), currentText.hasSuffix("\n") else { throw failure("invalid CURRENT") }
        let manifestName = String(currentText.dropLast())
        guard matches(manifestName, #"^MANIFEST-[0-9]{1,20}$"#) else { throw failure("invalid manifest name") }
        var version = Version()
        let manifest = try records(files.load(manifestName), allowIncompleteTail: false)
        guard !manifest.values.isEmpty else { throw failure("empty manifest") }
        for record in manifest.values { try edit(record, version: &version) }
        guard version.comparator == "leveldb.BytewiseComparator", let log = version.log, let sequence = version.sequence,
              sequence < (UInt64(1) << 56), version.tables.count <= 256 else { throw failure("unsupported manifest state") }
        var values: [Data: Value] = [:]
        var recordCount = 0
        func put(_ key: [UInt8], _ value: [UInt8]?, _ sequence: UInt64) throws {
            recordCount += 1
            guard recordCount <= 2_000_000, sequence < (UInt64(1) << 56) else { throw failure("record limit") }
            guard try key == Array("VERSION".utf8) || candidate(key) != nil else { return }
            let dataKey = Data(key)
            if let previous = values[dataKey] {
                if sequence < previous.sequence { return }
                if sequence == previous.sequence {
                    guard previous.bytes == value else { throw failure("conflicting sequence numbers") }
                    return
                }
            }
            values[dataKey] = Value(sequence: sequence, bytes: value)
        }
        for number in version.tables.keys.sorted() {
            let name = String(format: "%06llu", number)
            let actual: String
            if files.names.contains(name + ".ldb") && files.names.contains(name + ".sst") { throw failure("ambiguous table file") }
            if files.names.contains(name + ".ldb") { actual = name + ".ldb" }
            else if files.names.contains(name + ".sst") { actual = name + ".sst" }
            else { throw failure("missing active table") }
            let bytes = try files.load(actual)
            guard UInt64(bytes.count) == version.tables[number]!.size else { throw failure("table size changed") }
            try table(bytes, put: put)
        }
        var warnings: [String] = []
        let logs = files.names.compactMap { name -> (UInt64, String)? in
            guard matches(name, #"^[0-9]{1,20}\.log$"#), let number = UInt64(name.dropLast(4)), number >= log || number == version.previousLog else { return nil }
            return (number, name)
        }.sorted { $0.0 < $1.0 }
        guard logs.count <= 256, log == 0 || logs.contains(where: { $0.0 == log }) else { throw failure("log file limit") }
        for (_, name) in logs {
            let logRecords = try records(files.load(name), allowIncompleteTail: true)
            if logRecords.incomplete { warnings.append("An incomplete trailing write in \(name) was ignored; only complete checksum-valid writes were recovered.") }
            for record in logRecords.values { try batch(record, put: put) }
        }
        guard values[Data("VERSION".utf8)]?.bytes == Array("1".utf8) else { throw failure("unsupported Chromium localStorage version") }
        var result: [String: String] = [:]
        for (key, value) in values {
            guard let name = try candidate(Array(key)), let bytes = value.bytes else { continue }
            let decoded = try text(bytes)
            if let prior = result[name], prior != decoded { throw failure("ambiguous encoded key aliases") }
            result[name] = decoded
        }
        try files.verifyUnchanged()
        return Snapshot(values: result, warnings: warnings)
    }

    private static func candidate(_ key: [UInt8]) throws -> String? {
        let prefix = Array("_file://\0".utf8)
        guard key.starts(with: prefix) else { return nil }
        let decoded = try text(Array(key.dropFirst(prefix.count)))
        return allowed.contains(decoded) ? decoded : nil
    }
    private static func text(_ value: [UInt8]) throws -> String {
        guard let marker = value.first, value.count <= maximumValue else { throw failure("missing string encoding") }
        let body = Array(value.dropFirst())
        if marker == 1 {
            // Chromium's one-byte representation is Latin-1, never UTF-8.
            return String(String.UnicodeScalarView(body.map { UnicodeScalar(UInt32($0))! }))
        }
        if marker == 0 {
            guard body.count % 2 == 0 else { throw failure("invalid UTF-16 length") }
            var units: [UInt16] = []
            for index in stride(from: 0, to: body.count, by: 2) { units.append(UInt16(body[index]) | UInt16(body[index + 1]) << 8) }
            // Reject lone surrogates rather than silently replacing user data.
            var index = 0
            while index < units.count {
                let unit = units[index]
                if unit >= 0xd800 && unit <= 0xdbff {
                    guard index + 1 < units.count, (0xdc00...0xdfff).contains(units[index + 1]) else { throw failure("invalid UTF-16 surrogate") }
                    index += 2
                } else {
                    guard !(0xdc00...0xdfff).contains(unit) else { throw failure("invalid UTF-16 surrogate") }
                    index += 1
                }
            }
            return String(decoding: units, as: UTF16.self)
        }
        throw failure("unknown Chromium string encoding")
    }
    private static func edit(_ bytes: [UInt8], version: inout Version) throws {
        var input = Cursor(bytes: bytes)
        var deleted: [(UInt64, UInt64)] = [], added: [(UInt64, Table)] = []
        while input.remaining > 0 {
            switch try input.varint() {
            case 1:
                guard let comparator = String(bytes: try input.string(limit: 1024), encoding: .utf8) else { throw failure("invalid comparator") }
                if let previous = version.comparator, previous != comparator { throw failure("comparator changed") }
                version.comparator = comparator
            case 2: version.log = try input.varint()
            case 3: _ = try input.varint() // next file number
            case 4: version.sequence = try input.varint()
            case 5:
                guard try input.varint() < 7 else { throw failure("invalid compact level") }
                _ = try input.string(limit: 65536)
            case 6:
                let level = try input.varint(), number = try input.varint()
                guard level < 7 else { throw failure("invalid deleted level") }
                deleted.append((level, number))
            case 7:
                let level = try input.varint(), number = try input.varint(), size = try input.varint()
                guard level < 7, size <= UInt64(maximumFile) else { throw failure("invalid table metadata") }
                _ = try input.string(limit: 65536); _ = try input.string(limit: 65536)
                added.append((number, Table(level: level, size: size)))
            case 9: version.previousLog = try input.varint()
            default: throw failure("unsupported manifest field")
            }
        }
        for (level, number) in deleted where version.tables[number]?.level == level { version.tables.removeValue(forKey: number) }
        for (number, table) in added { version.tables[number] = table }
        guard version.tables.count <= 256 else { throw failure("table inventory limit") }
    }
    private static func batch(_ bytes: [UInt8], put: ([UInt8], [UInt8]?, UInt64) throws -> Void) throws {
        var input = Cursor(bytes: bytes)
        let first = try input.fixed(8), count = try input.fixed(4)
        guard count <= 1_000_000, first < (UInt64(1) << 56), count <= (UInt64(1) << 56) - first else { throw failure("invalid write batch sequence") }
        for number in 0..<count {
            let type = try input.fixed(1), key = try input.string(limit: 65536)
            guard type == 0 || type == 1 else { throw failure("unsupported write type") }
            let value: [UInt8]? = type == 1 ? try input.string() : nil
            try put(key, value, first + number)
        }
        guard input.remaining == 0 else { throw failure("trailing write batch bytes") }
    }

    private static func checksum(_ bytes: [UInt8]) -> UInt32 {
        var value: UInt32 = 0xffffffff
        for byte in bytes {
            value ^= UInt32(byte)
            for _ in 0..<8 { value = value & 1 == 1 ? (value >> 1) ^ 0x82f63b78 : value >> 1 }
        }
        let crc = ~value
        return ((crc >> 15) | (crc << 17)) &+ 0xa282ead8
    }
    private static func records(_ bytes: [UInt8], allowIncompleteTail: Bool) throws -> (values: [[UInt8]], incomplete: Bool) {
        var offset = 0, pending: [UInt8]? = nil, output: [[UInt8]] = []
        var incomplete = false
        while offset < bytes.count {
            let blockEnd = min((offset / 32768 + 1) * 32768, bytes.count)
            let blockRemaining = 32768 - offset % 32768
            if blockRemaining < 7 {
                guard bytes[offset..<blockEnd].allSatisfy({ $0 == 0 }) else { throw failure("invalid log padding") }
                offset = blockEnd; continue
            }
            if bytes.count - offset < 7 {
                if allowIncompleteTail { incomplete = true; break }
                throw failure("incomplete manifest record")
            }
            var header = Cursor(bytes: Array(bytes[offset..<(offset + 7)]))
            let crc = try header.fixed(4), length = Int(try header.fixed(2)), type = UInt8(try header.fixed(1))
            if crc == 0 && length == 0 && type == 0 {
                if pending != nil {
                    if allowIncompleteTail && blockEnd == bytes.count { incomplete = true; break }
                    throw failure("zero block interrupts a fragmented record")
                }
                guard bytes[offset..<blockEnd].allSatisfy({ $0 == 0 }) else { throw failure("invalid zero log record") }
                offset = blockEnd; continue
            }
            guard length <= blockRemaining - 7 else { throw failure("log record crosses a block") }
            if offset + 7 + length > bytes.count {
                if allowIncompleteTail { incomplete = true; break }
                throw failure("incomplete manifest body")
            }
            let data = Array(bytes[(offset + 7)..<(offset + 7 + length)])
            guard checksum([type] + data) == UInt32(crc) else { throw failure("log checksum mismatch") }
            switch type {
            case 1:
                guard pending == nil else { throw failure("interrupted fragmented log record") }
                output.append(data)
            case 2:
                guard pending == nil else { throw failure("nested fragmented log record") }
                pending = data
            case 3, 4:
                guard var partial = pending, partial.count + data.count <= maximumFile else { throw failure("orphaned or oversized log fragment") }
                partial.append(contentsOf: data)
                if type == 4 { output.append(partial); pending = nil } else { pending = partial }
            default: throw failure("unsupported log record type")
            }
            guard output.count <= 1_000_000 else { throw failure("log record limit") }
            offset += 7 + length
        }
        if pending != nil {
            guard allowIncompleteTail else { throw failure("unfinished manifest record") }
            incomplete = true
        }
        return (output, incomplete)
    }

    private static func table(_ bytes: [UInt8], put: ([UInt8], [UInt8]?, UInt64) throws -> Void) throws {
        guard bytes.count >= 48 else { throw failure("truncated table footer") }
        let footerStart = bytes.count - 48
        var footer = Cursor(bytes: Array(bytes[footerStart...]))
        let meta = try handle(&footer), index = try handle(&footer)
        guard footer.offset <= 40, footer.bytes[footer.offset..<40].allSatisfy({ $0 == 0 }) else { throw failure("invalid footer padding") }
        footer.offset = 40
        guard try footer.fixed(8) == 0xdb4775248b80fb57 else { throw failure("invalid table magic") }
        _ = try block(bytes, handle: meta, before: footerStart)
        let entries = try blockEntries(block(bytes, handle: index, before: footerStart))
        var seen = Set<UInt64>(), expanded = 0
        for (_, value) in entries {
            var input = Cursor(bytes: value)
            let position = try handle(&input)
            guard input.remaining == 0, seen.insert(position.offset).inserted else { throw failure("ambiguous data block handle") }
            let data = try block(bytes, handle: position, before: Int(index.offset))
            expanded += data.count
            guard expanded <= maximumTotal else { throw failure("table expansion limit") }
            for (key, value) in try blockEntries(data) {
                guard key.count >= 8 else { throw failure("short internal key") }
                var tag = Cursor(bytes: Array(key.suffix(8)))
                let number = try tag.fixed(8), type = number & 255
                guard type == 0 || type == 1, type != 0 || value.isEmpty else { throw failure("unsupported table record") }
                try put(Array(key.dropLast(8)), type == 1 ? value : nil, number >> 8)
            }
        }
    }
    private struct Handle { let offset: UInt64; let length: UInt64 }
    private static func handle(_ input: inout Cursor) throws -> Handle { Handle(offset: try input.varint(), length: try input.varint()) }
    private static func block(_ table: [UInt8], handle: Handle, before: Int) throws -> [UInt8] {
        guard handle.offset <= UInt64(before), handle.length <= UInt64(maximumFile),
              handle.length + 5 <= UInt64(before) - handle.offset else { throw failure("block handle outside table") }
        let offset = Int(handle.offset), end = offset + Int(handle.length)
        let compressed = Array(table[offset..<end]), type = table[end]
        var trailer = Cursor(bytes: Array(table[(end + 1)..<(end + 5)]))
        guard checksum(compressed + [type]) == UInt32(try trailer.fixed(4)) else { throw failure("table checksum mismatch") }
        if type == 0 { return compressed }
        if type == 1 { return try snappy(compressed) }
        throw failure("unsupported table compression")
    }
    private static func blockEntries(_ bytes: [UInt8]) throws -> [([UInt8], [UInt8])] {
        guard bytes.count >= 4 else { throw failure("short restart array") }
        var tail = Cursor(bytes: Array(bytes.suffix(4)))
        let count = try tail.fixed(4)
        guard count > 0, count <= UInt64((bytes.count - 4) / 4) else { throw failure("invalid restart count") }
        let end = bytes.count - 4 - Int(count) * 4
        var restarts = Cursor(bytes: Array(bytes[end..<(bytes.count - 4)])), points: [Int] = []
        for _ in 0..<count {
            let point = try restarts.fixed(4)
            guard point <= UInt64(end), (points.isEmpty ? point == 0 : point > UInt64(points.last!)) else { throw failure("invalid restart offset") }
            points.append(Int(point))
        }
        if end == 0 { guard points == [0] else { throw failure("invalid empty block") }; return [] }
        let pointSet = Set(points)
        var input = Cursor(bytes: Array(bytes[..<end])), key: [UInt8] = [], output: [([UInt8], [UInt8])] = [], actual = Set<Int>()
        while input.remaining > 0 {
            let start = input.offset
            let shared = try input.varint(), unshared = try input.varint(), valueLength = try input.varint()
            guard shared <= UInt64(key.count), unshared <= 65536, shared + unshared <= 65536,
                  unshared <= UInt64(input.remaining), valueLength <= UInt64(maximumValue), valueLength <= UInt64(input.remaining) - unshared else { throw failure("invalid prefix-compressed entry") }
            if pointSet.contains(start) { guard shared == 0 else { throw failure("shared restart key") }; actual.insert(start) }
            key = Array(key.prefix(Int(shared))) + (try input.take(Int(unshared)))
            output.append((key, try input.take(Int(valueLength))))
            guard output.count <= 1_000_000 else { throw failure("block entry limit") }
        }
        guard actual == pointSet else { throw failure("restart does not point to an entry") }
        return output
    }

    /// Raw Snappy, independently implemented from the public byte format.
    static func snappy(_ bytes: [UInt8]) throws -> [UInt8] {
        var input = Cursor(bytes: bytes)
        let expected = try input.varint()
        guard expected <= UInt64(maximumFile) else { throw failure("Snappy expansion limit") }
        var output: [UInt8] = []; output.reserveCapacity(Int(expected))
        while input.remaining > 0 {
            let tag = UInt8(try input.fixed(1)), type = tag & 3
            if type == 0 {
                let encoded = Int(tag >> 2)
                let length = encoded < 60 ? UInt64(encoded + 1) : (try input.fixed(encoded - 59)) + 1
                guard length <= expected - UInt64(output.count), length <= UInt64(input.remaining) else { throw failure("invalid Snappy literal") }
                output.append(contentsOf: try input.take(Int(length)))
            } else {
                let length: Int, distance: UInt64
                if type == 1 { length = 4 + Int((tag >> 2) & 7); distance = UInt64(tag & 0xe0) << 3 | (try input.fixed(1)) }
                else { length = 1 + Int(tag >> 2); distance = try input.fixed(type == 2 ? 2 : 4) }
                guard distance > 0, distance <= UInt64(output.count), UInt64(length) <= expected - UInt64(output.count) else { throw failure("invalid Snappy backreference") }
                for _ in 0..<length { output.append(output[output.count - Int(distance)]) }
            }
        }
        guard output.count == Int(expected) else { throw failure("Snappy length mismatch") }
        return output
    }

    private final class OfflineFiles {
        let directory: URL
        let names: Set<String>
        private var fingerprints: [String: String] = [:]
        private var total = 0
        init(_ directory: URL) throws {
            self.directory = directory
            names = Set(try FileManager.default.contentsOfDirectory(atPath: directory.path))
            guard names.count <= 4096 else { throw failure("directory file limit") }
        }
        private func fingerprint(_ attributes: [FileAttributeKey: Any]) -> String {
            "\(attributes[.systemFileNumber] ?? ""):\(attributes[.size] ?? ""):\((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? -1)"
        }
        func load(_ name: String, maximum: Int = maximumFile) throws -> [UInt8] {
            guard !name.contains("/"), !name.contains("\0"), name != ".", name != ".." else { throw failure("unsafe filename") }
            let url = directory.appendingPathComponent(name)
            let before = try FileManager.default.attributesOfItem(atPath: url.path)
            guard before[.type] as? FileAttributeType == .typeRegular,
                  let size = before[.size] as? NSNumber, size.intValue >= 0, size.intValue <= maximum else { throw failure("file limit or symbolic link") }
            let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw failure("cannot open source file") }
            let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            defer { try? file.close() }
            let data = try file.read(upToCount: maximum + 1) ?? Data()
            guard data.count == size.intValue else { throw failure("source file changed") }
            total += data.count
            guard total <= maximumTotal else { throw failure("database size limit") }
            let after = try FileManager.default.attributesOfItem(atPath: url.path)
            guard fingerprint(before) == fingerprint(after) else { throw failure("source file changed") }
            fingerprints[name] = fingerprint(after)
            return Array(data)
        }
        func verifyUnchanged() throws {
            guard Set(try FileManager.default.contentsOfDirectory(atPath: directory.path)) == names else { throw failure("source database is still changing; quit the old app") }
            for (name, previous) in fingerprints {
                let current = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(name).path)
                guard fingerprint(current) == previous else { throw failure("source database is still changing; quit the old app") }
            }
        }
    }
}
