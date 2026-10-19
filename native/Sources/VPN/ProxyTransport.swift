import Foundation
import Dispatch
import CryptoKit
import Security
import Darwin

/// A server configuration. Credentials are intentionally never included in descriptions/errors.
public struct ProxyNode: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var type: String
    public var server: String
    public var port: UInt16
    public var cipher: String?
    public var password: String?
    public var uuid: String?
    public var alterId: Int?
    public var tls: Bool?
    public var serverName: String?
    public var skipCertVerify: Bool?
    public var network: String?
    public var wsPath: String?
    public var wsHost: String?
    public var udp: Bool?

    public init(id: String, name: String, type: String, server: String, port: UInt16,
                cipher: String? = nil, password: String? = nil, uuid: String? = nil,
                alterId: Int? = nil, tls: Bool? = nil, serverName: String? = nil,
                skipCertVerify: Bool? = nil, network: String? = nil,
                wsPath: String? = nil, wsHost: String? = nil, udp: Bool? = nil) {
        self.id = id; self.name = name; self.type = type; self.server = server; self.port = port
        self.cipher = cipher; self.password = password; self.uuid = uuid; self.alterId = alterId
        self.tls = tls; self.serverName = serverName; self.skipCertVerify = skipCertVerify
        self.network = network; self.wsPath = wsPath; self.wsHost = wsHost; self.udp = udp
    }

    public func validate() throws {
        guard !server.isEmpty, !server.contains(where: { $0.isWhitespace || $0.isNewline }),
              port != 0 else { throw ProxyError.configuration("Missing server address or port") }
        guard skipCertVerify != true else {
            throw ProxyError.unsupported("Disabling TLS certificate verification is not supported")
        }
        switch type.lowercased() {
        case "ss", "shadowsocks":
            guard cipher?.lowercased() == "aes-256-gcm", password != nil else {
                throw ProxyError.unsupported("Shadowsocks requires aes-256-gcm and a password")
            }
            guard tls != true, network == nil || network == "tcp" else {
                throw ProxyError.unsupported("Shadowsocks transport plugins are not supported")
            }
        case "vmess":
            guard UUID(uuidString: uuid ?? "") != nil else {
                throw ProxyError.configuration("VMess requires a valid UUID")
            }
            guard (0...65535).contains(alterId ?? 0) else {
                throw ProxyError.configuration("VMess alterId must be in 0...65535")
            }
            guard ["auto", "aes-128-gcm"].contains((cipher ?? "auto").lowercased()) else {
                throw ProxyError.unsupported("This VMess implementation supports auto and aes-128-gcm")
            }
            guard ["tcp", "ws"].contains((network ?? "tcp").lowercased()) else {
                throw ProxyError.unsupported("VMess requires TCP or WebSocket transport")
            }
        default: throw ProxyError.unsupported("Unsupported proxy protocol")
        }
    }
}

public enum ProxyError: LocalizedError {
    case configuration(String), unsupported(String), malformed(String)
    case authentication, nonceExhausted, bufferLimit, randomness, closed, timeout
    public var errorDescription: String? {
        switch self {
        case .configuration(let reason), .unsupported(let reason), .malformed(let reason): return reason
        case .authentication: return "The proxy response failed authentication"
        case .nonceExhausted: return "The encrypted session reached its nonce limit; reconnect"
        case .bufferLimit: return "The proxy exceeded its bounded buffering limit"
        case .randomness: return "The system could not generate secure random bytes"
        case .closed: return "The proxy connection is closed"
        case .timeout: return "The proxy connection timed out"
        }
    }
}

