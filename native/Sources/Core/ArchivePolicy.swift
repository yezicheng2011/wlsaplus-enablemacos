import Foundation

// Inspect the ZIP central directory before passing the archive to macOS ditto.
// New native bundles contain no embedded frameworks or symbolic links.
enum ArchivePolicy {
    static func validate(_ url: URL) throws {
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        let size = try file.seekToEnd()
        let tailSize = Int(min(size, 65557))
        guard tailSize >= 22 else { throw AppError("Invalid ZIP archive.") }
        try file.seek(toOffset: size - UInt64(tailSize))
        let tail = try file.read(upToCount: tailSize) ?? Data()
        func word(_ data: Data, _ offset: Int, _ bytes: Int) throws -> UInt64 {
            guard offset >= 0, offset + bytes <= data.count else { throw AppError("Truncated ZIP metadata.") }
            return (0..<bytes).reduce(0) { $0 | UInt64(data[offset + $1]) << ($1 * 8) }
        }
        var end: Int?
        for i in stride(from: tail.count - 22, through: 0, by: -1) {
            if (try word(tail, i, 4)) == 0x06054b50, i + 22 + Int(try word(tail, i+20, 2)) == tail.count { end = i; break }
        }
        guard let end, try word(tail, end+4, 2) == 0, try word(tail, end+6, 2) == 0 else { throw AppError("Unsupported multipart ZIP.") }
        let entries = Int(try word(tail, end+10, 2)), length = try word(tail, end+12, 4), offset = try word(tail, end+16, 4)
        let endOffset = size - UInt64(tailSize) + UInt64(end)
        guard entries > 0, entries < 20000, try word(tail, end+8, 2) == UInt64(entries), length < 32*1024*1024,
              offset < endOffset, length == endOffset-offset else { throw AppError("Invalid ZIP directory limits.") }
        try file.seek(toOffset: offset)
        let directory = try file.read(upToCount: Int(length)) ?? Data()
        guard directory.count == Int(length) else { throw AppError("Truncated ZIP directory.") }
        var cursor = 0, expanded: UInt64 = 0, names = Set<String>(), canonical = Set<String>(), ranges: [Range<UInt64>] = []
        func read(_ start: UInt64, _ count: Int) throws -> Data {
            guard start < offset, UInt64(count) <= offset-start else { throw AppError("Invalid ZIP local record bounds.") }
            try file.seek(toOffset: start)
            let data = try file.read(upToCount: count) ?? Data()
            guard data.count == count else { throw AppError("Truncated ZIP local record.") }
            return data
        }
        func extras(_ data: Data) throws {
            var p = 0
            while p < data.count {
                let type = try word(data, p, 2), count = Int(try word(data, p+2, 2))
                guard [UInt64(0x5455), 0x000a, 0x7855, 0x7875].contains(type), p+4+count <= data.count else { throw AppError("Unsupported ZIP extra field.") }
                p += 4 + count
            }
        }
        for _ in 0..<entries {
            guard try word(directory, cursor, 4) == 0x02014b50 else { throw AppError("Invalid ZIP directory record.") }
            let flags = try word(directory, cursor+8, 2), compression = try word(directory, cursor+10, 2)
            let crc = try word(directory, cursor+16, 4), compressed = try word(directory, cursor+20, 4), uncompressed = try word(directory, cursor+24, 4), nameLength = Int(try word(directory, cursor+28, 2)), extraLength = Int(try word(directory, cursor+30, 2)), commentLength = Int(try word(directory, cursor+32, 2)), localOffset = try word(directory, cursor+42, 4)
            let attributes = try word(directory, cursor+38, 4), mode = (attributes >> 16) & 0xf000
            let next = cursor + 46 + nameLength + extraLength + commentLength
            guard next <= directory.count, nameLength > 0,
                  let name = String(data: directory[(cursor+46)..<(cursor+46+nameLength)], encoding: .utf8),
                  name.hasPrefix("WLSAPlus.app/"), !name.contains("\\"), !name.contains("\0"),
                  !name.contains(":"), !name.split(separator: "/", omittingEmptySubsequences: false).dropLast(name.hasSuffix("/") ? 1 : 0).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  names.insert(name).inserted, mode == 0 || mode == 0x8000 || mode == 0x4000,
                  canonical.insert(name.decomposedStringWithCanonicalMapping.lowercased()).inserted,
                  flags & ~UInt64(0x0808) == 0, compression == 0 || compression == 8,
                  compressed < 0xffffffff, uncompressed < 0xffffffff else { throw AppError("Unsafe ZIP entry.") }
            try extras(Data(directory[(cursor+46+nameLength)..<(cursor+46+nameLength+extraLength)]))
            let local = try read(localOffset, 30)
            guard try word(local, 0, 4) == 0x04034b50, try word(local, 6, 2) == flags, try word(local, 8, 2) == compression,
                  try word(local, 26, 2) == UInt64(nameLength) else { throw AppError("ZIP local and central headers disagree.") }
            let localExtra = Int(try word(local, 28, 2))
            let localName = try read(localOffset+30, nameLength+localExtra)
            guard localName.prefix(nameLength) == Data(name.utf8) else { throw AppError("ZIP entry names disagree.") }
            try extras(Data(localName.dropFirst(nameLength)))
            let start = localOffset + 30 + UInt64(nameLength+localExtra)
            guard start <= offset, compressed <= offset-start else { throw AppError("ZIP entry overlaps the directory.") }
            var finish = start + compressed
            if flags & 8 == 0 {
                guard try word(local, 14, 4) == crc, try word(local, 18, 4) == compressed, try word(local, 22, 4) == uncompressed else { throw AppError("ZIP entry sizes disagree.") }
            } else {
                let first = try read(finish, 4)
                if try word(first, 0, 4) == 0x08074b50 { finish += 4 }
                let descriptor = try read(finish, 12)
                guard try word(descriptor, 0, 4) == crc, try word(descriptor, 4, 4) == compressed, try word(descriptor, 8, 4) == uncompressed else { throw AppError("Invalid ZIP data descriptor.") }
                finish += 12
            }
            let range = localOffset..<finish
            guard !ranges.contains(where: { $0.overlaps(range) }) else { throw AppError("Overlapping ZIP entries.") }
            ranges.append(range)
            expanded += uncompressed
            guard expanded <= 1024*1024*1024 else { throw AppError("The expanded update exceeds 1 GB.") }
            cursor = next
        }
        guard cursor == directory.count, names.contains("WLSAPlus.app/Contents/Info.plist"), names.contains("WLSAPlus.app/Contents/MacOS/WLSAPlus") else { throw AppError("ZIP does not contain the native app bundle.") }
    }
}
