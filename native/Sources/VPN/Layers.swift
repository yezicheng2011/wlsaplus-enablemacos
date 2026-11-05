import Foundation

// A connection is a stack of independent layers:
//
//   protocol   ProxySession      Shadowsocks | VMess | Trojan
//   framing    TransportPlan     raw | WebSocket
//   security   TransportPlan     none | system TLS (Network.framework)
//   dial       TransportPlan     TCP | UDP
//
// ProxyConnection only talks to these interfaces, so a new protocol is a new ProxySession
// and a new transport is a new plan case, without touching the connection logic.

/// Protocol layer: turns application bytes into what the proxy server expects and back.
/// One session per TCP stream or UDP association; every call comes from one serial queue.
protocol ProxySession: AnyObject {
    /// For UDP associations: true when datagrams travel over a UDP socket (Shadowsocks)
    /// rather than inside the proxy stream.
    var usesDatagramSocket: Bool { get }
    /// Bytes the server must receive first, once the transport is ready; nil if none.
    func openingBytes() throws -> Data?
    /// Wire chunks for one application write (for UDP, exactly one datagram).
    func encode(_ payload: Data) throws -> [Data]
    /// Application payloads decoded from bytes received from the transport.
    func decode(_ received: Data) throws -> [Data]
    /// In-band end of the write direction (VMess); nil when transport EOF is the signal.
    func closingBytes() throws -> Data?
    /// The transport closed cleanly; throws if that happened in the middle of a frame.
    func transportEnded() throws
    /// True once the server ended the stream in-band.
    var remoteEnded: Bool { get }
}

/// Dial, security and framing layers for one node, derived without touching the network.
struct TransportPlan: Equatable {
    enum Dial: Equatable { case tcp, udp }
    enum Security: Equatable { case none, systemTLS(serverName: String) }
    enum Framing: Equatable { case raw, webSocket(path: String, host: String) }

    var dial: Dial
    var security: Security
    var framing: Framing

    /// RFC 6455 has no write-side EOF, so only raw framing can forward one.
    var framingCarriesEOF: Bool { framing == .raw }

    static func make(for node: ProxyNode, datagramSocket: Bool) throws -> TransportPlan {
        guard node.skipCertVerify != true else { throw ProxyError.unsupported("Insecure TLS is disabled") }
        if datagramSocket { return TransportPlan(dial: .udp, security: .none, framing: .raw) }
        var security = Security.none
        if node.usesTLS {
            let name = node.serverName?.isEmpty == false ? node.serverName! : node.server
            guard !name.isEmpty, name.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else {
                throw ProxyError.configuration("Invalid TLS server name")
            }
            security = .systemTLS(serverName: name)
        }
        var framing = Framing.raw
        if (node.network ?? "tcp").lowercased() == "ws" {
            let path = node.wsPath?.isEmpty == false ? node.wsPath! : "/"
            let literal = node.server.contains(":") ? "[\(node.server)]" : node.server
            // Prefer an explicit Host header from the subscription. When absent, include
            // the port so non-443 WebSocket backends still see a canonical authority.
            let host = node.wsHost?.isEmpty == false ? node.wsHost! : "\(literal):\(node.port)"
            guard path.hasPrefix("/"), path.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
                  host.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else {
                throw ProxyError.configuration("Invalid WebSocket Host or path")
            }
            framing = .webSocket(path: path, host: host)
        }
        return TransportPlan(dial: .tcp, security: security, framing: framing)
    }
}

/// Joins consecutive stream wire chunks into as few writes as possible, keeping order and
/// bytes exactly, and never building one write larger than `limit` unless a single input
/// chunk already is. Stream protocols (Shadowsocks AEAD chunks, VMess body chunks, the
/// opening header plus early data) have their own framing, so how the bytes are split
/// into writes is invisible to the server. Fewer writes means fewer TLS records, fewer
/// WebSocket frames and fewer transport sends. Never use it for a UDP socket, where each
/// write is one datagram.
enum StreamCoalescer {
    /// 256 KiB stays far below the 2 MiB WebSocket frame cap and bounds copy size.
    static let defaultLimit = 256 * 1024

    static func coalesce(_ chunks: [Data], limit: Int = defaultLimit) -> [Data] {
        guard chunks.count > 1 else { return chunks.filter { !$0.isEmpty } }
        let total = chunks.reduce(0) { $0 + $1.count }
        var writes = [Data](); var current = Data()
        for chunk in chunks where !chunk.isEmpty {
            if !current.isEmpty, current.count + chunk.count > limit {
                writes.append(current); current = Data()
            }
            if current.isEmpty, chunk.count >= limit { writes.append(chunk); continue }
            if current.isEmpty { current.reserveCapacity(min(limit, total)) }
            current.append(chunk)
        }
        if !current.isEmpty { writes.append(current) }
        return writes
    }
}
