#if NATIVE_INTEGRATION_TESTS
import Foundation
import Network
import Dispatch
import Darwin

private func smokeSystemCommand(_ executable: String, _ arguments: [String]) throws -> String {
    try run(executable, arguments)
}

private func smokeReadOnlyResult(_ executable: String, _ arguments: [String]) throws -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardInput = FileHandle(forReadingAtPath: "/dev/null")
    process.standardOutput = pipe; process.standardError = pipe
    try process.run()
    let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard bytes.count <= 65_536 else { throw AppError("Native smoke snapshot output exceeded its bound.") }
    return (process.terminationStatus, String(decoding: bytes, as: UTF8.self))
}

/// Compiled only into the explicit native integration test executable.
/// Logs contain stages and protocol/result classes, never subscription material.
@MainActor enum NativeSmoke {
    private enum Failure: LocalizedError {
        case blocked(String), assertion(String), recovery
        var errorDescription: String? {
            switch self {
            case .blocked(let stage): return "Native smoke runtime blocker at \(stage)."
            case .assertion(let stage): return "Native smoke assertion failed at \(stage)."
            case .recovery: return "Native smoke recovery could not be confirmed; retain the private runtime configuration and root recovery journal."
            }
        }
    }

    static func run() async throws {
        stage("privileges")
        guard geteuid() != 0 else { throw Failure.blocked("unprivileged parent required") }
        do { _ = try await Task.detached { try smokeSystemCommand("/usr/bin/sudo", ["-n", "/usr/bin/true"]) }.value }
        catch { throw Failure.blocked("preauthorized sudo") }
        try VPNHelper.runReadOnlyDefaultRouteTests()
        stage("exact-default parser pass")

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("wlsaplus-native-smoke-\(UUID().uuidString)", isDirectory: true)
        try secureDirectory(directory)
        var cleanupConfirmed = false
        defer {
            // A failed rollback retains the private config for manual recovery.
            if cleanupConfirmed { try? FileManager.default.removeItem(at: directory) }
        }

        stage("snapshot")
        let original: NetworkSnapshot
        do { original = try NetworkSnapshot.capture() }
        catch let error as Failure { cleanupConfirmed = true; throw error }
        catch { cleanupConfirmed = true; throw Failure.blocked("route and DNS snapshot") }
        let service: VPNService
        do { service = VPNService(store: try LocalState(directory: directory)) }
        catch { cleanupConfirmed = true; throw Failure.blocked("private runtime state") }

        var outcome: Result<Void, Error>
        do {
            stage("subscription")
            _ = try await service.nodes()
            let candidates = service.smokeCandidates()
            guard !candidates.isEmpty else { throw Failure.blocked("legacy VMess TCP/TLS candidates") }
            var passed = false
            var reachedReady = false
            for id in candidates.prefix(2) {
                stage("connect VMess TCP/TLS")
                var failureStage = "connect"
                var attemptPassed = false
                var pid: Int32?
                do {
                    let value = try await service.connect(nodeId: id)
                    guard value["state"] as? String == "connected", value["connected"] as? Bool == true,
                          let name = value["interface"] as? String, name.hasPrefix("utun"),
                          let helper = service.smokeHelperPID else { throw Failure.assertion("readiness contract") }
                    pid = helper; reachedReady = true
                    stage("native readiness pass")
                    failureStage = "tunnel route selection"
                    try assertTunnelRoute(interface: name)
                    failureStage = "routed HTTPS"
                    stage("routed HTTPS")
                    let (_, response) = try await VPNHTTPS.fetch(URL(string: "https://www.gstatic.com/generate_204")!, maximum: 4096, timeout: 12)
                    guard response.statusCode == 204 else { throw Failure.assertion("routed HTTPS status") }
                    failureStage = "routed UDP DNS"
                    stage("routed UDP DNS")
                    try await SmokeDNSProbe.test()
                    attemptPassed = true
                } catch {
                    // Foreign errors may contain endpoints or private runtime
                    // paths. Only this fixed stage class reaches CI logs.
                    stage("\(failureStage) failed")
                    if let helperStage = service.smokeHelperStage { stage("helper-stage \(helperStage)") }
                    if let reason = service.smokeHelperReason { stage("helper-reason \(reason)") }
                    let counters = service.smokeHelperCounters
                    if !counters.isEmpty { stage("helper-counters \(counters.keys.sorted().map { "\($0):\(counters[$0]!)" }.joined(separator: ","))") }
                }

                stage("restore")
                do {
                    try await cleanup(service)
                    if let pid, VPNProcessIdentity.exists(pid) { throw Failure.assertion("helper exit") }
                    try original.assertRestored()
                } catch { throw Failure.recovery }
                stage("routes DNS helper-exit pass")
                if attemptPassed { passed = true; break }
            }
            guard passed else {
                if reachedReady { throw Failure.assertion("routed egress") }
                throw Failure.blocked("live VMess endpoint readiness")
            }
            outcome = .success(())
        } catch let error as Failure { outcome = .failure(error) }
        catch { outcome = .failure(Failure.blocked("subscription or live network")) }

        // A separate unstructured task does not inherit cancellation. Every
        // success/failure path awaits production rollback and helper exit before
        // inspecting the original network snapshot or releasing private state.
        do {
            try await cleanup(service)
            try original.assertRestored()
            cleanupConfirmed = true
        } catch {
            stage("recovery failed")
            throw Failure.recovery
        }
        switch outcome {
        case .success:
            stage("pass VMess native utun TCP UDP DNS rollback")
        case .failure(let error): throw error
        }
    }

