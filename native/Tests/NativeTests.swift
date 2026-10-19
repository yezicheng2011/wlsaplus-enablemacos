import Foundation

@main struct NativeTests {
    static var assertions = 0
    static func expect(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        assertions += 1
        if !condition() { throw AppError("FAIL: \(label)") }
    }
    static func rejects(_ label: String, _ work: () throws -> Void) throws {
        do { try work() } catch { assertions += 1; return }
        throw AppError("FAIL: accepted \(label)")
    }
    static func main() throws {
        let ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "2.0.0"]
        for pair in zip(ordered, ordered.dropFirst()) {
            let a = try SemanticVersion(pair.0), b = try SemanticVersion(pair.1)
            try expect(a < b, "semantic precedence \(pair)")
        }
        let hugeA = try SemanticVersion("999999999999999999999999.0.0"), hugeB = try SemanticVersion("1000000000000000000000000.0.0")
        try expect(hugeA < hugeB, "no integer overflow")
        for s in ["1", "1.0", "1.0.0-01", "01.0.0", "1.0.0/../x", "1.0.0\n"] { try rejects("version \(s)") { _ = try SemanticVersion(s) } }
        let subscription = try trySubscription()
        try expect(subscription.count == 2, "node import preserves both protocols")
        let nested = try SubscriptionImporter.nodes("proxies:\n  - name: a\n    type: vmess\n    server: example.test\n    port: 443\n    uuid: 11111111-1111-1111-1111-111111111111\n    ws-opts:\n      path: /websocket\n      headers:\n        Host: proxy.example.test\nrules:\n  - MATCH,a\n")
        try expect(nested.first?["wsHost"] as? String == "proxy.example.test", "block nested Host")
        for s in ["proxies:\n  - {name: x, server: x, port: 0, type: ss}", "proxies:\n  - {name: x, name: y, port: 1, server: x, type: ss}", "proxies:\n  - &x {name: x}", "proxies:\n  - {name: x, server: x, port: 1, type: ss, plugin: external}"] {
            try rejects("invalid subscription") { _ = try SubscriptionImporter.nodes(s) }
        }
        var payload: [String: Any] = ["product": AppIdentity.product, "version": "2.0.0", "tag": "v2.0.0", "channel": "stable", "files": ["arm64": ["name": "WLSAPlus-2.0.0-mac-arm64.zip", "size": 1024, "sha256": String(repeating: "a", count: 64)]]]
        func envelope() throws -> Data { try jsonData(["format": 1, "payload": String(decoding: jsonData(payload), as: UTF8.self), "signature": Data(repeating: 0, count: 64).base64EncodedString()]) }
        let valid = try envelope()
        let manifest = try UpdateManifest.parse(valid) { _, _ in true }
        try expect(manifest.file(architecture: "arm64")?.size == 1024, "legacy manifest compatibility")
        let eligible = try manifest.eligible(current: "1.1.2", beta: false, failed: [], os: "13.0")
        try expect(eligible, "old version accepts new version")
        try rejects("bad signature") { _ = try UpdateManifest.parse(valid) { _, _ in false } }
        payload["product"] = "other"
        try rejects("different product") { _ = try UpdateManifest.parse(envelope()) { _, _ in true } }
        payload["product"] = AppIdentity.product
        payload["files"] = ["arm64": ["name": "../a.zip", "size": 1, "sha256": String(repeating: "a", count: 64)]]
        try rejects("path traversal") { _ = try UpdateManifest.parse(envelope()) { _, _ in true } }
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temp) }
        let state = try LocalState(directory: temp)
        try state.settings(["appearance": "dark", "arbitrary": "ignored"])
        try state.set("todos", [["id": "1", "title": "study"]])
        let recovered = try LocalState(directory: temp)
        try expect(recovered.value["appearance"] as? String == "dark", "state durability")
        try expect(recovered.value["arbitrary"] == nil, "settings allow list")
        try rejects("invalid theme") { try recovered.settings(["appearance": "remote-script"]) }
        let fixtures = URL(fileURLWithPath: ".build/archive-fixtures", isDirectory: true)
        if FileManager.default.fileExists(atPath: fixtures.path) {
            for file in try FileManager.default.contentsOfDirectory(at: fixtures, includingPropertiesForKeys: nil) where file.pathExtension == "zip" {
                if file.lastPathComponent.hasPrefix("valid-") { try ArchivePolicy.validate(file); assertions += 1 }
                else { try rejects("unsafe ZIP \(file.lastPathComponent)") { try ArchivePolicy.validate(file) } }
            }
        }
        try LegacyStoreTests.run()
        #if NETWORK_PLAN_TESTS
        try NetworkPlan.runReadOnlyVerificationTests()
        #endif
        #if os(macOS)
        let legacy = URL(fileURLWithPath: "Tests/Fixtures/legacy-update-manifest.json")
        if FileManager.default.fileExists(atPath: legacy.path) { _ = try UpdateManifest.verified(Data(contentsOf: legacy)); assertions += 1 }
        #endif
        #if os(macOS)
        try ProtocolTests.run()
        #endif
        print("Native core: \(assertions) assertions passed")
    }
    static func trySubscription() throws -> [[String: Any]] {
        try SubscriptionImporter.nodes("proxies:\n  - {name: 'SS, one', server: proxy.example.test, port: 443, type: ss, cipher: aes-256-gcm, password: 'a:b', udp: true}\n  - {name: VMess, server: proxy.example.test, port: 80, type: vmess, uuid: 11111111-1111-1111-1111-111111111111, alterId: 1, udp: true}\nrules:\n  - MATCH,VMess\n")
    }
}
