import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Local fair-use accounting for one WLSAPlus installation.
/// Usage is unlimited for normal personal use. Crossing either rolling window
/// only slows the tunnel; it never means the VPN should disconnect.
/// Both directions share one budget: 50 GB (50e9 bytes) in 24 hours, or
/// 500 GB (500e9 bytes) in 30 days, then about 5 Mbps combined (625,000 bytes/s).
struct FairUseLedger: Equatable {
    static let dayBytes: Int64 = 50_000_000_000
    static let monthBytes: Int64 = 500_000_000_000
    static let dayWindow: TimeInterval = 86_400
    static let monthWindow: TimeInterval = 30 * 86_400
    static let bytesPerSecond: Int64 = 625_000
    static let statusLimited = "Fair use limit reached — speed temporarily reduced, will restore automatically"
    static let statusUnlimited = "Unlimited for normal personal use."

    private var buckets: [Int: Int64] = [:]
    private var dayTotal: Int64 = 0
    private var monthTotal: Int64 = 0
    /// Oldest minute still stored, and the oldest minute included in each rolling total.
    private var monthFloor = 0
    private var dayFloor = 0
    private var aligned = false
    private var tokens = Double(bytesPerSecond)
    private var pacedAt: TimeInterval = 0
    private var limiting = false

    mutating func record(bytes: Int64, now: TimeInterval) {
        guard bytes > 0, now.isFinite else { return }
        align(to: now)
        let minute = Self.minute(now)
        if minute < monthFloor { return }
        let next = (buckets[minute] ?? 0).addingReportingOverflow(bytes)
        let stored = next.overflow ? Int64.max : next.partialValue
        buckets[minute] = stored
        monthTotal = Self.add(monthTotal, bytes)
        if minute >= dayFloor { dayTotal = Self.add(dayTotal, bytes) }
    }

    mutating func total(window: TimeInterval, now: TimeInterval) -> Int64 {
        guard window > 0, now.isFinite else { return 0 }
        align(to: now)
        if window == Self.dayWindow { return dayTotal }
        if window == Self.monthWindow { return monthTotal }
        let cut = Self.cutoff(now: now, window: window)
        var sum: Int64 = 0
        for (minute, bytes) in buckets where minute >= cut && bytes > 0 { sum = Self.add(sum, bytes) }
        return sum
    }

    mutating func isThrottled(now: TimeInterval) -> Bool {
        align(to: now)
        return dayTotal > Self.dayBytes || monthTotal > Self.monthBytes
    }

    /// Bytes that may move now. Over the limit this is a shared token bucket for
    /// upload and download together. Under the limit the full request is allowed.
    /// `atomic` waits until the whole request fits, so a UDP datagram is not split.
    mutating func pace(requested: Int, now: TimeInterval, atomic: Bool = false) -> Int {
        guard requested > 0, now.isFinite else { return 0 }
        let limited = isThrottled(now: now)
        if !limited {
            tokens = Double(Self.bytesPerSecond)
            pacedAt = now
            limiting = false
            return requested
        }
        if !limiting || pacedAt == 0 {
            tokens = Double(Self.bytesPerSecond)
            pacedAt = now
            limiting = true
        }
        let elapsed = max(0, now - pacedAt)
        pacedAt = now
        let cap = Double(Self.bytesPerSecond)
        tokens = min(cap, tokens + elapsed * cap)
        if atomic {
            if requested > Int(cap) {
                guard tokens >= cap else { return 0 }
                tokens = 0
                return requested
            }
            guard Int(tokens) >= requested else { return 0 }
            tokens -= Double(requested)
            return requested
        }
        let allowed = min(requested, Int(tokens))
        tokens -= Double(allowed)
        return allowed
    }

    private static func minute(_ now: TimeInterval) -> Int { Int((now / 60).rounded(.down)) }
    private static func cutoff(now: TimeInterval, window: TimeInterval) -> Int { Int(((now - window) / 60).rounded(.down)) }
    private static func add(_ lhs: Int64, _ rhs: Int64) -> Int64 {
        let next = lhs.addingReportingOverflow(rhs)
        return next.overflow ? Int64.max : next.partialValue
    }
    private static func subtract(_ lhs: Int64, _ rhs: Int64) -> Int64 { lhs > rhs ? lhs - rhs : 0 }

