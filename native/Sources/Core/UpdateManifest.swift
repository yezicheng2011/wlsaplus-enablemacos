import Foundation
import CoreFoundation
#if canImport(CryptoKit)
import CryptoKit
#endif

struct UpdateFile {
    let name: String
    let size: Int64
    let sha256: String
}

struct UpdateManifest {
    let version: String
    let tag: String
    let channel: String
    let minimumSystemVersion: String
    let notes: String
    let files: [String: UpdateFile]

    static func parse(_ data: Data, verify: (Data, Data) throws -> Bool) throws -> Self {
        let envelope = try jsonObject(data, maximum: 65536)
        guard (envelope["format"] as? Int) == 1,
              let payload = envelope["payload"] as? String,
              let signatureText = envelope["signature"] as? String,
              let signature = Data(base64Encoded: signatureText), signature.count == 64,
              try verify(Data(payload.utf8), signature) else { throw AppError("The update manifest signature is invalid.") }
        let value = try jsonObject(Data(payload.utf8), maximum: 65536)
        guard value["product"] as? String == AppIdentity.product,
              let version = value["version"] as? String,
              let tag = value["tag"] as? String,
              matches(tag, #"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$"#),
              let rawFiles = value["files"] as? [String: Any] else { throw AppError("Invalid update manifest fields.") }
        _ = try SemanticVersion(version)
        let minimum = value["minimumSystemVersion"] as? String ?? "13.0"
        guard matches(minimum, #"^[0-9]+(?:\.[0-9]+){0,2}$"#), minimum.split(separator: ".").allSatisfy({ Int($0) != nil }) else { throw AppError("Invalid minimum macOS version.") }
        var files: [String: UpdateFile] = [:]
        for arch in ["arm64", "x64", "universal"] {
            guard let item = rawFiles[arch] else { continue }
            guard let f = item as? [String: Any],
                  let name = f["name"] as? String,
                  matches(name, #"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}\.zip$"#),
                  let number = f["size"] as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue == Double(number.int64Value), number.int64Value > 0, number.int64Value <= 2147483648,
                  let hash = f["sha256"] as? String, matches(hash, #"^[0-9a-f]{64}$"#) else { throw AppError("Invalid update file for \(arch).") }
            files[arch] = UpdateFile(name: name, size: number.int64Value, sha256: hash)
        }
        guard !files.isEmpty else { throw AppError("The update has no compatible package.") }
        return Self(version: version.hasPrefix("v") ? String(version.dropFirst()) : version, tag: tag,
                    channel: value["channel"] as? String == "beta" ? "beta" : "stable",
                    minimumSystemVersion: minimum, notes: String((value["notes"] as? String ?? "").prefix(2000)), files: files)
    }

    static func verified(_ data: Data) throws -> Self {
        #if canImport(CryptoKit)
        guard let der = Data(base64Encoded: AppIdentity.publicKeyDER), der.count == 44 else { throw AppError("Missing update trust key.") }
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32))
        return try parse(data) { payload, signature in key.isValidSignature(signature, for: payload) }
        #else
        throw AppError("Update verification requires the macOS CryptoKit runtime.")
        #endif
    }

    func file(architecture: String) -> UpdateFile? { files[architecture] ?? files["universal"] }
    func eligible(current: String, beta: Bool, failed: [String], os: String) throws -> Bool {
        let version = try SemanticVersion(self.version)
        let systemParts = os.split(separator: ".").compactMap { Int($0) }
        let minimumParts = minimumSystemVersion.split(separator: ".").compactMap { Int($0) }
        for index in 0..<max(systemParts.count, minimumParts.count) {
            let a = index < systemParts.count ? systemParts[index] : 0, b = index < minimumParts.count ? minimumParts[index] : 0
            if a < b { return false }
            if a > b { break }
        }
        return version > (try SemanticVersion(current)) && (beta || (version.prerelease.isEmpty && channel == "stable")) && !failed.contains(self.version)
    }
}

func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression).map { $0 == value.startIndex..<value.endIndex } ?? false
}
