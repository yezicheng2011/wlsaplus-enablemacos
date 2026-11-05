#if canImport(Network)   // Network.framework sockets and system TLS
import Foundation
import Network
import Security
import Dispatch
import Darwin

protocol ByteTransport: AnyObject {
    var onReady: (() -> Void)? { get set }
    var onData: ((Data) -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    func start()
    func send(_ data: Data)
    func finishWriting()
    func setReadEnabled(_ enabled: Bool)
    func close()
}

/// Ordered A/AAAA lookup used by every outbound proxy dial. IPv4 is tried before
/// IPv6 so a firewalled AAAA record cannot burn the whole probe budget.
enum ProxyEndpointResolver {
    static func addresses(host: String, port: UInt16) throws -> [String] {
        if let literal = literalAddress(host) { return [literal] }
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = Int32(SOCK_STREAM)
        hints.ai_protocol = Int32(IPPROTO_TCP)
        var answer: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &answer) == 0, let first = answer else {
            throw ProxyError.configuration("The proxy server name could not be resolved")
        }
        defer { freeaddrinfo(first) }
        var result = [String]()
        var cursor: UnsafeMutablePointer<addrinfo>? = first
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
        result.sort { left, right in
            let leftV6 = left.contains(":")
            let rightV6 = right.contains(":")
            if leftV6 != rightV6 { return !leftV6 && rightV6 }
            return left < right
        }
        guard !result.isEmpty else {
            throw ProxyError.configuration("The proxy server has no usable IP endpoint")
        }
        // Cap fan-out so a noisy DNS answer cannot stretch the outer probe budget.
        if result.count > 8 { result = Array(result.prefix(8)) }
        return result
    }

    static func literalAddress(_ host: String) -> String? {
        var v4 = in_addr(); var v6 = in6_addr()
        if inet_pton(AF_INET, host, &v4) == 1 { return host }
        if inet_pton(AF_INET6, host, &v6) == 1 { return host }
        return nil
    }
}