/// One TCP stream or one fixed-destination UDP association. Callbacks run on `queue`.
/// For UDP, every send/onData invocation is exactly one datagram, including empty datagrams.
/// `onReady` means the transport is connected and the request header has been queued;
/// it does not assert that the remote proxy accepted credentials or reached the destination.
/// VMess standard framing rejects empty UDP datagrams because they encode stream termination.
final class ProxyConnection {
    var onReady: (() -> Void)?
    var onData: ((Data) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?

    private let node: ProxyNode
    private let host: String
    private let port: UInt16
    private let datagram: Bool
    private let queue: DispatchQueue
    private var transport: ByteTransport?
    private var shadowsocks: ShadowsocksSession?
    private var vmess: VMessSession?
    private var started = false
    private var ready = false
    private var closed = false
    private var writeEnded = false
    private var finishPending = false
    private var pending = [Data]()
    private var pendingBytes = 0
    private var timeout: DispatchWorkItem?

    init(node: ProxyNode, destinationHost: String, destinationPort: UInt16,
         udp: Bool, queue: DispatchQueue) {
        self.node = node; host = destinationHost; port = destinationPort
        datagram = udp; self.queue = queue
    }

    func start() { queue.async { self.startOnQueue() } }
    func send(_ data: Data) { queue.async { self.sendOnQueue(data) } }
    func close() { queue.async { self.closeOnQueue() } }
    /// Preserve incoming responses after the local TCP peer sends FIN.
    func finishWriting() { queue.async { self.finishWritingOnQueue() } }
    func setReadEnabled(_ enabled: Bool) { queue.async { self.transport?.setReadEnabled(enabled) } }

    private func startOnQueue() {
        guard !started, !closed else { return }
        started = true
        do {
            try node.validate()
            guard port != 0 else { throw ProxyError.configuration("Missing destination port") }
            if datagram && node.udp != true { throw ProxyError.unsupported("UDP is disabled for this server") }
            let ss = ["ss", "shadowsocks"].contains(node.type.lowercased())
            if ss {
                shadowsocks = try ShadowsocksSession(password: node.password!, destinationHost: host,
                                                      destinationPort: port, udp: datagram)
            } else {
                vmess = try VMessSession(uuid: node.uuid!, alterId: node.alterId ?? 0,
                                         destinationHost: host, destinationPort: port, udp: datagram)
            }
            // 6s per resolved address, up to 4 addresses, fits inside the outer deadline.
            let network = try NetworkByteTransport(node: node, datagram: ss && datagram, queue: queue,
                                                   perAttemptSeconds: 6)
            let channel: ByteTransport
            if !ss && (node.network ?? "tcp").lowercased() == "ws" {
                channel = try WebSocketByteTransport(base: network, node: node)
            } else { channel = network }
            transport = channel
            channel.onReady = { [weak self] in self?.transportReady() }
            channel.onData = { [weak self] in self?.receive($0) }
            channel.onError = { [weak self] in self?.fail($0) }
            channel.onClose = { [weak self] in self?.transportClosed() }
            let deadline = DispatchWorkItem { [weak self] in self?.fail(ProxyError.timeout) }
            timeout = deadline
            // Outer budget covers IPv4-then-IPv6 failover for SS/WS endpoints.
            queue.asyncAfter(deadline: .now() + 28, execute: deadline)
            channel.start()
        } catch { fail(error) }
    }

    private func transportReady() {
        guard !closed else { return }
        do {
            if let shadowsocks, !datagram { transport?.send(try shadowsocks.requestHeader()) }
            if let vmess { transport?.send(try vmess.requestHeader()) }
            ready = true
            timeout?.cancel(); timeout = nil
            let waiting = pending; pending.removeAll(); pendingBytes = 0
            for packet in waiting { try transmit(packet) }
            if finishPending { try finishTransportWriting() }
            onReady?()
        } catch { fail(error) }
    }

    private func sendOnQueue(_ data: Data) {
        guard !closed else { return }
        guard !writeEnded else { fail(ProxyError.closed); return }
        guard datagram || !data.isEmpty else { return }
        guard ready else {
            guard pending.count < 1024, pendingBytes + data.count <= 512 * 1024 else {
                fail(ProxyError.bufferLimit); return
            }
            pending.append(data); pendingBytes += data.count; return
        }
        do { try transmit(data) } catch { fail(error) }
    }

    private func transmit(_ data: Data) throws {
        if let shadowsocks {
            if datagram { transport?.send(try shadowsocks.encodeDatagram(data)) }
            else { for chunk in try shadowsocks.encodeStream(data) { transport?.send(chunk) } }
        } else if let vmess {
            for chunk in try vmess.encodeBody(data) { transport?.send(chunk) }
        }
    }

    private func finishWritingOnQueue() {
        guard !closed, !writeEnded, !datagram else { return }
        writeEnded = true; finishPending = true
        guard ready else { return }
        do { try finishTransportWriting() } catch { fail(error) }
    }

    private func finishTransportWriting() throws {
        finishPending = false
        if let vmess { transport?.send(try vmess.finishWriting()) }
        // RFC6455 has no independent write EOF. VMess's encrypted termination
        // packet closes that direction while the WebSocket remains available for replies.
        if (node.network ?? "tcp").lowercased() != "ws" { transport?.finishWriting() }
    }

    private func receive(_ data: Data) {
        guard !closed else { return }
        do {
            if let shadowsocks {
                if datagram { onData?(try shadowsocks.decodeDatagram(data)) }
                else { for chunk in try shadowsocks.decodeStream(data) { onData?(chunk) } }
            } else if let vmess {
                for chunk in try vmess.decodeResponse(data) { onData?(chunk) }
                if vmess.responseEnded { closeOnQueue() }
            }
        } catch { fail(error) }
    }

    private func transportClosed() {
        guard !closed else { return }
        do {
            if let shadowsocks, !datagram { try shadowsocks.finishReceiving() }
            if let vmess { try vmess.finishReceiving() }
            closeOnQueue()
        } catch { fail(error) }
    }

    private func fail(_ error: Error) {
        guard !closed else { return }
        onError?(error)
        closeOnQueue()
    }

    private func closeOnQueue() {
        guard !closed else { return }
        closed = true; ready = false
        timeout?.cancel(); timeout = nil
        pending.removeAll(); pendingBytes = 0
        transport?.close(); transport = nil
        onClose?()
    }
}

enum ProtocolCrypto {
    static func random(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { throw ProxyError.randomness }
        return Data(bytes)
    }
    static func md5(_ data: Data) -> Data { Data(Insecure.MD5.hash(data: data)) }
    static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
    static func seal(_ plain: Data, key: Data, nonce: Data, aad: Data = Data()) throws -> Data {
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key),
                                   nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }
    static func open(_ encrypted: Data, key: Data, nonce: Data, aad: Data = Data()) throws -> Data {
        guard encrypted.count >= 16 else { throw ProxyError.authentication }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce),
                                             ciphertext: encrypted.dropLast(16), tag: encrypted.suffix(16))
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
        } catch { throw ProxyError.authentication }
    }
}

