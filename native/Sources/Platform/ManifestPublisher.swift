import Foundation
import CryptoKit

enum ManifestPublisher {
    static func perform(_ arguments: [String]) throws {
        var options: [String: String] = [:], files: [String: Any] = [:]
        var index = 0
        while index < arguments.count {
            guard index + 1 < arguments.count else { throw AppError("Missing publisher argument.") }
            let key = arguments[index], value = arguments[index + 1]
            if key == "--file" {
                let parts = value.split(separator: "=", maxSplits: 1).map(String.init)
                guard parts.count == 2, ["arm64", "x64", "universal"].contains(parts[0]), files[parts[0]] == nil else { throw AppError("Invalid release file argument.") }
                let url = URL(fileURLWithPath: parts[1]), handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                var hash = SHA256(), size: Int64 = 0
                while let data = try handle.read(upToCount: 1024*1024), !data.isEmpty { hash.update(data: data); size += Int64(data.count) }
                files[parts[0]] = ["name": url.lastPathComponent, "size": size, "sha256": hash.finalize().map { String(format: "%02x", $0) }.joined()]
            } else { options[key] = value }
            index += 2
        }
        guard let version = options["--version"], let output = options["--out"], !files.isEmpty else { throw AppError("Publisher requires --version, --out and --file arch=path.") }
        let semantic = try SemanticVersion(version)
        guard let pem = ProcessInfo.processInfo.environment["WLSAPLUS_UPDATE_ED25519_KEY"], pem.contains("BEGIN PRIVATE KEY") else { throw AppError("WLSAPLUS_UPDATE_ED25519_KEY is missing.") }
        let encoded = pem.components(separatedBy: .newlines).filter { !$0.hasPrefix("-----") }.joined()
        guard let der = Data(base64Encoded: encoded), der.count == 48, der.prefix(16).map({ String(format: "%02x", $0) }).joined() == "302e020100300506032b657004220420" else { throw AppError("Expected an Ed25519 PKCS#8 private key.") }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: der.suffix(32))
        guard let publicDER = Data(base64Encoded: AppIdentity.publicKeyDER), key.publicKey.rawRepresentation == publicDER.suffix(32) else { throw AppError("The release key does not match installed applications.") }
        let payload: [String: Any] = ["product": AppIdentity.product, "version": version, "tag": options["--tag"] ?? "v" + version,
            "channel": semantic.prerelease.isEmpty ? "stable" : "beta", "minimumSystemVersion": "13.0", "releasedAt": ISO8601DateFormatter().string(from: Date()), "notes": options["--notes"] ?? "", "files": files]
        let bytes = try jsonData(payload)
        let envelope = try jsonData(["format": 1, "payload": String(decoding: bytes, as: UTF8.self), "signature": key.signature(for: bytes).base64EncodedString()])
        _ = try UpdateManifest.verified(envelope)
        try envelope.write(to: URL(fileURLWithPath: output), options: .atomic)
        print("Signed update manifest for WLSAPlus \(version).")
    }
}
