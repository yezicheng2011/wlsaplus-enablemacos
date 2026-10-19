import Foundation
import Darwin

/// The web view receives only this service's public metadata and lifecycle state.
@MainActor final class VPNService {
    private let store: LocalState
    private var catalog = [ProxyNode]()
    private var measurements = [String: Int]()
    private var configuration: VPNHelperConfiguration?
    private var helperPID: Int32?
    private var monitor: Task<Void, Never>?
    private var busy = false
    private var operation = ""
    private var disconnectRequested = false
    #if NATIVE_INTEGRATION_TESTS
    private(set) var smokeHelperStage: String?
    private(set) var smokeHelperReason: String?
    private(set) var smokeHelperCounters = [String: Int]()
    private(set) var smokeNetworkValidation: String?
    private(set) var smokeNetworkSetup: String?
    private(set) var smokeNetworkFlags = [String]()
    private(set) var smokeNetworkInterfaceClass: String?
    #endif
    private let sessionURL: URL
    private(set) var status: [String: Any] = ["state": "disconnected", "connected": false, "canDisconnect": false]
    var onChange: (([String: Any]) -> Void)?

    init(store: LocalState) {
        self.store = store
        sessionURL = store.file.deletingLastPathComponent().appendingPathComponent("vpn-runtime/session.json")
        // This private file allows a restarted app to stop/recover its previous
        // helper. It is never part of the state returned to JavaScript.
        if let saved = try? VPNHelperConfiguration.readPrivate(sessionURL, privileged: false) {
            configuration = saved
            status = ["state": "recovering", "connected": false, "canDisconnect": true, "message": "Recovering the previous VPN session."]
            Task { [weak self] in
                guard let self else { return }
                do { _ = try await self.disconnect() }
                catch { self.publish(["state": "error", "connected": false, "cleanupRequired": true, "message": error.localizedDescription]) }
            }
        }
    }

    func nodes() async throws -> [String: Any] {
        let url = URL(string: "https://vpnrelay.02studio.xyz/api/subscribe?format=clash")!
        let (data, _) = try await VPNHTTPS.fetch(url, maximum: 2 * 1024 * 1024, timeout: 25)
        guard let text = String(data: data, encoding: .utf8) else { throw AppError("The VPN subscription is not UTF-8.") }
        let normalized = try SubscriptionImporter.nodes(text)
        let decoded = try JSONDecoder().decode([ProxyNode].self, from: jsonData(normalized))
        for node in decoded { try node.validate() }
        catalog = decoded
        let selected = store.value["vpnNode"] as? String
        return ["nodes": publicNodes(), "selectedNode": catalog.contains(where: { $0.id == selected }) ? selected! : (catalog.first?.id ?? "")]
    }

