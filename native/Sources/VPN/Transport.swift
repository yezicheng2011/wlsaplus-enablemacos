import Foundation
import Network
import Security
import CryptoKit
import Dispatch

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

/// Network.framework owns sockets and TLS. Every method/callback runs on one serial queue.
final class NetworkByteTransport: ByteTransport {
    var onReady: (() -> Void)?
    var onData: ((Data) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let datagram: Bool
    private var started = false
    private var ready = false
    private var closed = false
    private var pendingBytes = 0
    private var pendingPackets = 0
    private var readEnabled = true
    private var receiving = false

    init(node: ProxyNode, datagram: Bool, queue: DispatchQueue) throws {
        self.queue = queue; self.datagram = datagram
        guard let port = NWEndpoint.Port(rawValue: node.port), node.port != 0 else {
            throw ProxyError.configuration("Invalid proxy port")
        }
        guard node.skipCertVerify != true else { throw ProxyError.unsupported("Insecure TLS is disabled") }
        let parameters: NWParameters
        if datagram { parameters = NWParameters.udp }
        else {
            let tcp = NWProtocolTCP.Options()
            tcp.enableKeepalive = true
            tcp.keepaliveIdle = 60
            tcp.connectionTimeout = 20
            if node.tls == true {
                let tls = NWProtocolTLS.Options()
                let name = node.serverName?.isEmpty == false ? node.serverName! : node.server
                guard !name.isEmpty, name.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else {
                    throw ProxyError.configuration("Invalid TLS server name")
                }
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
            } else { parameters = NWParameters(tls: nil, tcp: tcp) }
        }
        connection = NWConnection(host: NWEndpoint.Host(node.server), port: port, using: parameters)
    }

    func start() {
        guard !started, !closed else { return }; started = true
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, !self.closed else { return }
            switch state {
            case .ready:
                guard !self.ready else { return }; self.ready = true
                self.onReady?(); self.receive()
            case .failed(let error): self.fail(error)
            case .cancelled: self.finish()
            default: break
            }
        }
        connection.start(queue: queue)
    }

    func send(_ data: Data) {
        guard !closed else { return }
        guard ready else { fail(ProxyError.closed); return }
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
        guard !closed, ready else { return }
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
        guard !closed else { return }; closed = true; ready = false
        connection.stateUpdateHandler = nil; connection.cancel()
    }

    private func receive() {
        guard !closed, readEnabled, !receiving else { return }
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

// Original RFC6455 client framing; no extensions or early-data dialect is negotiated.
// https://www.rfc-editor.org/rfc/rfc6455
enum WebSocketWire {
    static func accept(_ key: String) -> String {
        Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
    }
    static func clientFrame(_ payload: Data, opcode: UInt8 = 2, mask suppliedMask: Data? = nil) throws -> Data {
        guard payload.count <= 2 * 1024 * 1024 else { throw ProxyError.bufferLimit }
        if opcode >= 8, payload.count > 125 { throw ProxyError.bufferLimit }
        let mask = try suppliedMask ?? ProtocolCrypto.random(4)
        guard mask.count == 4 else { throw ProxyError.randomness }
        var result = Data([0x80 | opcode])
        if payload.count < 126 { result.append(0x80 | UInt8(payload.count)) }
        else if payload.count <= 65535 {
            result.append(0x80 | 126); result.append(WireBytes.be16(UInt16(payload.count)))
        } else {
            result.append(0x80 | 127); result.append(WireBytes.be64(UInt64(payload.count)))
        }
        result.append(mask)
        let m = [UInt8](mask)
        for (index, value) in payload.enumerated() { result.append(value ^ m[index & 3]) }
        return result
    }

    static func validateUpgrade(_ response: Data, key: String) throws {
        guard let text = String(data: response, encoding: .utf8) else { throw ProxyError.malformed("Invalid WebSocket HTTP response") }
        let lines = text.components(separatedBy: "\r\n")
        guard let first = lines.first else { throw ProxyError.malformed("Missing WebSocket HTTP status") }
        let status = first.split(separator: " ", omittingEmptySubsequences: true)
        guard status.count >= 2, status[0] == "HTTP/1.1", status[1] == "101" else {
            throw ProxyError.malformed("The server refused the WebSocket upgrade")
        }
        var headers = [String: [String]]()
        for line in lines.dropFirst() where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":"), line.first != " ", line.first != "\t" else {
                throw ProxyError.malformed("Invalid WebSocket HTTP header")
            }
            let name = line[..<colon].lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name, default: []].append(value)
        }
        func containsToken(_ field: String, _ token: String) -> Bool {
            (headers[field] ?? []).flatMap { $0.lowercased().split(separator: ",").map(String.init) }
                .contains { $0.trimmingCharacters(in: .whitespaces) == token }
        }
        guard containsToken("upgrade", "websocket"), containsToken("connection", "upgrade"),
              headers["sec-websocket-accept"] == [accept(key)],
              headers["sec-websocket-extensions"] == nil, headers["sec-websocket-protocol"] == nil else {
            throw ProxyError.authentication
        }
    }
}