    private static func cleanup(_ service: VPNService) async throws {
        let task = Task { @MainActor in _ = try await service.disconnect() }
        try await task.value
        guard service.status["state"] as? String == "disconnected", service.status["connected"] as? Bool == false else {
            throw Failure.assertion("disconnected state")
        }
    }
    private nonisolated static func stage(_ value: String) {
        print("native-smoke: \(value)")
        fflush(stdout)
    }

    private static func assertTunnelRoute(interface: String) throws {
        let output = try smokeSystemCommand("/sbin/route", ["-n", "get", "-inet", "1.1.1.1"])
        let matched = output.components(separatedBy: .newlines).contains { line in
            guard let colon = line.firstIndex(of: ":"),
                  line[..<colon].trimmingCharacters(in: .whitespaces) == "interface" else { return false }
            return line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces) == interface
        }
        guard matched else { throw Failure.assertion("UDP destination routed through utun") }
    }

    private struct NetworkSnapshot: Equatable {
        let routes: [String: [String: String]]
        let dns: [String: String]

        static func capture() throws -> NetworkSnapshot {
            var routes = [String: [String: String]]()
            for (family, target, label) in [("-inet", "default", "ipv4-default"), ("-inet6", "default", "ipv6-default"),
                                           ("-inet", "0.0.0.0/1", "ipv4-low-split"), ("-inet", "128.0.0.0/1", "ipv4-high-split"),
                                           ("-inet6", "::/1", "ipv6-low-split"), ("-inet6", "8000::/1", "ipv6-high-split")] {
                let key = family + " " + target
                let result: (status: Int32, output: String)
                do { result = try smokeReadOnlyResult("/sbin/route", ["-n", "get", family, target]) }
                catch { throw Failure.blocked("route snapshot command launch") }
                if NetworkPlan.isMissingRouteDiagnostic(result.output) {
                    stage("snapshot-route \(label) exit-\(result.status) missing")
                    continue
                }
                if result.status == 0 {
                    var identity = [String: String]()
                    // Exclude mutable counters/timers; preserve the complete
                    // route identity and ownership flags rather than table text.
                    for line in result.output.components(separatedBy: .newlines) {
                        guard let colon = line.firstIndex(of: ":") else { continue }
                        let name = line[..<colon].trimmingCharacters(in: .whitespaces)
                        if ["destination", "mask", "netmask", "gateway", "interface", "flags"].contains(name) {
                            identity[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                        }
                    }
                    stage("snapshot-route \(label) exit-0 fields-\(identity.keys.sorted().joined(separator: ","))")
                    guard identity["interface"]?.isEmpty == false else { throw Failure.blocked("route snapshot interface field") }
                    if label.hasSuffix("-split"), !NetworkPlan.isExactSplitSnapshot(identity, family: family == "-inet" ? 4 : 6, upper: label.contains("high")) {
                        // Longest-prefix GET can return the physical default
                        // when this /1 entry does not exist. Cache behavior may
                        // change after deleting a route; only exact entries count.
                        stage("snapshot-route \(label) fallback")
                        continue
                    }
                    routes[key] = identity
                } else {
                    let text = result.output.lowercased()
                    let category = text.contains("usage:") ? "usage" : "failure"
                    stage("snapshot-route \(label) exit-\(result.status) \(category)")
                }
            }
            if let name = routes["-inet default"]?["interface"] {
                stage("snapshot-default-interface \(name.hasPrefix("utun") ? "utun" : "physical")")
            }
            guard let original4 = routes["-inet default"],
                  let interface = original4["interface"], !interface.hasPrefix("utun") else {
                throw Failure.blocked("physical IPv4 default route")
            }
            let list: (status: Int32, output: String)
            do { list = try smokeReadOnlyResult("/usr/sbin/networksetup", ["-listallnetworkservices"]) }
            catch { throw Failure.blocked("DNS service list launch") }
            stage("snapshot-service-list exit-\(list.status)")
            guard list.status == 0 else { throw Failure.blocked("DNS service list command") }
            let lines = list.output.components(separatedBy: .newlines).dropFirst()
            let disabled = lines.filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("*") }.count
            let services = lines.compactMap { line -> String? in
                let name = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if name.isEmpty { return nil }
                return name.hasPrefix("*") ? String(name.dropFirst()) : name
            }
            stage("snapshot-services total-\(services.count) disabled-\(disabled)")
            guard !services.isEmpty else { throw Failure.blocked("network services") }
            var dns = [String: String]()
            for service in services {
                let result: (status: Int32, output: String)
                do { result = try smokeReadOnlyResult("/usr/sbin/networksetup", ["-getdnsservers", service]) }
                catch { throw Failure.blocked("DNS snapshot command launch") }
                let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
                let automatic = output.hasPrefix("There aren't any DNS Servers set on ")
                stage("snapshot-dns exit-\(result.status) \(automatic ? "automatic" : "configured-or-error")")
                guard result.status == 0 else { throw Failure.blocked("DNS snapshot command") }
                dns[service] = output
            }
            return NetworkSnapshot(routes: routes, dns: dns)
        }

        func assertRestored() throws {
            let current = try Self.capture()
            if current.routes != routes {
                for (key, label) in [("-inet default", "ipv4-default"), ("-inet6 default", "ipv6-default"),
                                     ("-inet 0.0.0.0/1", "ipv4-low-split"), ("-inet 128.0.0.0/1", "ipv4-high-split"),
                                     ("-inet6 ::/1", "ipv6-low-split"), ("-inet6 8000::/1", "ipv6-high-split")] where current.routes[key] != routes[key] {
                    let keys = Set((routes[key] ?? [:]).keys).union((current.routes[key] ?? [:]).keys)
                    let changed = keys.filter { routes[key]?[$0] != current.routes[key]?[$0] }.sorted()
                    stage("restore-diff \(label) fields-\(changed.joined(separator: ","))")
                }
            }
            if current.dns != dns {
                let keys = Set(dns.keys).union(current.dns.keys)
                stage("restore-diff DNS changed-services-\(keys.filter { dns[$0] != current.dns[$0] }.count)")
            }
            guard current == self else { throw Failure.assertion("exact route and DNS restoration") }
        }
    }
}

