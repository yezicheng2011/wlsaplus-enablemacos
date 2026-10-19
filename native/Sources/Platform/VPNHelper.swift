import Foundation
import Dispatch
import Network
import Darwin

struct VPNProcessIdentity: Codable, Equatable {
    let pid: Int32
    let uid: UInt32
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64
    let executable: String

    static func read(_ pid: Int32) throws -> VPNProcessIdentity {
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.size
        guard proc_pidinfo(pid, Int32(PROC_PIDTBSDINFO), 0, &info, Int32(size)) == Int32(size), info.pbi_status != 5 else {
            throw AppError("The app process identity could not be verified.")
        }
        var path = [CChar](repeating: 0, count: Int(PROC_PIDPATHINFO_MAXSIZE))
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { throw AppError("The app executable identity could not be verified.") }
        return VPNProcessIdentity(pid: pid, uid: info.pbi_ruid, startedSeconds: info.pbi_start_tvsec,
                                  startedMicroseconds: info.pbi_start_tvusec, executable: String(cString: path))
    }
    static func exists(_ pid: Int32) -> Bool {
        guard pid > 1 else { return false }
        if let value = try? read(pid) { return value.pid == pid }
        return kill(pid, 0) == 0 || errno == EPERM
    }
    func matchesRunningProcess() -> Bool { (try? Self.read(pid)) == self }
}

struct VPNHelperConfiguration: Codable {
    let version: Int
    let token: String
    let parent: VPNProcessIdentity
    let createdAt: TimeInterval
    let node: ProxyNode

    static func readPrivate(_ url: URL, privileged: Bool) throws -> VPNHelperConfiguration {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw AppError("The private VPN configuration could not be opened.") }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              (info.st_mode & 0o777) == 0o600, info.st_nlink == 1,
              info.st_size > 0, info.st_size <= 65_536 else { throw AppError("The VPN configuration is not a private regular file.") }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count == 0 { break }
            if count < 0 { if errno == EINTR { continue }; throw AppError("Reading the VPN configuration failed.") }
            guard data.count + count <= 65_536 else { throw AppError("The VPN configuration is too large.") }
            data.append(contentsOf: buffer.prefix(count))
        }
        let value = try JSONDecoder().decode(VPNHelperConfiguration.self, from: data)
        guard value.version == 1, value.token.utf8.count == 64,
              value.token.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }),
              value.parent.pid > 1, value.parent.uid == info.st_uid,
              value.parent.uid != 0, !value.parent.executable.isEmpty else { throw AppError("Invalid VPN helper configuration.") }
        if privileged {
            guard geteuid() == 0, value.parent.matchesRunningProcess(),
                  abs(Date().timeIntervalSince1970 - value.createdAt) < 300,
                  try VPNProcessIdentity.read(getpid()).executable == value.parent.executable else {
                throw AppError("The VPN helper's caller could not be authenticated.")
            }
        } else {
            guard info.st_uid == getuid() else { throw AppError("The VPN configuration has a different owner.") }
        }
        try value.node.validate()
        return value
    }
}

enum VPNHelper {
    static let journal = URL(fileURLWithPath: "/private/var/db/wlsaplus-native/journal.json")
    private static var active: VPNRuntime?

    /// Elevated short-lived launcher: native argv only, no background shell.
    static func launch(configURL: URL) throws {
        _ = try VPNHelperConfiguration.readPrivate(configURL, privileged: true)
        guard let executable = Bundle.main.executableURL else { throw AppError("Missing helper executable.") }
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--vpn-helper", configURL.path]
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": "/var/tmp"]
        let null = FileHandle(forUpdatingAtPath: "/dev/null")!
        process.standardInput = null; process.standardOutput = null; process.standardError = null
        try process.run()
        // Process.run verifies a successful posix_spawn. Readiness is separately
        // authenticated by the GUI over the per-start bearer control channel.
    }

    static func recover() throws {
        guard geteuid() == 0 else { throw AppError("Network recovery requires administrator privileges.") }
        try NetworkPlan.recover(journal: journal)
    }

    static func run(configURL: URL) throws {
        let config = try VPNHelperConfiguration.readPrivate(configURL, privileged: true)
        let runtime = try VPNRuntime(configuration: config)
        active = runtime
        runtime.start()
        dispatchMain()
    }
}