enum WebSocketEvent {
    case binary(Data), ping(Data), pong, close(Data)
}

struct WebSocketFrameDecoder {
    private var buffer = Data()
    private var fragments: Data?
    private var ended = false

    mutating func receive(_ data: Data) throws -> [WebSocketEvent] {
        guard !ended || data.isEmpty else { throw ProxyError.malformed("WebSocket data after close") }
        guard buffer.count + data.count <= 2 * 1024 * 1024 + 65_550 else { throw ProxyError.bufferLimit }
        buffer.append(data)
        var output = [WebSocketEvent]()
        while buffer.count >= 2 {
            let h = [UInt8](buffer.prefix(10))
            let fin = h[0] & 0x80 != 0; let opcode = h[0] & 15
            guard h[0] & 0x70 == 0, h[1] & 0x80 == 0 else {
                throw ProxyError.malformed("Invalid WebSocket server frame flags")
            }
            var length = UInt64(h[1] & 127); var header = 2
            if length == 126 {
                guard h.count >= 4 else { break }
                length = (UInt64(h[2]) << 8) | UInt64(h[3]); header = 4
                guard length >= 126 else { throw ProxyError.malformed("Noncanonical WebSocket length") }
            } else if length == 127 {
                guard h.count >= 10 else { break }
                length = h[2..<10].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }; header = 10
                guard length > 65535, h[2] & 0x80 == 0 else { throw ProxyError.malformed("Invalid WebSocket length") }
            }
            guard length <= 2 * 1024 * 1024 else { throw ProxyError.bufferLimit }
            if opcode >= 8 {
                guard fin, length <= 125 else { throw ProxyError.malformed("Invalid WebSocket control frame") }
            }
            guard buffer.count >= header + Int(length) else { break }
            let payload = Data(buffer.dropFirst(header).prefix(Int(length)))
            buffer = Data(buffer.dropFirst(header + Int(length)))
            switch opcode {
            case 0:
                guard fragments != nil else { throw ProxyError.malformed("Unexpected WebSocket continuation") }
                guard fragments!.count + payload.count <= 2 * 1024 * 1024 else { throw ProxyError.bufferLimit }
                fragments!.append(payload)
                if fin { output.append(.binary(fragments!)); fragments = nil }
            case 2:
                guard fragments == nil else { throw ProxyError.malformed("Overlapping WebSocket messages") }
                if fin { output.append(.binary(payload)) } else { fragments = payload }
            case 8:
                guard payload.count != 1 else { throw ProxyError.malformed("Invalid WebSocket close payload") }
                if payload.count >= 2 {
                    let code = WireBytes.uint16(payload)
                    guard (1000...4999).contains(code), ![1004, 1005, 1006, 1015].contains(code),
                          String(data: payload.dropFirst(2), encoding: .utf8) != nil else {
                        throw ProxyError.malformed("Invalid WebSocket close status")
                    }
                }
                ended = true; output.append(.close(payload))
                guard buffer.isEmpty else { throw ProxyError.malformed("WebSocket data after close") }
                return output
            case 9: output.append(.ping(payload))
            case 10: output.append(.pong)
            default: throw ProxyError.malformed("Unsupported WebSocket frame opcode")
            }
        }
        return output
    }

    func finish() throws {
        guard buffer.isEmpty, fragments == nil else { throw ProxyError.malformed("Truncated WebSocket frame") }
    }
}

final class WebSocketByteTransport: ByteTransport {
    var onReady: (() -> Void)?
    var onData: ((Data) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?
    private let base: ByteTransport
    private let request: Data
    private let key: String
    private var handshake = Data()
    private var upgraded = false
    private var closed = false
    private var decoder = WebSocketFrameDecoder()

    init(base: ByteTransport, node: ProxyNode) throws {
        self.base = base
        let path = node.wsPath?.isEmpty == false ? node.wsPath! : "/"
        let literal = node.server.contains(":") ? "[\(node.server)]" : node.server
        let host = node.wsHost?.isEmpty == false ? node.wsHost! : "\(literal):\(node.port)"
        guard path.hasPrefix("/"), path.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
              !host.isEmpty, host.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else {
            throw ProxyError.configuration("Invalid WebSocket Host or path")
        }
        key = try ProtocolCrypto.random(16).base64EncodedString()
        request = Data(("GET \(path) HTTP/1.1\r\nHost: \(host)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n").utf8)
        base.onReady = { [weak self] in guard let self, !self.closed else { return }; self.base.send(self.request) }
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
    func close() { guard !closed else { return }; closed = true; base.close() }
    func finishWriting() { /* VMess termination is carried in a final binary message. */ }
    func setReadEnabled(_ enabled: Bool) { base.setReadEnabled(enabled) }

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
    private func fail(_ error: Error) { guard !closed else { return }; onError?(error); close() }
    private func finished() {
        guard !closed else { return }
        do {
            guard upgraded else { throw ProxyError.malformed("WebSocket closed during upgrade") }
            try decoder.finish(); close(); onClose?()
        } catch { fail(error) }
    }
}
