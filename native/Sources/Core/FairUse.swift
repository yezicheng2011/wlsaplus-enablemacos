import Foundation

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
    private var tokens = Double(bytesPerSecond)
    private var pacedAt: TimeInterval = 0
    private var limiting = false

    mutating func record(bytes: Int64, now: TimeInterval) {
        guard bytes > 0, now.isFinite else { return }
        let minute = Int((now / 60).rounded(.down))
        let next = (buckets[minute] ?? 0).addingReportingOverflow(bytes)
        buckets[minute] = next.overflow ? Int64.max : next.partialValue
        prune(now: now)
    }

    func total(window: TimeInterval, now: TimeInterval) -> Int64 {
        guard window > 0, now.isFinite else { return 0 }
        let start = now - window
        var sum: Int64 = 0
        for (minute, bytes) in buckets where bytes > 0 {
            // Keep a minute until it has fully left the window (at most 60 seconds conservative).
            guard TimeInterval(minute + 1) * 60 > start else { continue }
            let next = sum.addingReportingOverflow(bytes)
            sum = next.overflow ? Int64.max : next.partialValue
        }
        return sum
    }

    func isThrottled(now: TimeInterval) -> Bool {
        total(window: Self.dayWindow, now: now) > Self.dayBytes || total(window: Self.monthWindow, now: now) > Self.monthBytes
    }

    /// Bytes that may move now. Over the limit this is a shared token bucket for
    /// upload and download together. Under the limit the full request is allowed.
    mutating func pace(requested: Int, now: TimeInterval) -> Int {
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
        tokens = min(Double(Self.bytesPerSecond), tokens + elapsed * Double(Self.bytesPerSecond))
        let allowed = min(requested, Int(tokens))
        tokens -= Double(allowed)
        return allowed
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

    private mutating func prune(now: TimeInterval) {
        let oldest = Int(((now - Self.monthWindow) / 60).rounded(.down)) - 2
        buckets = buckets.filter { $0.key >= oldest && $0.value > 0 }
    }
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

enum FairUsePath {
    static func expected(home: String) -> String {
        URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/WLSAPlus/fair-use.json").standardizedFileURL.path
    }
    static func validate(_ path: String, home: String) throws -> URL {
        guard !path.isEmpty, !path.contains("\0"), !home.isEmpty, !home.contains("\0"),
              !path.contains(".."), !home.contains("..") else { throw AppError("Invalid fair-use ledger path.") }
        let given = URL(fileURLWithPath: path).standardizedFileURL
        let expected = URL(fileURLWithPath: expected(home: home))
        guard given.path == expected.path else { throw AppError("Invalid fair-use ledger path.") }
        return given
    }
}