/// Authenticated protocol egress test. A TCP connect alone never passes this test.
enum VPNProxyProbe {
    static func test(node: ProxyNode, timeout: TimeInterval = 12) async throws -> Double {
        try await withCheckedThrowingContinuation { continuation in
            let probe = HTTPProxyProbe(node: node, timeout: timeout) { continuation.resume(with: $0) }
            probe.start()
        }
    }
}

private final class HTTPProxyProbe {
    private let queue = DispatchQueue(label: "cn.org.wlsash.wlsaplus.proxy-probe")
    private let node: ProxyNode
    private let limit: TimeInterval
    private let completion: (Result<Double, Error>) -> Void
    private var connection: ProxyConnection?
    private var timer: DispatchWorkItem?
    private var buffer = Data()
    private var began = DispatchTime.now()
    private var done = false
    private var hold: HTTPProxyProbe?

    init(node: ProxyNode, timeout: TimeInterval, completion: @escaping (Result<Double, Error>) -> Void) {
        self.node = node; limit = timeout; self.completion = completion
    }
    func start() {
        hold = self
        queue.async {
            self.began = .now()
            let stream = ProxyConnection(node: self.node, destinationHost: "www.gstatic.com", destinationPort: 80, udp: false, queue: self.queue)
            self.connection = stream
            stream.onReady = { [weak self] in
                self?.connection?.send(Data("GET /generate_204 HTTP/1.1\r\nHost: www.gstatic.com\r\nConnection: close\r\n\r\n".utf8))
            }
            stream.onData = { [weak self] in self?.receive($0) }
            stream.onError = { [weak self] in self?.finish(.failure($0)) }
            stream.onClose = { [weak self] in self?.finish(.failure(AppError("The proxy closed before a valid HTTP egress response."))) }
            let timer = DispatchWorkItem { [weak self] in self?.finish(.failure(ProxyError.timeout)) }
            self.timer = timer; self.queue.asyncAfter(deadline: .now() + self.limit, execute: timer)
            stream.start()
        }
    }
    private func receive(_ data: Data) {
        guard !done else { return }
        guard buffer.count + data.count <= 32_768 else { finish(.failure(ProxyError.bufferLimit)); return }
        buffer.append(data)
        guard let boundary = buffer.range(of: Data([13, 10, 13, 10])) else { return }
        let header = String(decoding: buffer[..<boundary.lowerBound], as: UTF8.self)
        let status = header.components(separatedBy: "\r\n").first?.split(separator: " ") ?? []
        guard status.count >= 2, status[0].hasPrefix("HTTP/1."), status[1] == "204" else {
            finish(.failure(AppError("The proxy did not return the expected HTTP egress response."))); return
        }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - began.uptimeNanoseconds) / 1_000_000
        finish(.success(ms))
    }
    private func finish(_ result: Result<Double, Error>) {
        guard !done else { return }; done = true
        timer?.cancel(); timer = nil
        connection?.onReady = nil; connection?.onData = nil; connection?.onError = nil; connection?.onClose = nil
        connection?.close(); connection = nil
        completion(result); hold = nil
    }
}

private final class VPNFlow {
    let connection: ProxyConnection
    let udp: Bool
    var pending = [Data]()
    var offset = 0
    var bytes = 0
    var remoteEOF = false
    var paused = false
    init(connection: ProxyConnection, udp: Bool) { self.connection = connection; self.udp = udp }
}

private final class VPNRuntime {
    let queue = DispatchQueue(label: "cn.org.wlsash.wlsaplus.vpn-helper")
    private let configuration: VPNHelperConfiguration
    private var node: ProxyNode
    private let listener: NWListener
    private var controls = [UUID: VPNControlConnection]()
    private var engine: OpaquePointer?
    private var descriptor: Int32 = -1
    private var interface = ""
    private var plan: NetworkPlan?
    private var readSource: DispatchSourceRead?
    private var writeSource: DispatchSourceWrite?
    private var timer: DispatchSourceTimer?
    private var signals = [DispatchSourceSignal]()
    private var flows = [UInt64: VPNFlow]()
    private var packets = [Data]()
    private var packetBytes = 0
    private var state = "starting"
    private var message = "Checking the VPN server."
    private var networkActive = false
    private var probeAuthenticated = false
    private var stopped = false
    private var stopping = false
    private var startedSetup = false
    private var connectedAt = ""
    private var latency: Int?
    private var healthFailures = 0
    private var tickNumber: UInt64 = 0
    private var healthRunning = false
    private var originalDefault = ""