/// Network.framework owns sockets and TLS. Every method/callback runs on one serial queue.
/// TCP dials resolve first and walk IPv4 then IPv6 with a short per-address timeout so
/// Shadowsocks / WebSocket endpoints that only answer on one family still become ready
/// before the outer authenticated probe deadline.
final class NetworkByteTransport: ByteTransport {
    var onReady: (() -> Void)?
    var onData: ((Data) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?

    private let queue: DispatchQueue
    private let datagram: Bool
    private let port: NWEndpoint.Port
    private let candidates: [String]
    private let parameters: NWParameters
    private var connection: NWConnection?
    private var candidateIndex = 0
    private var started = false
    private var ready = false
    private var closed = false
    private var pendingBytes = 0
    private var pendingPackets = 0
    private var readEnabled = true
    private var receiving = false
    private var attemptTimeout: DispatchWorkItem?
    private let perAttemptSeconds: TimeInterval
    private var lastDialError: Error?
    /// Hard cap on addresses actually dialed (IPv4-first list may be longer).
    private static let maxDialCandidates = 4

    /// Dial and security layers: TCP or UDP, with system TLS inside Network.framework.
    init(server: String, port serverPort: UInt16, plan: TransportPlan, queue: DispatchQueue,
         perAttemptSeconds: TimeInterval = 6) throws {
        self.queue = queue
        self.datagram = plan.dial == .udp
        self.perAttemptSeconds = max(2, min(perAttemptSeconds, 20))
        guard let port = NWEndpoint.Port(rawValue: serverPort), serverPort != 0 else {
            throw ProxyError.configuration("Invalid proxy port")
        }
        self.port = port
        let resolved = try ProxyEndpointResolver.addresses(host: server, port: serverPort)
        candidates = Array(resolved.prefix(Self.maxDialCandidates))
        if datagram {
            parameters = NWParameters.udp
            parameters.preferNoProxies = true
        } else {
            let tcp = NWProtocolTCP.Options()
            tcp.enableKeepalive = true
            tcp.keepaliveIdle = 60
            // Keep each SYN attempt shorter than the outer probe so failover can run.
            tcp.connectionTimeout = Int(self.perAttemptSeconds)
            if case .systemTLS(let name) = plan.security {
                let tls = NWProtocolTLS.Options()
                sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, name)
                sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
                // Explicit chain and hostname validation also covers IP endpoints with custom SNI.
                sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
                    let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
                    let policy = SecPolicyCreateSSL(true, name as CFString)
                    guard SecTrustSetPolicies(secTrust, policy) == errSecSuccess else { complete(false); return }
                    complete(SecTrustEvaluateWithError(secTrust, nil))
                }, queue)
                parameters = NWParameters(tls: tls, tcp: tcp)
            } else {
                parameters = NWParameters(tls: nil, tcp: tcp)
            }
            parameters.preferNoProxies = true
        }
    }

    func start() {
        guard !started, !closed else { return }
        started = true
        dialNext(reason: nil)
    }

    func send(_ data: Data) {
        guard !closed else { return }
        guard ready, let connection else { fail(ProxyError.closed); return }
        guard pendingBytes + data.count <= 4 * 1024 * 1024, pendingPackets < 4096 else {
            fail(ProxyError.bufferLimit); return
        }
        pendingBytes += data.count; pendingPackets += 1
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            self.pendingBytes -= data.count; self.pendingPackets -= 1
            if let error { self.fail(error) }
        })
    }

    func finishWriting() {
        guard !closed, ready, let connection else { return }
        connection.send(content: nil, contentContext: .finalMessage, isComplete: true,
                        completion: .contentProcessed { [weak self] error in
            if let error { self?.fail(error) }
        })
    }

    func setReadEnabled(_ enabled: Bool) {
        readEnabled = enabled
        if enabled && ready { receive() }
    }

    func close() {
        guard !closed else { return }
        closed = true; ready = false
        cancelAttemptTimeout()
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
    }

    private func dialNext(reason: Error?) {
        guard !closed, !ready else { return }
        cancelAttemptTimeout()
        if let previous = connection {
            previous.stateUpdateHandler = nil
            previous.cancel()
            connection = nil
        }
        if let reason { lastDialError = reason }
        guard candidateIndex < candidates.count else {
            let tried = candidates.count
            let detail = Self.shortError(lastDialError ?? reason)
            fail(ProxyError.dial(
                "TCP dial failed after \(tried) address(es) (IPv4 preferred); last error: \(detail)"
            ))
            return
        }
        let host = candidates[candidateIndex]
        candidateIndex += 1
        let next = NWConnection(host: NWEndpoint.Host(host), port: port, using: parameters)
        connection = next
        next.stateUpdateHandler = { [weak self] state in
            guard let self, !self.closed else { return }
            switch state {
            case .ready:
                self.cancelAttemptTimeout()
                guard !self.ready else { return }
                self.ready = true
                self.onReady?(); self.receive()
            case .failed(let error):
                if self.ready { self.fail(error); return }
                self.dialNext(reason: error)
            case .cancelled:
                if self.ready { self.finish() }
            default: break
            }
        }
        next.start(queue: queue)
        if !datagram {
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, !self.closed, !self.ready else { return }
                self.dialNext(reason: ProxyError.timeout)
            }
            attemptTimeout = timeout
            queue.asyncAfter(deadline: .now() + perAttemptSeconds, execute: timeout)
        }
    }

    private static func shortError(_ error: Error?) -> String {
        guard let error else { return "unknown" }
        if let proxy = error as? ProxyError, let text = proxy.errorDescription { return text }
        let text = error.localizedDescription
        return text.isEmpty ? String(describing: type(of: error)) : text
    }

    private func cancelAttemptTimeout() {
        attemptTimeout?.cancel()
        attemptTimeout = nil
    }

    private func receive() {
        guard !closed, readEnabled, !receiving, let connection else { return }
        receiving = true
        if datagram {
            connection.receiveMessage { [weak self] data, _, _, error in
                guard let self, !self.closed else { return }
                self.receiving = false
                if let error { self.fail(error); return }
                if let data { self.onData?(data) }
                self.receive()
            }
        } else {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
                guard let self, !self.closed else { return }
                self.receiving = false
                if let data, !data.isEmpty { self.onData?(data) }
                if let error { self.fail(error); return }
                if done { self.finish(); return }
                self.receive()
            }
        }
    }

    private func fail(_ error: Error) {
        guard !closed else { return }
        onError?(error); close()
    }

    private func finish() {
        guard !closed else { return }
        close(); onClose?()
    }
}