    func connect(nodeId: String) async throws -> [String: Any] {
        guard !busy else { throw AppError("A VPN operation is already in progress.") }
        guard configuration == nil else { throw AppError("Disconnect the current VPN session before connecting again.") }
        busy = true; operation = "connect"; disconnectRequested = false
        #if NATIVE_INTEGRATION_TESTS
        smokeHelperStage = nil
        smokeHelperReason = nil; smokeHelperCounters.removeAll()
        smokeNetworkValidation = nil
        smokeNetworkSetup = nil; smokeNetworkFlags = []; smokeNetworkInterfaceClass = nil
        #endif
        defer { busy = false; operation = "" }
        if catalog.isEmpty { _ = try await nodes() }
        if disconnectRequested { throw CancellationError() }
        guard let node = catalog.first(where: { $0.id == nodeId }) else { throw AppError("The selected VPN node is not in the subscription.") }
        try node.validate()
        guard let executable = Bundle.main.executableURL else { throw AppError("The native app executable could not be located.") }
        let parent = try VPNProcessIdentity.read(getpid())
        let token = try ProtocolCrypto.random(32).map { String(format: "%02x", $0) }.joined()
        let config = VPNHelperConfiguration(version: 1, token: token, parent: parent,
                                             createdAt: Date().timeIntervalSince1970, node: node)
        try privateWrite(JSONEncoder().encode(config), to: sessionURL)
        configuration = config
        publish(["state": "connecting", "connected": false, "nodeId": node.id, "nodeName": node.name,
                 "message": "Checking the proxy and configuring the native tunnel."])
        do {
            let path = sessionURL.path
            try await Task.detached(priority: .userInitiated) {
                try launchVPNPrivileged(executable.path, ["--vpn-helper-launch", path])
            }.value
            if disconnectRequested { throw CancellationError() }
            #if NATIVE_INTEGRATION_TESTS
            // Two hosted-runner attempts must leave time for rollback inside the
            // external watchdog deadline. Production keeps its full 90 seconds.
            let deadline = Date().addingTimeInterval(50)
            #else
            let deadline = Date().addingTimeInterval(90)
            #endif
            var lastError: Error?
            while Date() < deadline {
                if disconnectRequested { throw CancellationError() }
                let value: [String: Any]
                do {
                    value = try await control("GET", "/status", config: config)
                } catch {
                    lastError = error
                    if let pid = helperPID, !VPNProcessIdentity.exists(pid) { throw error }
                    // Root route/DNS commands share the helper's serial queue.
                    // A slow system utility can delay HTTP past its five-second
                    // request timeout while setup is still progressing normally.
                    try await Task.sleep(nanoseconds: 300_000_000)
                    continue
                }
                if let pid = value["pid"] as? NSNumber { helperPID = pid.int32Value }
                #if NATIVE_INTEGRATION_TESTS
                smokeCapture(value)
                #endif
                let state = value["state"] as? String ?? ""
                if state == "connected", value["connected"] as? Bool == true,
                   value["probeAuthenticated"] as? Bool == true, value["networkActive"] as? Bool == true {
                    if disconnectRequested { throw CancellationError() }
                    try store.set("vpnNode", node.id)
                    publish(publicStatus(value, node: node)); beginMonitoring()
                    return status
                }
                // A completed control response explicitly reporting failure is
                // fatal; only transport/control polling errors above are retried.
                if state == "error" || state == "stopped" {
                    throw AppError(value["message"] as? String ?? "The native VPN helper failed to start.")
                }
                lastError = nil
                try await Task.sleep(nanoseconds: 300_000_000)
            }
            throw lastError ?? AppError("The native VPN helper did not become ready before the deadline.")
        } catch {
            let original = error
            do { try await stopAndConfirm(config: config, executable: executable) }
            catch {
                publish(["state": "error", "connected": false, "cleanupRequired": true,
                         "message": "Connection failed and network recovery could not be confirmed: \(error.localizedDescription)"])
                throw AppError("VPN setup failed. Network recovery still needs attention: \(error.localizedDescription)")
            }
            publish(["state": "error", "connected": false, "message": original.localizedDescription])
            throw original
        }
    }

    func disconnect() async throws -> [String: Any] {
        // App quit and update must await an in-flight administrator prompt. Once
        // it returns, connect observes this flag and cleans up any spawned worker.
        if busy {
            if operation == "connect" {
                disconnectRequested = true
                publish(["state": "disconnecting", "connected": false, "message": "Waiting for the pending VPN launch to finish, then restoring the network."])
            }
            while busy { try await Task.sleep(nanoseconds: 100_000_000) }
            return try await disconnect()
        }
        busy = true; operation = "disconnect"
        defer { busy = false; operation = ""; disconnectRequested = false }
        monitor?.cancel(); monitor = nil
        guard let config = configuration else {
            if status["cleanupRequired"] as? Bool == true {
                guard let exe = Bundle.main.executableURL else { throw AppError("The app executable is unavailable.") }
                try await Task.detached { try launchVPNPrivileged(exe.path, ["--vpn-helper-recover"]) }.value
            }
            publish(["state": "disconnected", "connected": false]); return status
        }
        guard let executable = Bundle.main.executableURL else { throw AppError("The app executable is unavailable.") }
        publish(["state": "disconnecting", "connected": false, "message": "Restoring routes and DNS."])
        do {
            try await stopAndConfirm(config: config, executable: executable)
            publish(["state": "disconnected", "connected": false]); return status
        } catch {
            publish(["state": "error", "connected": false, "cleanupRequired": true, "message": error.localizedDescription])
            throw error
        }
    }