    init(configuration: VPNHelperConfiguration) throws {
        self.configuration = configuration; node = configuration.node
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 19098)
        parameters.allowLocalEndpointReuse = false
        listener = try NWListener(using: parameters)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, self.controls.count < 32 else { connection.cancel(); return }
            let identifier = UUID()
            let control = VPNControlConnection(connection: connection, queue: self.queue, token: self.configuration.token,
                                                request: { [weak self] method, path, complete in self?.request(method, path, complete: complete) },
                                                closed: { [weak self] in self?.controls.removeValue(forKey: identifier) })
            self.controls[identifier] = control; control.start()
        }
        listener.stateUpdateHandler = { [weak self] value in
            guard let self else { return }
            switch value {
            case .ready:
                guard !self.startedSetup else { return }; self.startedSetup = true
                self.startWatchers(); self.setup()
            case .failed(let error): self.failAndRecover(error)
            default: break
            }
        }
        listener.start(queue: queue)
    }

    private func setup() {
        state = "connecting"
        Task {
            do {
                let addresses = try Self.resolve(configuration.node.server, port: configuration.node.port)
                var successful: (ProxyNode, Double)?
                for address in addresses.prefix(4) {
                    var attempt = configuration.node
                    attempt.server = address
                    if attempt.tls == true, attempt.serverName?.isEmpty != false { attempt.serverName = configuration.node.server }
                    if (attempt.network ?? "tcp").lowercased() == "ws", attempt.wsHost?.isEmpty != false {
                        let host = configuration.node.server.contains(":") ? "[\(configuration.node.server)]" : configuration.node.server
                        attempt.wsHost = "\(host):\(configuration.node.port)"
                    }
                    do { successful = (attempt, try await VPNProxyProbe.test(node: attempt, timeout: 10)); break }
                    catch { continue }
                }
                guard let successful else { throw AppError("No resolved VPN endpoint passed the authenticated HTTP proxy probe.") }
                queue.async {
                    guard !self.stopping, !self.stopped else { return }
                    do {
                        self.node = successful.0; self.latency = Int(successful.1); self.probeAuthenticated = true
                        self.originalDefault = try Self.defaultFingerprint()
                        try self.configureTunnel(addresses: [successful.0.server])
                        self.verifyTunnel()
                    } catch { self.failAndRecover(error) }
                }
            } catch { queue.async { self.failAndRecover(error) } }
        }
    }

    private func configureTunnel(addresses: [String]) throws {
        var name = [CChar](repeating: 0, count: 64)
        descriptor = wl_tun_open(&name, name.count)
        guard descriptor >= 0 else { throw AppError("macOS could not create a native utun interface.") }
        interface = String(cString: name)
        _ = try run("/sbin/ifconfig", [interface, "inet", "198.18.0.1", "198.18.0.1", "netmask", "255.255.255.255", "mtu", "1280", "up"])
        _ = try run("/sbin/ifconfig", [interface, "inet6", "fd00:7777::1", "prefixlen", "128", "alias"])
        let callbacks = wlp_callbacks(connect: { context, flow, host, port, udp in
            guard let context, let host else { return }
            let runtime = Unmanaged<VPNRuntime>.fromOpaque(context).takeUnretainedValue()
            let name = String(cString: host)
            runtime.queue.async { runtime.open(flow, host: name, port: port, udp: udp != 0) }
        }, data: { context, flow, bytes, length in
            guard let context else { return }
            let runtime = Unmanaged<VPNRuntime>.fromOpaque(context).takeUnretainedValue()
            let data = length == 0 ? Data() : Data(bytes: bytes!, count: length)
            runtime.queue.async { runtime.flows[flow]?.connection.send(data) }
        }, close: { context, flow in
            guard let context else { return }
            let runtime = Unmanaged<VPNRuntime>.fromOpaque(context).takeUnretainedValue()
            runtime.queue.async { runtime.closeFlow(flow) }
        }, packet: { context, bytes, length in
            guard let context, let bytes else { return }
            let runtime = Unmanaged<VPNRuntime>.fromOpaque(context).takeUnretainedValue()
            let packet = Data(bytes: bytes, count: length)
            runtime.queue.async { runtime.writePacket(packet) }
        }, eof: { context, flow in
            guard let context else { return }
            let runtime = Unmanaged<VPNRuntime>.fromOpaque(context).takeUnretainedValue()
            runtime.queue.async { runtime.flows[flow]?.connection.finishWriting() }
        })
        engine = wlp_new(callbacks, Unmanaged.passUnretained(self).toOpaque())
        guard let engine else { throw AppError("The native packet engine could not be created.") }
        wlp_tick(engine, Self.monotonicMilliseconds())
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in self?.readPackets() }
        readSource = source; source.resume()
        let transaction = NetworkPlan(interface: interface, nodeAddresses: addresses, journal: VPNHelper.journal)
        plan = transaction
        // Conservatively report an active transaction from its first possible
        // mutation until a successful restore, including partial-setup failures.
        networkActive = true
        try transaction.apply()
        message = "Verifying traffic through the configured tunnel."
    }

    private func verifyTunnel() {
        Task {
            do {
                let (_, response) = try await VPNHTTPS.fetch(URL(string: "https://www.gstatic.com/generate_204")!, maximum: 4096, timeout: 20)
                guard response.statusCode == 204 else { throw AppError("The routed HTTPS verification returned an unexpected response.") }
                queue.async {
                    guard !self.stopping, !self.stopped else { return }
                    do {
                        guard let plan = self.plan else { throw AppError("The tunnel network transaction is missing.") }
                        try plan.verifyActive()
                        self.state = "connected"; self.message = "Native VPN is active."
                        self.connectedAt = ISO8601DateFormatter().string(from: Date())
                    } catch { self.failAndRecover(error) }
                }
            } catch { queue.async { self.failAndRecover(AppError("Traffic through the native tunnel could not be verified: \(error.localizedDescription)")) } }
        }
    }

    private func startWatchers() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(10))
        timer.setEventHandler { [weak self] in self?.tick() }
        self.timer = timer; timer.resume()
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [weak self] in self?.stopForExit() }
            signals.append(source); source.resume()
        }
    }

    private func tick() {
        tickNumber += 1
        if let engine { wlp_tick(engine, Self.monotonicMilliseconds()); pumpAll() }
        if tickNumber % 10 == 0, !configuration.parent.matchesRunningProcess() { stopForExit(); return }
        if tickNumber % 100 == 0, networkActive, !stopping {
            do {
                guard try Self.defaultFingerprint() == originalDefault else { throw AppError("The physical network changed; reconnect the VPN.") }
                guard let plan else { throw AppError("The active VPN network transaction is missing.") }
                try plan.verifyActive()
            } catch { failAndRecover(error); return }
        }
        if tickNumber % 300 == 0, state == "connected", !healthRunning {
            healthRunning = true
            let current = node
            Task {
                let result = try? await VPNProxyProbe.test(node: current, timeout: 10)
                queue.async {
                    self.healthRunning = false
                    guard !self.stopping, !self.stopped else { return }
                    if let result { self.latency = Int(result); self.healthFailures = 0 }
                    else {
                        self.healthFailures += 1
                        if self.healthFailures >= 2 { self.failAndRecover(AppError("The VPN server stopped passing authenticated egress checks.")) }
                    }
                }
            }
        }
    }

    private func open(_ id: UInt64, host: String, port: UInt16, udp: Bool) {
        guard !stopping, !stopped, engine != nil else { return }
        let connection = ProxyConnection(node: node, destinationHost: host, destinationPort: port, udp: udp, queue: queue)
        let flow = VPNFlow(connection: connection, udp: udp)
        flows[id] = flow
        connection.onReady = { [weak self, weak flow] in
            guard let runtime = self, let target = flow else { return }
            runtime.queue.async {
                guard runtime.flows[id] === target, let engine = runtime.engine else { return }
                wlp_remote_open(engine, id); runtime.pump(id)
            }
        }
        connection.onData = { [weak self, weak flow] data in
            guard let runtime = self, let target = flow else { return }
            runtime.queue.async {
                guard runtime.flows[id] === target else { return }
                guard target.bytes + data.count <= 512 * 1024, target.pending.count < 2048 else { runtime.abort(id); return }
                target.pending.append(data); target.bytes += data.count; runtime.pump(id)
            }
        }
        connection.onError = { [weak self, weak flow] _ in
            guard let runtime = self, let target = flow else { return }
            runtime.queue.async { guard runtime.flows[id] === target else { return }; runtime.abort(id) }
        }
        connection.onClose = { [weak self, weak flow] in
            guard let runtime = self, let target = flow else { return }
            runtime.queue.async {
                guard runtime.flows[id] === target else { return }
                target.remoteEOF = true; runtime.pump(id)
            }
        }
        connection.start()
    }
    private func pumpAll() { for id in Array(flows.keys) { pump(id) } }
    private func pump(_ id: UInt64) {
        guard let engine, let flow = flows[id], !stopping else { return }
        while let first = flow.pending.first {
            let capacity = Int(wlp_remote_capacity(engine, id))
            let remainder = first.count - flow.offset
            if flow.udp {
                guard remainder <= capacity else { abort(id); return }
            } else if capacity == 0 { break }
            let count = flow.udp ? remainder : min(remainder, capacity, 32_768)
            let data = Data(first.dropFirst(flow.offset).prefix(count))
            let accepted = data.withUnsafeBytes { wlp_remote_data(engine, id, $0.bindMemory(to: UInt8.self).baseAddress, count) }
            guard accepted == 0 else { closeFlow(id); return }
            flow.offset += count; flow.bytes -= count
            if flow.offset == first.count { flow.pending.removeFirst(); flow.offset = 0 }
        }
        if !flow.udp {
            if flow.bytes >= 128 * 1024, !flow.paused { flow.paused = true; flow.connection.setReadEnabled(false) }
            else if flow.bytes < 64 * 1024, flow.paused { flow.paused = false; flow.connection.setReadEnabled(true) }
        }
        if flow.remoteEOF, flow.pending.isEmpty {
            wlp_remote_close(engine, id); closeFlow(id)
        }
    }
    private func abort(_ id: UInt64) {
        if let engine { wlp_remote_abort(engine, id) }
        closeFlow(id)
    }
    private func closeFlow(_ id: UInt64) {
        guard let flow = flows.removeValue(forKey: id) else { return }
        flow.connection.onReady = nil; flow.connection.onData = nil; flow.connection.onError = nil; flow.connection.onClose = nil
        flow.connection.close()
    }

    private func readPackets() {
        guard !stopping, let engine, descriptor >= 0 else { return }
        var bytes = [UInt8](repeating: 0, count: 65_575)
        wlp_tick(engine, Self.monotonicMilliseconds())
        for _ in 0..<64 {
            let count = wl_tun_read(descriptor, &bytes, bytes.count)
            if count < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK { break }
                if errno == EMSGSIZE || errno == EPROTO { continue }
                failAndRecover(AppError("Reading the native tunnel failed.")); return
            }
            if count == 0 { failAndRecover(AppError("The native tunnel closed unexpectedly.")); return }
            _ = bytes.withUnsafeBufferPointer { wlp_input(engine, $0.baseAddress, count) }
        }
        pumpAll()
    }
    private func writePacket(_ packet: Data) {
        guard descriptor >= 0, !stopping else { return }
        guard packetBytes + packet.count <= 4 * 1024 * 1024, packets.count < 4096 else {
            failAndRecover(AppError("The native tunnel's output queue overflowed.")); return
        }
        packets.append(packet); packetBytes += packet.count; drainPackets()
    }
    private func drainPackets() {
        guard descriptor >= 0, !stopping else { return }
        var processed = 0
        while let packet = packets.first, processed < 128 {
            let count = packet.withUnsafeBytes { wl_tun_write(descriptor, $0.baseAddress, packet.count) }
            if count < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK { break }
                failAndRecover(AppError("Writing to the native tunnel failed.")); return
            }
            guard count == packet.count else { failAndRecover(AppError("A native tunnel packet was only partially written.")); return }
            packets.removeFirst(); packetBytes -= packet.count; processed += 1
        }
        if packets.isEmpty { writeSource?.cancel(); writeSource = nil }
        else if writeSource == nil {
            let source = DispatchSource.makeWriteSource(fileDescriptor: descriptor, queue: queue)
            source.setEventHandler { [weak self] in self?.drainPackets() }
            writeSource = source; source.resume()
        }
    }

    private func request(_ method: String, _ path: String, complete: @escaping (Int, [String: Any], (() -> Void)?) -> Void) {
        if method == "GET", path == "/status" { complete(200, snapshot(), nil); return }
        if method == "POST", path == "/stop" {
            do {
                try cleanup(); state = "stopped"; message = "Routes and DNS were restored."
                complete(200, snapshot(), { self.queue.asyncAfter(deadline: .now() + 0.05) { self.exitHelper(0) } })
            } catch {
                state = "error"; message = error.localizedDescription
                complete(500, snapshot(), nil)
            }
            return
        }
        complete(404, ["message": "Unknown VPN control request."], nil)
    }
    private func snapshot() -> [String: Any] {
        var value: [String: Any] = ["pid": Int(getpid()), "state": state,
            "connected": state == "connected" && networkActive && probeAuthenticated,
            "networkActive": networkActive, "probeAuthenticated": probeAuthenticated,
            "message": message, "interface": interface, "connectedAt": connectedAt]
        if let latency { value["latency"] = latency }
        return value
    }
    private func cleanup() throws {
        stopping = true
        readSource?.cancel(); readSource = nil
        writeSource?.cancel(); writeSource = nil
        for id in Array(flows.keys) { closeFlow(id) }
        if let engine { wlp_free(engine); self.engine = nil }
        packets.removeAll(); packetBytes = 0
        // Keep the interface alive until route ownership has been checked and undone.
        do { try plan?.restore() }
        catch {
            stopping = false
            throw AppError("VPN route/DNS recovery is incomplete; the root-owned recovery journal was retained.")
        }
        networkActive = false; plan = nil
        if descriptor >= 0 { Darwin.close(descriptor); descriptor = -1 }
        stopped = true
    }
    private func failAndRecover(_ error: Error) {
        guard !stopped, !stopping else { return }
        state = "error"; message = error.localizedDescription
        do { try cleanup() }
        catch { message += " \(error.localizedDescription)" }
        // Keep the authenticated control endpoint available so the UI can inspect
        // the failure and explicitly confirm recovery/process exit via /stop.
    }
    private func stopForExit() {
        do { try cleanup(); exitHelper(0) }
        catch {
            fputs("WLSAPlus: network recovery failed; retain /var/db/wlsaplus-native/.root-network/journal.json.\n", stderr)
            exitHelper(1)
        }
    }
    private func exitHelper(_ code: Int32) -> Never {
        listener.cancel(); timer?.cancel()
        for source in signals { source.cancel() }
        exit(code)
    }

    private static func monotonicMilliseconds() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000_000 }
    private static func resolve(_ host: String, port: UInt16) throws -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC; hints.ai_socktype = Int32(SOCK_STREAM); hints.ai_protocol = Int32(IPPROTO_TCP)
        var answer: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &answer) == 0, let first = answer else { throw AppError("The VPN server name could not be resolved.") }
        defer { freeaddrinfo(first) }
        var result = [String](); var cursor: UnsafeMutablePointer<addrinfo>? = first
        while let current = cursor {
            var text = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let entry = current.pointee
            if (entry.ai_family == AF_INET || entry.ai_family == AF_INET6),
               getnameinfo(entry.ai_addr, entry.ai_addrlen, &text, socklen_t(text.count), nil, 0, NI_NUMERICHOST) == 0 {
                let address = String(cString: text)
                if !address.contains("%"), !result.contains(address) { result.append(address) }
            }
            cursor = entry.ai_next
        }
        result.sort { !$0.contains(":") && $1.contains(":") }
        guard !result.isEmpty, result.count <= 64 else { throw AppError("The VPN server has no usable IP endpoint.") }
        return result
    }
    private static func defaultFingerprint() throws -> String {
        var parts = [String]()
        for family in ["-inet", "-inet6"] {
            let output = (try? run("/sbin/route", ["-n", "get", family, "default"])) ?? ""
            parts.append(output.components(separatedBy: .newlines).filter {
                let line = $0.trimmingCharacters(in: .whitespaces)
                return line.hasPrefix("gateway:") || line.hasPrefix("interface:")
            }.joined(separator: "\n"))
        }
        guard parts.contains(where: { !$0.isEmpty }) else { throw AppError("No physical default route is available.") }
        return parts.joined(separator: "\n")
    }
}