/// Builds the dial → security → framing stack a TransportPlan describes. System TLS lives
/// inside the dial (Network.framework); a custom security layer would wrap `dialed` here.
enum TransportStack {
    static func make(node: ProxyNode, plan: TransportPlan, queue: DispatchQueue) throws -> ByteTransport {
        // 6s per resolved address, up to 4 addresses, fits inside the outer 28s deadline.
        let dialed = try NetworkByteTransport(server: node.server, port: node.port, plan: plan,
                                              queue: queue, perAttemptSeconds: 6)
        switch plan.framing {
        case .raw: return dialed
        case .webSocket(let path, let host):
            // Upgrade budget sits inside the outer 28s dial window after TCP is ready.
            return try WebSocketByteTransport(base: dialed, path: path, host: host, queue: queue,
                                              upgradeSeconds: 12)
        }
    }
}

final class WebSocketByteTransport: ByteTransport {
    var onReady: (() -> Void)?
    var onData: ((Data) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?
    private let base: ByteTransport
    private let queue: DispatchQueue
    private let request: Data
    private let key: String
    private let upgradeSeconds: TimeInterval
    private var handshake = Data()
    private var upgraded = false
    private var closed = false
    private var decoder = WebSocketFrameDecoder()
    private var upgradeTimeout: DispatchWorkItem?

    /// Framing layer; `path` and `host` come validated from `TransportPlan`.
    init(base: ByteTransport, path: String, host: String, queue: DispatchQueue,
         upgradeSeconds: TimeInterval = 12) throws {
        self.base = base
        self.queue = queue
        self.upgradeSeconds = max(3, min(upgradeSeconds, 30))
        key = try ProtocolCrypto.random(16).base64EncodedString()
        request = Data(("GET \(path) HTTP/1.1\r\nHost: \(host)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n").utf8)
        base.onReady = { [weak self] in
            guard let self, !self.closed else { return }
            self.armUpgradeTimeout()
            self.base.send(self.request)
        }
        base.onData = { [weak self] in self?.receive($0) }
        base.onError = { [weak self] in self?.fail($0) }
        base.onClose = { [weak self] in self?.finished() }
    }
    func start() { base.start() }
    func send(_ data: Data) {
        guard !closed else { return }
        guard upgraded else { fail(ProxyError.closed); return }
        do { base.send(try WebSocketWire.clientFrame(data)) } catch { fail(error) }
    }
    func close() {
        guard !closed else { return }
        closed = true
        cancelUpgradeTimeout()
        base.close()
    }
    func finishWriting() { /* VMess termination is carried in a final binary message. */ }
    func setReadEnabled(_ enabled: Bool) { base.setReadEnabled(enabled) }

    private func armUpgradeTimeout() {
        cancelUpgradeTimeout()
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.closed, !self.upgraded else { return }
            self.fail(ProxyError.dial("WebSocket upgrade timed out waiting for HTTP 101"))
        }
        upgradeTimeout = item
        queue.asyncAfter(deadline: .now() + upgradeSeconds, execute: item)
    }

    private func cancelUpgradeTimeout() {
        upgradeTimeout?.cancel()
        upgradeTimeout = nil
    }

    private func receive(_ received: Data) {
        guard !closed else { return }
        do {
            var data = received
            if !upgraded {
                guard handshake.count + data.count <= 65_536 + 16_384 else { throw ProxyError.bufferLimit }
                handshake.append(data)
                let separator = Data([13, 10, 13, 10])
                guard let boundary = handshake.range(of: separator) else {
                    guard handshake.count <= 16_384 else { throw ProxyError.bufferLimit }; return
                }
                guard boundary.upperBound <= 16_384 else { throw ProxyError.bufferLimit }
                try WebSocketWire.validateUpgrade(Data(handshake[..<boundary.upperBound]), key: key)
                data = Data(handshake[boundary.upperBound...]); handshake.removeAll()
                cancelUpgradeTimeout()
                upgraded = true; onReady?()
            }
            for event in try decoder.receive(data) {
                switch event {
                case .binary(let payload): onData?(payload)
                case .ping(let payload): base.send(try WebSocketWire.clientFrame(payload, opcode: 10))
                case .pong: break
                case .close(let payload):
                    base.send(try WebSocketWire.clientFrame(payload, opcode: 8)); finished(); return
                }
            }
        } catch { fail(error) }
    }
    private func fail(_ error: Error) {
        guard !closed else { return }
        cancelUpgradeTimeout()
        onError?(error)
        close()
    }
    private func finished() {
        guard !closed else { return }
        do {
            guard upgraded else { throw ProxyError.malformed("WebSocket closed during upgrade") }
            try decoder.finish(); close(); onClose?()
        } catch { fail(error) }
    }
}
#endif
