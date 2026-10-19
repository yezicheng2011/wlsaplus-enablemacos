import Foundation

struct AppError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum AppIdentity {
    static let bundle = "cn.org.wlsash.wlsaplus"
    static let product = "wlsaplus-macos"
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "2.0.0-beta.1"
    static let certificate = "764D4389AAFA0C50311E39C17DDFA1981ABEF86C"
    static let requirement = "identifier \"\(bundle)\" and certificate leaf = H\"\(certificate)\""
    static let publicKeyDER = "MCowBQYDK2VwAyEAFdlAH6S/8HdZHKQ8MR0OnzWFUtAerd/mfJwy0jVsoNM="
    static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("WLSAPlus", isDirectory: true)
    }
}

func jsonData(_ value: Any) throws -> Data {
    guard JSONSerialization.isValidJSONObject(value) else { throw AppError("Invalid JSON data.") }
    return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
}

func jsonObject(_ data: Data, maximum: Int = 8 * 1024 * 1024) throws -> [String: Any] {
    guard data.count <= maximum, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw AppError("The response is too large or has an unexpected format.")
    }
    return value
}

func secureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
}

func privateWrite(_ data: Data, to url: URL) throws {
    try secureDirectory(url.deletingLastPathComponent())
    try data.write(to: url, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

@discardableResult
func run(_ executable: String, _ arguments: [String], input: Data? = nil) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let output = Pipe()
    let errors = Pipe()
    process.standardOutput = output
    process.standardError = errors
    let writer = Pipe()
    if input != nil { process.standardInput = writer }
    try process.run()
    if let input { writer.fileHandleForWriting.write(input); try? writer.fileHandleForWriting.close() }
    // Bound command output. Commands called here are system utilities, never remote programs.
    let result = output.fileHandleForReading.readDataToEndOfFile()
    let detail = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw AppError(String(data: detail.prefix(4096), encoding: .utf8) ?? "System operation failed.")
    }
    return String(data: result, encoding: .utf8) ?? ""
}

func shellLiteral(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

func elevatedCommand(_ executable: String, _ arguments: [String]) throws {
    let command = ([executable] + arguments).map(shellLiteral).joined(separator: " ")
    let escaped = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    try run("/usr/bin/osascript", ["-e", "do shell script \"\(escaped)\" with administrator privileges"])
}

final class LocalState {
    let file: URL
    private(set) var value: [String: Any]
    init(directory: URL = AppIdentity.support, allowLegacyMigration: Bool = true) throws {
        try secureDirectory(directory)
        file = directory.appendingPathComponent("native-state.json")
        if FileManager.default.fileExists(atPath: file.path) {
            value = try jsonObject(Data(contentsOf: file))
        } else {
            value = [:]
        }
        if value["appearance"] == nil { value["appearance"] = "system" }
        if value["accent"] == nil { value["accent"] = "default" }
        if value["reminders"] == nil { value["reminders"] = true }
        if value["channel"] == nil {
            let legacySettings = directory.appendingPathComponent("updates/settings.json")
            let saved = (try? jsonObject(Data(contentsOf: legacySettings), maximum: 65536))?["channel"] as? String
            value["channel"] = ["stable", "beta"].contains(saved ?? "") ? saved! : (AppIdentity.version.contains("-") ? "beta" : "stable")
        }
        if value["todos"] == nil { value["todos"] = [[String: Any]]() }
        if value["snapshot"] == nil { value["snapshot"] = ["courses": [], "schedule": [], "assignments": [], "attendance": []] as [String: Any] }
        let legacy = directory.appendingPathComponent("Local Storage/leveldb", isDirectory: true)
        if !FileManager.default.fileExists(atPath: file.path), FileManager.default.fileExists(atPath: legacy.appendingPathComponent("CURRENT").path) {
            do {
                guard allowLegacyMigration else { throw AppError("Quit the previous WLSAPlus application before importing its saved data.") }
                let snapshot = try LegacyStore.read(directory: legacy)
                let converted = try LegacyMigration.transform(snapshot.values)
                value.merge(converted.state) { _, new in new }
                value["migration"] = ["status": "complete", "notes": snapshot.warnings + converted.notes]
                try privateWrite(jsonData(value), to: file)
            } catch {
                value["migration"] = ["status": "pending", "message": "Old data was left untouched because its format could not be safely migrated. \(error.localizedDescription)"]
            }
        }
    }
    func set(_ key: String, _ item: Any?) throws {
        var next = value
        next[key] = item
        try privateWrite(jsonData(next), to: file)
        value = next
    }
    func replace(_ next: [String: Any]) throws {
        try privateWrite(jsonData(next), to: file)
        value = next
    }
    func settings(_ patch: [String: Any]) throws {
        let allowed: Set<String> = ["appearance", "accent", "reminders", "autostart", "tuningEnabled", "tunedTime", "channel"]
        var next = value
        for (key, item) in patch where allowed.contains(key) { next[key] = item }
        guard ["system", "light", "dark"].contains(next["appearance"] as? String ?? ""),
              ["default", "red", "orange", "yellow", "green", "blue", "purple", "pink", "rose"].contains(next["accent"] as? String ?? "") else {
            throw AppError("Invalid appearance setting.")
        }
        if let channel = next["channel"] as? String, !["stable", "beta"].contains(channel) { throw AppError("Invalid update channel.") }
        try privateWrite(jsonData(next), to: file)
        value = next
    }
    func clear() throws {
        let retained = value.filter { ["appearance", "accent", "channel"].contains($0.key) }
        try privateWrite(jsonData(retained), to: file)
        value = retained
    }
}

struct SemanticVersion: Comparable, Equatable {
    let numbers: [String]
    let prerelease: [String]
    init(_ value: String) throws {
        let s = value.hasPrefix("v") ? String(value.dropFirst()) : value
        let pattern = #"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"#
        let re = try NSRegularExpression(pattern: pattern)
        guard let match = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), match.range.length == s.utf16.count else { throw AppError("Invalid version: \(value)") }
        func part(_ index: Int) -> String { Range(match.range(at: index), in: s).map { String(s[$0]) } ?? "" }
        numbers = (1...3).map(part)
        prerelease = part(4).isEmpty ? [] : part(4).components(separatedBy: ".")
        guard !prerelease.contains(where: { Self.numeric($0) && $0.count > 1 && $0.hasPrefix("0") }) else { throw AppError("Invalid prerelease number.") }
    }
    private static func numeric(_ s: String) -> Bool { !s.isEmpty && s.utf8.allSatisfy { $0 >= 48 && $0 <= 57 } }
    private static func numberLess(_ a: String, _ b: String) -> Bool { a.count == b.count ? a < b : a.count < b.count }
    static func < (a: Self, b: Self) -> Bool {
        for (x, y) in zip(a.numbers, b.numbers) where x != y { return numberLess(x, y) }
        if a.prerelease.isEmpty != b.prerelease.isEmpty { return !a.prerelease.isEmpty }
        for i in 0..<min(a.prerelease.count, b.prerelease.count) {
            let x = a.prerelease[i], y = b.prerelease[i]
            if x == y { continue }
            if numeric(x) && numeric(y) { return numberLess(x, y) }
            if numeric(x) != numeric(y) { return numeric(x) }
            return x < y
        }
        return a.prerelease.count < b.prerelease.count
    }
}