/// Explicit UDP through the production split routes avoids a DNS cache turning
/// the HTTPS check into a false positive for DNS/UDP support.
private final class SmokeDNSProbe {
    private let queue = DispatchQueue(label: "cn.org.wlsash.wlsaplus.native-smoke-dns")
    private let connection: NWConnection
    private let query: Data
    private let identifier: Data
    private let completion: (Result<Void, Error>) -> Void
    private var timer: DispatchWorkItem?
    private var done = false
    private var hold: SmokeDNSProbe?

    static func test() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                let probe = try SmokeDNSProbe { continuation.resume(with: $0) }
                probe.start()
            } catch { continuation.resume(throwing: AppError("Native UDP DNS probe initialization failed.")) }
        }
    }
    private init(completion: @escaping (Result<Void, Error>) -> Void) throws {
        self.completion = completion
        identifier = try ProtocolCrypto.random(2)
        var packet = identifier + Data([1, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        for label in ["www", "gstatic", "com"] {
            packet.append(UInt8(label.utf8.count)); packet.append(Data(label.utf8))
        }
        packet.append(contentsOf: [0, 0, 1, 0, 1])
        query = packet
        connection = NWConnection(host: "1.1.1.1", port: 53, using: .udp)
    }
    private func start() {
        hold = self
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, !self.done else { return }
            switch state {
            case .ready:
                self.connection.send(content: self.query, completion: .contentProcessed { [weak self] error in
                    if error != nil { self?.finish(.failure(AppError("Native UDP DNS send failed."))) }
                })
                self.receive()
            case .failed: self.finish(.failure(AppError("Native UDP DNS connection failed.")))
            default: break
            }
        }
        connection.start(queue: queue)
        let timeout = DispatchWorkItem { [weak self] in self?.finish(.failure(AppError("Native UDP DNS response timed out."))) }
        timer = timeout; queue.asyncAfter(deadline: .now() + 8, execute: timeout)
    }
    private func receive() {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self, !self.done else { return }
            guard error == nil, let data, data.count >= 12, data.count <= 65_507 else {
                self.finish(.failure(AppError("Native UDP DNS response was missing."))); return
            }
            let header = [UInt8](data.prefix(12))
            guard Data(data.prefix(2)) == self.identifier, header[2] & 0x80 != 0,
                  header[2] & 0x02 == 0, header[3] & 0x0f == 0,
                  header[4] == 0, header[5] == 1, header[6] != 0 || header[7] != 0 else {
                self.finish(.failure(AppError("Native UDP DNS response was invalid."))); return
            }
            self.finish(.success(()))
        }
    }
    private func finish(_ result: Result<Void, Error>) {
        guard !done else { return }; done = true
        timer?.cancel(); timer = nil
        connection.stateUpdateHandler = nil; connection.cancel()
        completion(result); hold = nil
    }
}
#endif