    /// Drop minutes that have left the 30-day window, and stop counting minutes
    /// that have left the 24-hour window. Only the expired edge is visited.
    private mutating func align(to now: TimeInterval) {
        let dayCut = Self.cutoff(now: now, window: Self.dayWindow)
        let monthCut = Self.cutoff(now: now, window: Self.monthWindow)
        if !aligned {
            dayTotal = 0
            monthTotal = 0
            var keep: [Int: Int64] = [:]
            keep.reserveCapacity(buckets.count)
            for (minute, bytes) in buckets where bytes > 0 && minute >= monthCut {
                keep[minute] = bytes
                monthTotal = Self.add(monthTotal, bytes)
                if minute >= dayCut { dayTotal = Self.add(dayTotal, bytes) }
            }
            buckets = keep
            monthFloor = monthCut
            dayFloor = dayCut
            aligned = true
            return
        }
        if monthCut - monthFloor > 180 {
            aligned = false
            align(to: now)
            return
        }
        while monthFloor < monthCut {
            if let bytes = buckets.removeValue(forKey: monthFloor) {
                monthTotal = Self.subtract(monthTotal, bytes)
                if monthFloor >= dayFloor { dayTotal = Self.subtract(dayTotal, bytes) }
            }
            monthFloor += 1
        }
        if dayFloor < monthFloor { dayFloor = monthFloor }
        while dayFloor < dayCut {
            if let bytes = buckets[dayFloor] { dayTotal = Self.subtract(dayTotal, bytes) }
            dayFloor += 1
        }
    }

    func encoded() throws -> Data {
        let pairs = buckets.filter { $0.value > 0 }.map { [$0.key, Int($0.value)] }.sorted { $0[0] < $1[0] }
        return try jsonData(["version": 1, "buckets": pairs])
    }

    static func load(_ data: Data) throws -> FairUseLedger {
        let object = try jsonObject(data, maximum: 2_000_000)
        guard (object["version"] as? Int) == 1 || (object["version"] as? NSNumber)?.intValue == 1,
              let pairs = object["buckets"] as? [Any] else {
            throw AppError("The fair-use ledger could not be read.")
        }
        guard pairs.count <= 50_000 else { throw AppError("The fair-use ledger is too large.") }
        var ledger = FairUseLedger()
        for item in pairs {
            guard let pair = item as? [NSNumber], pair.count == 2, pair[0].int64Value >= 0, pair[1].int64Value >= 0 else {
                throw AppError("The fair-use ledger could not be read.")
            }
            ledger.buckets[Int(pair[0].int64Value)] = pair[1].int64Value
        }
        return ledger
    }

}

/// Upload queue shared by the helper. UDP leaves only as a whole datagram.
/// A TCP FIN is forwarded only after that flow's queued bytes have been sent.
struct UploadScheduler {
    struct Item: Equatable {
        var id: UInt64
        var data: Data
        var offset: Int
        var udp: Bool
        var fin: Bool
    }
    struct Slice: Equatable {
        var id: UInt64
        var bytes: Data
        var fin: Bool
    }
    private(set) var items: [Item] = []

    mutating func enqueue(id: UInt64, data: Data, udp: Bool) {
        guard !data.isEmpty else { return }
        items.append(Item(id: id, data: data, offset: 0, udp: udp, fin: false))
    }

    /// False while this flow still has queued payload. The caller must not send FIN yet.
    mutating func requestFin(id: UInt64) -> Bool {
        guard let index = items.lastIndex(where: { $0.id == id && $0.offset < $0.data.count }) else { return true }
        items[index].fin = true
        return false
    }

    mutating func flush(ledger: inout FairUseLedger, now: TimeInterval) -> [Slice] {
        var sent: [Slice] = []
        while !items.isEmpty {
            let index = 0
            var item = items[index]
            let remain = item.data.count - item.offset
            let allowed = ledger.pace(requested: remain, now: now, atomic: item.udp)
            if allowed == 0 { break }
            if item.udp, allowed != remain { break }
            let bytes = item.data.subdata(in: item.offset..<(item.offset + allowed))
            item.offset += allowed
            let done = item.offset >= item.data.count
            sent.append(Slice(id: item.id, bytes: bytes, fin: done && item.fin))
            if done { items.remove(at: index) }
            else { items[index] = item; break }
        }
        return sent
    }

    mutating func drop(id: UInt64) { items.removeAll { $0.id == id } }
    var heldBytes: Int { items.reduce(0) { $0 + ($1.data.count - $1.offset) } }
}

/// What to do with bytes already read from a proxy while the tunnel is draining.
/// A slow fair-use drain pauses the read. It does not abort the flow.
enum DownloadAccept: Equatable {
    case queued
    case pause
    case runaway