    func latency() async throws -> [String: Any] {
        if catalog.isEmpty { _ = try await nodes() }
        let snapshot = catalog
        var results = [[String: Any]]()
        // Four concurrent authenticated proxy HTTP probes keep tests bounded.
        for offset in stride(from: 0, to: snapshot.count, by: 4) {
            let batch = Array(snapshot[offset..<min(offset + 4, snapshot.count)])
            let values = await withTaskGroup(of: (String, Int?).self) { group in
                for node in batch {
                    group.addTask {
                        do { return (node.id, Int(try await VPNProxyProbe.test(node: node, timeout: 8))) }
                        catch { return (node.id, nil) }
                    }
                }
                var collected = [(String, Int?)]()
                for await item in group { collected.append(item) }
                return collected
            }
            for (id, ms) in values {
                if let ms { measurements[id] = ms; results.append(["nodeId": id, "ms": ms]) }
                else { measurements.removeValue(forKey: id); results.append(["nodeId": id, "ms": NSNull()]) }
            }
        }
        return ["results": results, "nodes": publicNodes()]
    }

    func wechat() async throws -> [String: Any] {
        let start = Date()
        do {
            let (_, response) = try await VPNHTTPS.fetch(URL(string: "https://weixin.qq.com/")!, maximum: 512 * 1024, timeout: 12)
            return ["ok": true, "reachable": true, "status": response.statusCode,
                    "latency": Int(Date().timeIntervalSince(start) * 1000), "message": "WeChat's HTTPS website is reachable."]
        } catch { return ["ok": false, "reachable": false, "message": "WeChat's HTTPS website could not be reached: \(error.localizedDescription)"] }
    }

    #if NATIVE_INTEGRATION_TESTS
    /// Test binary only. Node IDs stay inside native code and never enter logs.

    func softProbeCandidates(kind: String) -> [String] {
        switch kind {
        case "ss":
            return catalog.filter {
                ["ss", "shadowsocks"].contains($0.type.lowercased()) &&
                ($0.cipher ?? "").lowercased() == "aes-256-gcm" &&
                $0.password != nil
            }.prefix(2).map(\.id)
        case "ws":
            return catalog.filter {
                $0.type.lowercased() == "vmess" &&
                ($0.network ?? "tcp").lowercased() == "ws" &&
                UUID(uuidString: $0.uuid ?? "") != nil
            }.prefix(2).map(\.id)
        default: return []
        }
    }
    func softProbe(nodeId: String, timeout: TimeInterval) async throws -> Double {
        guard let node = catalog.first(where: { $0.id == nodeId }) else {
            throw AppError("Soft probe node is unavailable.")
        }
        var attempt = node
        if attempt.tls == true, attempt.serverName?.isEmpty != false {
            attempt.serverName = node.server
        }
        if (attempt.network ?? "tcp").lowercased() == "ws", attempt.wsHost?.isEmpty != false {
            let host = node.server.contains(":") ? "[\(node.server)]" : node.server
            attempt.wsHost = "\(host):\(node.port)"
        }
        return try await VPNProxyProbe.test(node: attempt, timeout: timeout)
    }

    func smokeCandidates() -> [String] {
        let candidates = catalog.filter {
            $0.type.lowercased() == "vmess" && ($0.alterId ?? 0) > 0 &&
            ($0.network ?? "tcp").lowercased() == "tcp" && $0.udp == true
        }
        return [candidates.first(where: { $0.tls == true })?.id,
                candidates.first(where: { $0.tls != true })?.id].compactMap { $0 }
    }
    var smokeHelperPID: Int32? { helperPID }

    /// The random DNS ID stays on the authenticated native control channel.
    func smokeBeginDNS(identifier: Data) async throws {
        guard identifier.count == 2, let config = configuration else { throw AppError("Native DNS evidence could not be initialized.") }
        let suffix = identifier.map { String(format: "%02x", $0) }.joined()
        let value = try await control("POST", "/smoke-dns/" + suffix, config: config)
        smokeCapture(value)
    }

