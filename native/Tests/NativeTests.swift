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
        for s in ["1", "1.0", "1.0.0-01", "01.0.0", "1.0.0/../x", "1.0.0\n", "99.99.99.0.1", "99.99.99.01", "99.99.99.0-01"] { try rejects("version \(s)") { _ = try SemanticVersion(s) } }
        let releaseOrder = ["2.1.1", "2.2.0", "99.99.99.0", "99.99.99.1"]
        for pair in zip(releaseOrder, releaseOrder.dropFirst()) {
            let older = try SemanticVersion(pair.0), newer = try SemanticVersion(pair.1)
            try expect(older < newer, "release order \(pair)")
        }
        let three = try SemanticVersion("2.2.0"), four = try SemanticVersion("2.2.0.0"), fourthOne = try SemanticVersion("2.2.0.1")
        try expect(three == four, "missing fourth segment pads as zero")
        try expect(three < fourthOne, "fourth segment above zero pad")
        let prefixed = try SemanticVersion("v99.99.99.0"), stable = try SemanticVersion("99.99.99.0")
        let withBuild = try SemanticVersion("99.99.99.0+build")
        try expect(prefixed == stable, "v prefix on four-part version")
        try expect(withBuild == stable, "build metadata ignored")
        try expect(stable.prerelease.isEmpty, "99.99.99.0 is a stable release")
        let maintenanceBeta = try SemanticVersion("99.99.99.0-beta.1")
        try expect(maintenanceBeta < stable, "four-part prerelease stays below its stable release")
        let buildMetadata = try SemanticVersion("2.0.0+build99"), plain = try SemanticVersion("2.0.0")
        try expect(buildMetadata == plain, "three-part build metadata still ignored")
        let subscription = try trySubscription()
        try expect(subscription.count == 3, "node import preserves SS, VMess, and Trojan")
        let trojan = subscription.first { ($0["type"] as? String)?.lowercased() == "trojan" }
        try expect(trojan?["password"] as? String == "secret", "Trojan password mapped")
        try expect(trojan?["serverName"] as? String == "proxy.example.test", "Trojan sni mapped to serverName")
        try expect(trojan?["skipCertVerify"] as? Bool == true, "skip-cert-verify mapped for Clash Trojan")
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
        let maintenance: [String: Any] = ["product": AppIdentity.product, "version": "99.99.99.0", "tag": "v99.99.99.0", "channel": "stable", "files": ["arm64": ["name": "WLSAPlus-99.99.99.0-mac-arm64.zip", "size": 2048, "sha256": String(repeating: "b", count: 64)]]]
        func maintenanceEnvelope(_ body: [String: Any]) throws -> Data {
            try jsonData(["format": 1, "payload": String(decoding: jsonData(body), as: UTF8.self), "signature": Data(repeating: 1, count: 64).base64EncodedString()])
        }
        let packaged = try UpdateManifest.parse(try maintenanceEnvelope(maintenance)) { _, _ in true }
        try expect(packaged.version == "99.99.99.0", "manifest keeps four-part version")
        try expect(packaged.channel == "stable", "99.99.99.0 manifest stays format-1 stable")
        let from220 = try packaged.eligible(current: "2.2.0", beta: false, failed: [], os: "14.6.1")
        let from211 = try packaged.eligible(current: "2.1.1", beta: false, failed: [], os: "13.0")
        let same = try packaged.eligible(current: "99.99.99.0", beta: false, failed: [], os: "14.0")
        try expect(from220, "99.99.99.0 updates 2.2.0")
        try expect(from211, "99.99.99.0 updates 2.1.1")
        try expect(!same, "same four-part version is not an update")
        var nextMaintenance = maintenance
        nextMaintenance["version"] = "99.99.99.1"
        nextMaintenance["tag"] = "v99.99.99.1"
        let later = try UpdateManifest.parse(try maintenanceEnvelope(nextMaintenance)) { _, _ in true }
        let maintenanceUpgrade = try later.eligible(current: "99.99.99.0", beta: false, failed: [], os: "14.0")
        let blockedMaintenance = try later.eligible(current: "99.99.99.0", beta: false, failed: ["99.99.99.1"], os: "14.0")
        try expect(maintenanceUpgrade, "99.99.99.1 updates 99.99.99.0")
        try expect(!blockedMaintenance, "failed maintenance version is skipped")
        try expect(VerifiedUpdateHandoff.installsAndRestarts(.installAndRestart), "verified update installs and restarts")
        try expect(!VerifiedUpdateHandoff.installsAndRestarts(.refuse), "failed verification is not installed")
        let handoffSource = "Sources/Core/UpdateManifest.swift"
        if FileManager.default.fileExists(atPath: handoffSource) {
            let handoff = try String(contentsOfFile: handoffSource, encoding: .utf8)
            try expect(handoff.contains("if installsAndRestarts(decision)"), "install runs only after verification")
            try expect(handoff.contains("try await install(true)"), "verified package restarts")
        }
        let updaterSource = "Sources/Platform/Updater.swift"
        if FileManager.default.fileExists(atPath: updaterSource) {
            let text = try String(contentsOfFile: updaterSource, encoding: .utf8)
            try expect(!text.contains("restart to install"), "updater does not wait for a restart click")
            try expect(text.contains("VerifiedUpdateHandoff.apply(.installAndRestart)"), "verified package auto-installs")
            guard let verifyAt = text.range(of: "verifyApp(candidate"), let handoffAt = text.range(of: "VerifiedUpdateHandoff.apply(.installAndRestart)") else {
                throw AppError("FAIL: updater verification handoff")
            }
            try expect(verifyAt.lowerBound < handoffAt.lowerBound, "install follows app verification")
        }
        let interfaceSource = "Resources/app.js"
        if FileManager.default.fileExists(atPath: interfaceSource) {
            let interface = try String(contentsOfFile: interfaceSource, encoding: .utf8)
            try expect(!interface.contains("restart to install"), "settings does not ask for a restart click")
            try expect(!interface.contains("Install update"), "settings does not require an install click")
        }
        var ledger = FairUseLedger()
        let now: TimeInterval = 1_700_000_000
        ledger.record(bytes: 1_000, now: now)
        try expect(!ledger.isThrottled(now: now), "small transfer stays unlimited")
        try expect(ledger.pace(requested: 2_000_000, now: now) == 2_000_000, "under the limit there is no speed cap")
        ledger.record(bytes: FairUseLedger.dayBytes, now: now)
        try expect(ledger.isThrottled(now: now), "more than 50 GB in 24 hours throttles")
        try expect(ledger.pace(requested: 2_000_000, now: now) == Int(FairUseLedger.bytesPerSecond), "throttle is about 5 Mbps combined")
        try expect(ledger.pace(requested: 2_000_000, now: now) == 0, "the shared bucket waits for the next second")
        try expect(ledger.pace(requested: 2_000_000, now: now + 1) == Int(FairUseLedger.bytesPerSecond), "one second restores 5 Mbps")
        var released = FairUseLedger()
        released.record(bytes: FairUseLedger.dayBytes + 1, now: now - FairUseLedger.dayWindow - 120)
        try expect(!released.isThrottled(now: now), "falling back under 50 GB restores full speed")
        try expect(released.pace(requested: 3_000_000, now: now) == 3_000_000, "restored traffic is not capped")
        var month = FairUseLedger()
        month.record(bytes: FairUseLedger.monthBytes + 1, now: now - FairUseLedger.dayWindow - 120)
        try expect(month.isThrottled(now: now), "more than 500 GB in 30 days throttles")
        try expect(month.pace(requested: 10, now: now) <= Int(FairUseLedger.bytesPerSecond), "month throttle uses the same 5 Mbps cap")
        try expect(!month.isThrottled(now: now + FairUseLedger.monthWindow), "falling back under 500 GB clears the throttle")
        var loaded = try FairUseLedger.load(try ledger.encoded())
        let loadedDay = loaded.total(window: FairUseLedger.dayWindow, now: now)
        let liveDay = ledger.total(window: FairUseLedger.dayWindow, now: now)
        try expect(loadedDay == liveDay, "fair-use ledger reloads")
        try expect(FairUseLedger.statusLimited.contains("speed temporarily reduced"), "throttle status is not a disconnect")
        try expect(!FairUseLedger.statusLimited.lowercased().contains("disconnect"), "fair use does not disconnect")
        let burst = Int(FairUseLedger.bytesPerSecond) * 2
        try expect(burst > 512 * 1024, "fixture is larger than the old abort threshold")
        try expect(DownloadAccept.decide(buffered: 0, incoming: burst) == .pause, "a throttled burst pauses reads")
        try expect(DownloadAccept.decide(buffered: 0, incoming: 16 * 1024 * 1024 + 1) == .runaway, "only a stuck buffer is fatal")
        var download = FairUseLedger()
        download.record(bytes: FairUseLedger.dayBytes + 1, now: now)
        var chunks = [Data(count: burst)]
        var offset = 0
        var buffered = burst
        var paused = true
        func drainDownload(at time: TimeInterval) -> Int {
            var sent = 0
            while let first = chunks.first {
                let remain = first.count - offset
                let paced = download.pace(requested: min(remain, 32_768), now: time)
                if paced == 0 { break }
                offset += paced
                buffered -= paced
                sent += paced
                if offset == first.count { chunks.removeFirst(); offset = 0 }
            }
            if DownloadAccept.shouldResume(buffered: buffered) { paused = false }
            return sent
        }
        let firstSecond = drainDownload(at: now)
        try expect(DownloadAccept.decide(buffered: 0, incoming: burst) != .runaway, "fair-use backpressure does not abort the flow")
        try expect(firstSecond == Int(FairUseLedger.bytesPerSecond), "first second stays at about 5 Mbps")
        try expect(paused, "reads stay paused while the burst is still queued")
        let second = drainDownload(at: now + 1)
        try expect(firstSecond + second == burst, "the rest is delivered as the bucket refills")
        try expect(buffered == 0 && !paused, "reads resume after the queue falls under the low watermark")
        var udpLedger = FairUseLedger()
        udpLedger.record(bytes: FairUseLedger.dayBytes + 1, now: now)
        _ = udpLedger.pace(requested: Int(FairUseLedger.bytesPerSecond) - 40, now: now)
        var udpQueue = UploadScheduler()
        udpQueue.enqueue(id: 1, data: Data(repeating: 7, count: 100), udp: true)
        try expect(udpQueue.flush(ledger: &udpLedger, now: now).isEmpty, "a UDP datagram waits instead of being split")
        let udpSent = udpQueue.flush(ledger: &udpLedger, now: now + 1)
        try expect(udpSent.count == 1 && udpSent[0].bytes.count == 100, "the whole UDP datagram is sent once the budget covers it")
        var tcpLedger = FairUseLedger()
        tcpLedger.record(bytes: FairUseLedger.dayBytes + 1, now: now)
        var tcpQueue = UploadScheduler()
        let tcpLength = Int(FairUseLedger.bytesPerSecond) + 80
        tcpQueue.enqueue(id: 7, data: Data(count: tcpLength), udp: false)
        try expect(!tcpQueue.requestFin(id: 7), "TCP FIN waits until queued payload is sent")
        let tcpFirst = tcpQueue.flush(ledger: &tcpLedger, now: now)
        try expect(tcpFirst.allSatisfy { !$0.fin }, "FIN is not attached to a partial TCP write")
        try expect(tcpFirst.reduce(0) { $0 + $1.bytes.count } == Int(FairUseLedger.bytesPerSecond), "TCP still paces partial writes")
        let tcpRest = tcpQueue.flush(ledger: &tcpLedger, now: now + 1)
        try expect(tcpRest.last?.fin == true && tcpRest.last?.bytes.count == 80, "FIN follows the last TCP byte")
        var reference = FairUseLedger()
        let origin = now
        for step in 0..<3000 { reference.record(bytes: 1000, now: origin + Double(step) * 60) }
        let end = origin + 2999 * 60
        let dayCut = Int(((end - FairUseLedger.dayWindow) / 60).rounded(.down))
        var expectedDay: Int64 = 0
        for step in 0..<3000 {
            let minute = Int(((origin + Double(step) * 60) / 60).rounded(.down))
            if minute >= dayCut { expectedDay += 1000 }
        }
        let countedDay = reference.total(window: FairUseLedger.dayWindow, now: end)
        try expect(countedDay == expectedDay, "rolling totals match a full scan without walking every old bucket")
        let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("wlsaplus-fair-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try FairUseDirectory(parent: directory, subdirectory: "secure", name: "fair-use.json", requireRoot: false)
        try store.write(Data("one".utf8))
        let firstRead = try store.read()
        try expect(firstRead == Data("one".utf8), "ledger round trip uses the directory descriptor")
        let outside = directory.appendingPathComponent("outside")
        try Data("secret".utf8).write(to: outside)
        let swapped = directory.appendingPathComponent("secure").appendingPathComponent("fair-use.json")
        try FileManager.default.removeItem(at: swapped)
        _ = symlink(outside.path, swapped.path)
        try store.write(Data("new".utf8))
        let outsideBytes = try Data(contentsOf: outside)
        let replaced = try store.read()
        try expect(outsideBytes == Data("secret".utf8), "replacing the ledger does not follow a symlink")
        try expect(replaced == Data("new".utf8), "the new ledger is the replaced directory entry")
        _ = symlink("/tmp", directory.appendingPathComponent("linked").path)
        try rejects("symlink fair-use directory") { _ = try FairUseDirectory(parent: directory, subdirectory: "linked", name: "fair-use.json", requireRoot: false) }
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
        let accepted = try validateClashSubscriptionURL("https://example.test/clash.yaml")
        try expect(accepted == "https://example.test/clash.yaml", "https subscription accepted")
        for bad in ["", "http://example.test/x", "ftp://example.test/x", "https://user:pass@example.test/x", "not-a-url"] {
            try rejects("subscription \(bad.prefix(40))") { _ = try validateClashSubscriptionURL(bad) }
        }
        try rejects("subscription too long") { _ = try validateClashSubscriptionURL("https://example.test/" + String(repeating: "a", count: 2100)) }
        print("Native core: \(assertions) assertions passed")
    }
    static func trySubscription() throws -> [[String: Any]] {
        try SubscriptionImporter.nodes("proxies:\n  - {name: 'SS, one', server: proxy.example.test, port: 443, type: ss, cipher: aes-256-gcm, password: 'a:b', udp: true}\n  - {name: VMess, server: proxy.example.test, port: 80, type: vmess, uuid: 11111111-1111-1111-1111-111111111111, alterId: 1, udp: true}\n  - {name: Trojan, server: proxy.example.test, port: 443, type: trojan, password: secret, sni: proxy.example.test, skip-cert-verify: true, udp: true}\nrules:\n  - MATCH,Trojan\n")
    }
}
