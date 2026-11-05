import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

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
        var header = Data([0x80 | opcode])
        if payload.count < 126 { header.append(0x80 | UInt8(payload.count)) }
        else if payload.count <= 65535 {
            header.append(0x80 | 126); header.append(WireBytes.be16(UInt16(payload.count)))
        } else {
            header.append(0x80 | 127); header.append(WireBytes.be64(UInt64(payload.count)))
        }
        header.append(mask)
        // One allocation, then mask in place. Appending byte by byte cost one Data growth check
        // per payload byte, which dominated WebSocket upload CPU for large writes.
        var result = Data(count: header.count + payload.count)
        let m = [UInt8](mask)
        result.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) in
            let bytes = out.bindMemory(to: UInt8.self)
            header.withUnsafeBytes { h in for i in 0..<h.count { bytes[i] = h[i] } }
            payload.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
                let base = header.count
                for i in 0..<p.count { bytes[base + i] = p[i] ^ m[i & 3] }
            }
        }
        return result
    }

    static func validateUpgrade(_ response: Data, key: String) throws {
        guard let text = String(data: response, encoding: .utf8) else { throw ProxyError.malformed("Invalid WebSocket HTTP response") }
        let lines = text.components(separatedBy: "\r\n")
        guard let first = lines.first else { throw ProxyError.malformed("Missing WebSocket HTTP status") }
        let status = first.split(separator: " ", omittingEmptySubsequences: true)
        guard status.count >= 2, status[0].hasPrefix("HTTP/1.") else {
            throw ProxyError.malformed("Missing or unsupported WebSocket HTTP version")
        }
        guard status[1] == "101" else {
            let code = String(status[1])
            throw ProxyError.malformed("The server refused the WebSocket upgrade (HTTP \(code))")
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
    private var buffer = ByteQueue()
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
            _ = buffer.take(header)
            let payload = buffer.take(Int(length))
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