/// A bounded one-request HTTP/1.1 control connection, bound only to IPv4 loopback.
private final class VPNControlConnection {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let token: String
    private let request: (String, String, @escaping (Int, [String: Any], (() -> Void)?) -> Void) -> Void
    private let closed: () -> Void
    private var buffer = Data()
    private var deadline: DispatchWorkItem?
    private var finished = false
    init(connection: NWConnection, queue: DispatchQueue, token: String,
         request: @escaping (String, String, @escaping (Int, [String: Any], (() -> Void)?) -> Void) -> Void,
         closed: @escaping () -> Void) {
        self.connection = connection; self.queue = queue; self.token = token
        self.request = request; self.closed = closed
    }
    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.close() }
            if case .cancelled = state { self?.close() }
        }
        connection.start(queue: queue)
        let work = DispatchWorkItem { [weak self] in self?.close() }
        deadline = work; queue.asyncAfter(deadline: .now() + 8, execute: work)
        receive()
    }
    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, error in
            guard let self, !self.finished else { return }
            if let data { self.buffer.append(data) }
            guard self.buffer.count <= 8192 else { self.respond(413, ["message": "Request too large."], nil); return }
            if let boundary = self.buffer.range(of: Data([13, 10, 13, 10])) {
                guard boundary.upperBound == self.buffer.count else { self.respond(400, ["message": "Control request bodies are not accepted."], nil); return }
                self.parse(); return
            }
            if done || error != nil { self.close(); return }
            self.receive()
        }
    }
    private func parse() {
        let lines = String(decoding: buffer, as: UTF8.self).components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count == 3, first[2] == "HTTP/1.1" else { respond(400, ["message": "Invalid HTTP request."], nil); return }
        var headers = [String: String]()
        for line in lines.dropFirst() where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { respond(400, ["message": "Invalid HTTP header."], nil); return }
            let name = line[..<colon].lowercased()
            guard headers[name] == nil else { respond(400, ["message": "Duplicate HTTP header."], nil); return }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard headers["transfer-encoding"] == nil, headers["content-length"] == nil || headers["content-length"] == "0" else {
            respond(400, ["message": "Control request bodies are not accepted."], nil); return
        }
        let supplied = Array((headers["authorization"] ?? "").utf8)
        let expected = Array(("Bearer " + token).utf8)
        var difference = supplied.count ^ expected.count
        for index in 0..<max(supplied.count, expected.count) {
            difference |= Int((index < supplied.count ? supplied[index] : 0) ^ (index < expected.count ? expected[index] : 0))
        }
        guard difference == 0 else { respond(401, ["message": "Unauthorized native VPN control request."], nil); return }
        request(String(first[0]), String(first[1])) { [weak self] code, value, after in self?.respond(code, value, after) }
    }
    private func respond(_ code: Int, _ value: [String: Any], _ after: (() -> Void)?) {
        guard !finished else { return }; finished = true
        deadline?.cancel(); deadline = nil
        let body = (try? jsonData(value)) ?? Data("{}".utf8)
        let status = code == 200 ? "OK" : "Error"
        let header = Data("HTTP/1.1 \(code) \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n".utf8)
        connection.send(content: header + body, completion: .contentProcessed { [weak self] _ in
            self?.close(); after?()
        })
        // A client disappearing during /stop cannot retain a privileged helper.
        if let after { queue.asyncAfter(deadline: .now() + 2) { after() } }
    }
    private func close() {
        deadline?.cancel(); deadline = nil
        connection.stateUpdateHandler = nil; connection.cancel(); closed()
    }
}