    func smokeRefreshEvidence() async throws -> Bool {
        guard let config = configuration else { throw AppError("Native packet evidence is unavailable.") }
        let value = try await control("GET", "/smoke-evidence", config: config)
        smokeCapture(value)
        return value["dnsQueryThroughC"] as? Bool == true && value["dnsResponseThroughC"] as? Bool == true && value["dnsResponseWritten"] as? Bool == true
    }

    private func smokeCapture(_ value: [String: Any]) {
        let progress = value["failureStage"] as? String ?? value["stage"] as? String
        if let progress, ["listener", "resolve", "proxy-probe", "utun", "network-plan", "routed-https", "connected", "cleanup", "recovery"].contains(progress) { smokeHelperStage = progress }
        if let reason = value["failureReason"] as? String,
           ["setup", "physical-network", "active-plan", "routed-fetch", "proxy-health", "proxy-escape", "tun-read", "tun-write", "unclassified"].contains(reason) { smokeHelperReason = reason }
        if let validation = value["networkValidation"] as? String,
           ["transaction", "owned-bypass", "capture-ipv4", "capture-ipv6", "pinned-bypass", "dns"].contains(validation) { smokeNetworkValidation = validation }
        if let setup = value["networkSetup"] as? String {
            let plain = ["storage", "snapshot-default", "snapshot-host", "snapshot-host-classify", "snapshot-gateway", "snapshot-conflict", "snapshot-dns", "persist", "dns-set", "committed"]
            let commands = ["bypass", "capture-ipv4", "capture-ipv6"].flatMap { prefix in ["add-command", "clone-check", "clone-remove", "clone-retry", "readback"].map { prefix + "-" + $0 } }
            if (plain + commands).contains(setup) { smokeNetworkSetup = setup }
        }
        if let flags = value["networkSetupFlags"] as? [String] {
            let allowed = Set(["UP", "GATEWAY", "HOST", "DONE", "STATIC", "WASCLONED", "CLONING", "PRCLONING", "IFSCOPE", "IFREF", "PROTO1", "PROTO2", "PROTO3", "DYNAMIC", "MODIFIED", "REJECT", "BLACKHOLE", "LOCAL", "LLINFO", "ROUTER", "GLOBAL"])
            smokeNetworkFlags = flags.filter { allowed.contains($0) }.sorted()
        }
        if let name = value["networkSetupInterfaceClass"] as? String, ["physical", "tunnel", "loopback", "missing"].contains(name) { smokeNetworkInterfaceClass = name }
        if let counters = value["counters"] as? [String: Any] {
            for key in ["tun-read", "tun-handled", "tun-rejected", "tun-write", "open-tcp", "open-udp", "proxy-ready", "proxy-error", "proxy-auth-error", "to-proxy-bytes", "from-proxy-bytes", "to-proxy-tcp-bytes", "from-proxy-tcp-bytes"] {
                if let number = counters[key] as? NSNumber, (0...1_000_000_000).contains(number.intValue) { smokeHelperCounters[key] = number.intValue }
            }
        }
    }
    #endif