/// Byte-oriented address encoding; DNS is deliberately resolved by the remote proxy.
enum ProxyAddress {
    static func bytes(_ host: String) throws -> (kind: UInt8, address: Data) {
        var v4 = in_addr(); var v6 = in6_addr()
        if inet_pton(AF_INET, host, &v4) == 1 {
            return (1, withUnsafeBytes(of: &v4) { Data($0) })
        }
        if inet_pton(AF_INET6, host, &v6) == 1 {
            return (4, withUnsafeBytes(of: &v6) { Data($0) })
        }
        let value = Data(host.utf8)
        guard !value.isEmpty, value.count <= 255, value.allSatisfy({ $0 > 32 && $0 < 127 }) else {
            throw ProxyError.configuration("Destination must be an IP address or an ASCII DNS name")
        }
        return (3, Data([UInt8(value.count)]) + value)
    }
    static func socks(_ host: String, _ port: UInt16) throws -> Data {
        let address = try bytes(host)
        return Data([address.kind]) + address.address + WireBytes.be16(port)
    }
    static func stripSOCKS(_ packet: Data) throws -> Data {
        let p = [UInt8](packet)
        guard !p.isEmpty else { throw ProxyError.malformed("Missing UDP source address") }
        let length: Int
        switch p[0] {
        case 1: length = 7
        case 4: length = 19
        case 3:
            guard p.count >= 2, p[1] > 0 else { throw ProxyError.malformed("Invalid UDP domain address") }
            length = 4 + Int(p[1])
        default: throw ProxyError.malformed("Invalid UDP source address type")
        }
        guard packet.count >= length else { throw ProxyError.malformed("Truncated UDP source address") }
        return Data(packet.dropFirst(length))
    }
}

enum WireBytes {
    static func be16(_ n: UInt16) -> Data { Data([UInt8(n >> 8), UInt8(n & 255)]) }
    static func be32(_ n: UInt32) -> Data { Data((0..<4).reversed().map { UInt8(truncatingIfNeeded: n >> ($0 * 8)) }) }
    static func be64(_ n: UInt64) -> Data { Data((0..<8).reversed().map { UInt8(truncatingIfNeeded: n >> ($0 * 8)) }) }
    static func uint16(_ bytes: Data) -> Int {
        let a = [UInt8](bytes.prefix(2)); return (Int(a[0]) << 8) | Int(a[1])
    }
}

/// Replay state is shared by associations using the same key, bounded to 16K salts.
final class SaltReplayCache {
    static let shared = SaltReplayCache()
    private let lock = NSLock()
    private var entries = Set<Data>()
    private var order = [Data]()
    private var offset = 0
    func insert(key: Data, salt: Data) throws {
        let identity = ProtocolCrypto.sha256(key + salt)
        lock.lock(); defer { lock.unlock() }
        guard !entries.contains(identity) else { throw ProxyError.authentication }
        entries.insert(identity); order.append(identity)
        if order.count - offset > 16_384 { entries.remove(order[offset]); offset += 1 }
        if offset >= 16_384 { order.removeFirst(offset); offset = 0 }
    }
}
