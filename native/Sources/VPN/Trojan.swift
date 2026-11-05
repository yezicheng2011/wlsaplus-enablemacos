import Foundation

// Original implementation from the public protocol description:
// https://trojan-gfw.github.io/trojan/protocol
// The client authenticates inside TLS with hex(SHA-224(password)). The server sends no
// response header, so after the request TCP payload flows unchanged in both directions.
// UDP ASSOCIATE carries datagrams inside the same TLS stream, each framed as
// ATYP | address | port | length | CRLF | payload.

enum TrojanCommand: UInt8 {
    case connect = 0x01
    case udpAssociate = 0x03
}

final class TrojanSession {
    static let maxDatagram = 65_507
    private static let crlf = Data([0x0d, 0x0a])
    private let token: Data
    private let destination: Data
    private let udp: Bool
    private var headerSent = false
    private var incoming = ByteQueue()

    init(password: String, destinationHost: String, destinationPort: UInt16, udp: Bool) throws {
        guard !password.isEmpty else { throw ProxyError.configuration("Trojan requires a non-empty password") }
        token = Self.token(password)
        destination = try ProxyAddress.socks(destinationHost, destinationPort)
        self.udp = udp
    }

    /// 56 lowercase hex characters of SHA-224(password).
    static func token(_ password: String) -> Data {
        let hex = Array("0123456789abcdef".utf8)
        var token = Data(capacity: SHA224.digestLength * 2)
        for byte in SHA224.hash(password.utf8) {
            token.append(hex[Int(byte >> 4)])
            token.append(hex[Int(byte & 0x0f)])
        }
        return token
    }

    func requestHeader() throws -> Data {
        guard !headerSent else { throw ProxyError.malformed("Trojan header already sent") }
        headerSent = true
        let command: TrojanCommand = udp ? .udpAssociate : .connect
        return token + Self.crlf + Data([command.rawValue]) + destination + Self.crlf
    }

    func encodeDatagram(_ plain: Data) throws -> Data {
        guard udp, headerSent else { throw ProxyError.malformed("Trojan UDP association is not open") }
        guard plain.count <= Self.maxDatagram else { throw ProxyError.bufferLimit }
        return destination + WireBytes.be16(UInt16(plain.count)) + Self.crlf + plain
    }

    /// Server datagrams arrive as a byte stream; returns each complete payload in order.
    func decodeDatagrams(_ received: Data) throws -> [Data] {
        guard udp else { throw ProxyError.malformed("Trojan TCP sessions carry no datagram framing") }
        guard incoming.count + received.count <= 1024 * 1024 else { throw ProxyError.bufferLimit }
        incoming.append(received)
        var output = [Data]()
        while !incoming.isEmpty {
            let head = [UInt8](incoming.prefix(2))
            let address: Int
            switch head[0] {
            case 1: address = 4
            case 4: address = 16
            case 3:
                guard head.count >= 2 else { return output }
                guard head[1] > 0 else { throw ProxyError.malformed("Invalid Trojan UDP domain address") }
                address = 1 + Int(head[1])
            default: throw ProxyError.malformed("Invalid Trojan UDP address type")
            }
            let header = 1 + address + 2 + 2 + 2   // type, address, port, length, CRLF
            guard incoming.count >= header else { break }
            let fields = [UInt8](incoming.prefix(header))
            guard fields[header - 2] == 0x0d, fields[header - 1] == 0x0a else {
                throw ProxyError.malformed("Missing Trojan UDP CRLF")
            }
            let length = Int(fields[header - 4]) << 8 | Int(fields[header - 3])
            guard incoming.count >= header + length else { break }
            _ = incoming.take(header)
            output.append(incoming.take(length))
        }
        return output
    }

    func finishReceiving() throws {
        guard incoming.isEmpty else { throw ProxyError.malformed("The Trojan stream ended within a UDP packet") }
    }
}

extension TrojanSession: ProxySession {
    var usesDatagramSocket: Bool { false }
    func openingBytes() throws -> Data? { try requestHeader() }
    func encode(_ payload: Data) throws -> [Data] { udp ? [try encodeDatagram(payload)] : [payload] }
    func decode(_ received: Data) throws -> [Data] { udp ? try decodeDatagrams(received) : [received] }
    func closingBytes() throws -> Data? { nil }
    func transportEnded() throws { if udp { try finishReceiving() } }
    var remoteEnded: Bool { false }
}