    private func publicNodes() -> [[String: Any]] {
        catalog.map { node in
            var item: [String: Any] = ["id": node.id, "name": node.name, "type": node.type, "server": node.server, "port": Int(node.port)]
            if let ms = measurements[node.id] { item["latency"] = ms }
            return item
        }
    }
    private func publish(_ next: [String: Any]) {
        var value = next
        value["canDisconnect"] = configuration != nil || next["cleanupRequired"] as? Bool == true
        status = value; onChange?(value)
    }
    private func publicStatus(_ helper: [String: Any], node: ProxyNode) -> [String: Any] {
        var value: [String: Any] = ["state": "connected", "connected": true, "nodeId": node.id, "nodeName": node.name,
                                  "connectedAt": helper["connectedAt"] ?? ISO8601DateFormatter().string(from: Date())]
        for key in ["interface", "latency"] { if let item = helper[key] { value[key] = item } }
        return value
    }
    private func control(_ method: String, _ path: String, config: VPNHelperConfiguration) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:19098\(path)")!)
        request.httpMethod = method; request.timeoutInterval = 5
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        let settings = URLSessionConfiguration.ephemeral
        settings.connectionProxyDictionary = [:]; settings.timeoutIntervalForRequest = 5
        let session = URLSession(configuration: settings); defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard data.count <= 16_384, let http = response as? HTTPURLResponse else { throw AppError("Invalid native VPN control response.") }
        let value = try jsonObject(data, maximum: 16_384)
        guard http.statusCode == 200 else { throw AppError(value["message"] as? String ?? "The native VPN helper rejected the request.") }
        return value
    }
    private func stopAndConfirm(config: VPNHelperConfiguration, executable: URL) async throws {
        var stopped = false
        do {
            let value = try await control("POST", "/stop", config: config)
            if let pid = value["pid"] as? NSNumber { helperPID = pid.int32Value }
            stopped = value["state"] as? String == "stopped" && value["networkActive"] as? Bool == false
            guard stopped else { throw AppError(value["message"] as? String ?? "Network restoration was not confirmed.") }
        } catch {
            if let pid = helperPID, VPNProcessIdentity.exists(pid) { throw error }
            // A crash may have interrupted the rollback. Recover under root using
            // the fixed journal before allowing an update or another connection.
            try await Task.detached { try launchVPNPrivileged(executable.path, ["--vpn-helper-recover"]) }.value
            stopped = true
        }
        if let pid = helperPID {
            let deadline = Date().addingTimeInterval(8)
            while VPNProcessIdentity.exists(pid), Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
            guard !VPNProcessIdentity.exists(pid) else { throw AppError("Routes were restored, but the native helper has not exited.") }
        }
        guard stopped else { throw AppError("Network restoration could not be confirmed.") }
        configuration = nil; helperPID = nil
        if FileManager.default.fileExists(atPath: sessionURL.path) { try FileManager.default.removeItem(at: sessionURL) }
    }
    private func beginMonitoring() {
        monitor?.cancel()
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let self, let config = self.configuration else { return }
                do {
                    let value = try await self.control("GET", "/status", config: config)
                    #if NATIVE_INTEGRATION_TESTS
                    self.smokeCapture(value)
                    #endif
                    if value["state"] as? String != "connected" || value["connected"] as? Bool != true {
                        self.publish(["state": "error", "connected": false, "cleanupRequired": value["networkActive"] as? Bool ?? true,
                                      "message": value["message"] as? String ?? "The native VPN connection stopped."])
                        return
                    }
                } catch {
                    self.publish(["state": "error", "connected": false, "cleanupRequired": true,
                                  "message": "The native VPN helper is no longer responding. Disconnect to recover network settings."])
                    return
                }
            }
        }
    }
}

private func launchVPNPrivileged(_ executable: String, _ arguments: [String]) throws {
    #if NATIVE_INTEGRATION_TESTS
    // Hosted test runners already authorize sudo. -n fails if that right is
    // absent; it never changes system authorization or prompts interactively.
    _ = try run("/usr/bin/sudo", ["-n", executable] + arguments)
    #else
    try elevatedCommand(executable, arguments)
    #endif
}

private final class HTTPSRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url?.scheme?.lowercased() == "https" ? request : nil)
    }
}

enum VPNHTTPS {
    static func fetch(_ url: URL, maximum: Int, timeout: TimeInterval) async throws -> (Data, HTTPURLResponse) {
        guard url.scheme == "https" else { throw AppError("VPN downloads require HTTPS.") }
        let options = URLSessionConfiguration.ephemeral
        options.connectionProxyDictionary = [:]; options.timeoutIntervalForRequest = timeout
        options.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: options, delegate: HTTPSRedirectPolicy(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.timeoutInterval = timeout
        request.setValue("WLSAPlus-Native/2", forHTTPHeaderField: "User-Agent")
        let (bytes, raw) = try await session.bytes(for: request)
        guard let response = raw as? HTTPURLResponse, (200...299).contains(response.statusCode),
              response.url?.scheme == "https", response.expectedContentLength <= maximum else { throw AppError("The HTTPS endpoint returned an invalid response.") }
        var data = Data(); data.reserveCapacity(min(maximum, 65_536))
        for try await byte in bytes {
            guard data.count < maximum else { throw AppError("The HTTPS response exceeded its size limit.") }
            data.append(byte)
        }
        return (data, response)
    }
}