    /// Stop reading once this much is waiting. Matches the existing TCP pause.
    static let highWater = 128 * 1024
    /// Read again only after the paced drain has fallen below this.
    static let lowWater = 64 * 1024
    /// A stuck reader, not a throttled one. 16 MB is many seconds even at full speed.
    static let runawayBytes = 16 * 1024 * 1024

    static func decide(buffered: Int, incoming: Int) -> DownloadAccept {
        let next = buffered.addingReportingOverflow(max(0, incoming))
        let total = next.overflow ? Int.max : next.partialValue
        if total > runawayBytes { return .runaway }
        if total >= highWater { return .pause }
        return .queued
    }

    static func shouldResume(buffered: Int) -> Bool { buffered < lowWater }
}

/// Root-owned ledger directory. Every component is opened with O_NOFOLLOW and
/// bytes are written through a directory file descriptor, never a user path + chown.
/// macOS publishes `/var` and `/tmp` as symlinks to `private/var` and `private/tmp`.
/// Foundation then strips a leading `/private` from a resolved file URL, so the
/// temporary directory CI walks still begins with `/var`. O_NOFOLLOW rejects that
/// symlink. When the walk root's entry is exactly that relative system alias, the
/// walk continues at the already-existing `private/<name>` directory and does not
/// follow the link. A different target, a symlink below the walk root, or a swap
/// after the directory descriptor is open is still rejected.
final class FairUseDirectory {
    private let directory: Int32
    private let name: String
    /// `anchor` is the walk root. Production leaves it nil and starts at `/`.
    /// Tests pass a private directory that reproduces the macOS `/var` alias.
    init(parent: URL, subdirectory: String, name: String, requireRoot: Bool, anchor: URL? = nil) throws {
        guard parent.isFileURL, parent.path.hasPrefix("/"),
              Self.component(subdirectory), Self.component(name), name != subdirectory else {
            throw AppError("Invalid fair-use ledger location.")
        }
        if let anchor {
            guard anchor.isFileURL, anchor.path.hasPrefix("/") else { throw AppError("Invalid fair-use ledger location.") }
        }
        self.name = name
        let parentComponents = parent.pathComponents.filter { $0 != "/" }
        let anchorComponents = anchor?.pathComponents.filter { $0 != "/" } ?? []
        guard parentComponents.starts(with: anchorComponents) else { throw AppError("Invalid fair-use ledger location.") }
        var components = Array(parentComponents.dropFirst(anchorComponents.count))
        var allowCreate = [Bool](repeating: true, count: components.count)
        let start = anchor?.path ?? "/"
        let startFlags = anchor == nil ? (O_RDONLY | O_DIRECTORY | O_CLOEXEC) : (O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        var current = open(start, startFlags)
        guard current >= 0 else { throw AppError("Cannot open the fair-use directory.") }
        var rootInfo = stat()
        guard fstat(current, &rootInfo) == 0 else {
            close(current)
            throw AppError("Cannot open the fair-use directory.")
        }
        do {
            let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            var index = 0
            while index < components.count {
                let component = components[index]
                guard Self.component(component) else { throw AppError("Invalid fair-use ledger location.") }
                var next = openat(current, component, flags)
                if next < 0 {
                    let openError = errno
                    if openError == ENOENT && allowCreate[index] {
                        guard mkdirat(current, component, 0o700) == 0 else { throw AppError("Cannot create fair-use storage.") }
                        next = openat(current, component, flags)
                    } else if openError == ELOOP || openError == ENOTDIR,
                              let alias = Self.systemRootAlias(directory: current, root: rootInfo, component: component),
                              Self.aliasIsRealDirectory(directory: current, components: alias) {
                        // Linux returns ENOTDIR for O_DIRECTORY|O_NOFOLLOW on a symlink.
                        // Darwin's open(2) returns ELOOP for O_NOFOLLOW. Either may be the
                        // system alias; any other target still fails below.
                        components.replaceSubrange(index..<(index + 1), with: alias)
                        allowCreate.replaceSubrange(index..<(index + 1), with: [Bool](repeating: false, count: alias.count))
                        continue
                    }
                }
                guard next >= 0 else { throw AppError("The fair-use path contains an inaccessible directory or symbolic link.") }
                close(current); current = next
                index += 1
            }
            if mkdirat(current, subdirectory, 0o700) != 0 && errno != EEXIST { throw AppError("Cannot create fair-use storage.") }
            guard fsync(current) == 0 else { throw AppError("Cannot sync fair-use storage.") }
            let secured = openat(current, subdirectory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard secured >= 0 else { throw AppError("Cannot open fair-use storage.") }
            close(current); current = secured
            var metadata = stat()
            guard fstat(current, &metadata) == 0, metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  metadata.st_mode & 0o777 == 0o700, !requireRoot || metadata.st_uid == 0 else {
                throw AppError("Fair-use storage is not a private directory.")
            }
            directory = current
        } catch { close(current); throw error }
    }
    deinit { close(directory) }
    func read() throws -> Data? {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw AppError("Cannot open the fair-use ledger.") }
        defer { close(fd) }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              metadata.st_nlink == 1, metadata.st_size >= 0, metadata.st_size <= 2_000_000 else {
            throw AppError("Unsafe fair-use ledger.")
        }
        var bytes = [UInt8](repeating: 0, count: Int(metadata.st_size))
        var offset = 0
        while offset < bytes.count {
            let count = bytes.withUnsafeMutableBytes { raw in Self.systemRead(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw AppError("Cannot read the fair-use ledger.") }
            offset += count
        }
        return Data(bytes)
    }
    func write(_ data: Data) throws {
        let temporary = ".\(name).\(UUID().uuidString).tmp"
        guard Self.component(temporary) else { throw AppError("Cannot create a fair-use checkpoint.") }
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw AppError("Cannot create a fair-use checkpoint.") }
        defer { close(fd); _ = unlinkat(directory, temporary, 0) }
        var offset = 0
        while offset < data.count {
            let count = data.withUnsafeBytes { bytes in Self.systemWrite(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw AppError("Cannot write a fair-use checkpoint.") }
            offset += count
        }
        guard fsync(fd) == 0, renameat(directory, temporary, directory, name) == 0, fsync(directory) == 0 else {
            throw AppError("Cannot commit the fair-use ledger.")
        }
    }
    /// The walk root may contain macOS's `/var` or `/tmp` symlink. Only the exact
    /// relative text `private/var` or `private/tmp` is accepted, and only while
    /// the directory descriptor is still that root. The returned names are opened
    /// afterwards with O_NOFOLLOW; the symlink is not followed.
    private static func systemRootAlias(directory: Int32, root: stat, component: String) -> [String]? {
        var here = stat()
        guard fstat(directory, &here) == 0, here.st_ino == root.st_ino, here.st_dev == root.st_dev else { return nil }
        switch component {
        case "var" where linkText(directory: directory, component: component) == "private/var":
            return ["private", "var"]
        case "tmp" where linkText(directory: directory, component: component) == "private/tmp":
            return ["private", "tmp"]
        default:
            return nil
        }
    }
    private static func linkText(directory: Int32, component: String) -> String? {
        let capacity = 64
        var buffer = [CChar](repeating: 0, count: capacity)
        let length = component.withCString { name in
            buffer.withUnsafeMutableBufferPointer { raw -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return readlinkat(directory, name, base, raw.count)
            }
        }
        guard length > 0, length < capacity else { return nil }
        let bytes = buffer.prefix(length).map { UInt8(bitPattern: $0) }
        return String(bytes: bytes, encoding: .utf8)
    }
    /// True only when every alias component already exists and is a real directory.
    /// Missing components are not created, so a matching link text cannot mkdir `/private`.
    private static func aliasIsRealDirectory(directory: Int32, components: [String]) -> Bool {
        guard !components.isEmpty else { return false }
        var cursor = directory
        var opened: [Int32] = []
        defer { for fd in opened { close(fd) } }
        let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        for name in components {
            let fd = openat(cursor, name, flags)
            if fd < 0 { return false }
            opened.append(fd)
            cursor = fd
        }
        return true
    }
    private static func component(_ value: String) -> Bool {
        !value.isEmpty && value != "." && value != ".." && !value.contains("\0") && !value.contains("/") && value.utf8.count < 128
    }
    private static func systemRead(_ fd: Int32, _ pointer: UnsafeMutableRawPointer, _ count: Int) -> Int {
        #if canImport(Darwin)
        Darwin.read(fd, pointer, count)
        #else
        Glibc.read(fd, pointer, count)
        #endif
    }
    private static func systemWrite(_ fd: Int32, _ pointer: UnsafeRawPointer, _ count: Int) -> Int {
        #if canImport(Darwin)
        Darwin.write(fd, pointer, count)
        #else
        Glibc.write(fd, pointer, count)
        #endif
    }
}
