import Foundation

// Original implementation from the public protocol description:
// https://xtls.github.io/development/protocols/vless.html
// Request:  version 0 | UUID (16) | addons length | addons | command | port | address
// Response: version 0 | addons length | addons, then payload. VLESS itself does not encrypt;
// it relies on the security layer beneath it (TLS, or Reality). UDP packets travel inside the
// stream as length (2, big-endian) | payload in both directions.

enum VLESSCommand: UInt8 {
    case tcp = 0x01
    case udp = 0x02
}

final class VLESSSession {
    static let maxDatagram = 65_535
    private let request: Data
    private let udp: Bool
    private var headerSent = false
    private var responseHeaderDone = false
    private var incoming = ByteQueue()

    init(uuid: String, destinationHost: String, destinationPort: UInt16, udp: Bool) throws {
        guard let parsed = UUID(uuidString: uuid) else { throw ProxyError.configuration("Invalid VLESS UUID") }
        var identity = parsed.uuid
        let id = withUnsafeBytes(of: &identity) { Data($0) }
        let target = try ProxyAddress.bytes(destinationHost)
        // VLESS numbers address types 1 = IPv4, 2 = domain, 3 = IPv6 (SOCKS uses 1, 3, 4).
        let kind: UInt8 = target.kind == 3 ? 2 : (target.kind == 4 ? 3 : 1)
        let command: VLESSCommand = udp ? .udp : .tcp
        // No addons: flow control (e.g. xtls-rprx-vision) is not negotiated.
        request = Data([0]) + id + Data([0, command.rawValue]) + WireBytes.be16(destinationPort)
            + Data([kind]) + target.address
        self.udp = udp
    }

    func requestHeader() throws -> Data {
        guard !headerSent else { throw ProxyError.malformed("VLESS header already sent") }
        headerSent = true
        return request
    }

    func encodeDatagram(_ plain: Data) throws -> Data {
        guard udp, headerSent else { throw ProxyError.malformed("VLESS UDP association is not open") }
        guard plain.count <= Self.maxDatagram else { throw ProxyError.bufferLimit }
        return WireBytes.be16(UInt16(plain.count)) + plain
    }

    /// Strips the response header, then returns stream bytes (TCP) or whole datagrams (UDP).
    func decodeResponse(_ received: Data) throws -> [Data] {
        guard incoming.count + received.count <= 1024 * 1024 else { throw ProxyError.bufferLimit }
        incoming.append(received)
        if !responseHeaderDone {
            guard incoming.count >= 2 else { return [] }
            let head = [UInt8](incoming.prefix(2))
            guard head[0] == 0 else { throw ProxyError.malformed("Unsupported VLESS response version") }
            guard incoming.count >= 2 + Int(head[1]) else { return [] }
            _ = incoming.take(2 + Int(head[1]))   // addons are informational; none are negotiated
            responseHeaderDone = true
        }
        if !udp { return incoming.isEmpty ? [] : [incoming.take(incoming.count)] }
        var packets = [Data]()
        while incoming.count >= 2 {
            let length = WireBytes.uint16(incoming.prefix(2))
            guard incoming.count >= 2 + length else { break }
            _ = incoming.take(2)
            packets.append(incoming.take(length))
        }
        return packets
    }

    func finishReceiving() throws {
        guard responseHeaderDone || incoming.isEmpty else {
            throw ProxyError.malformed("The VLESS stream ended within its response header")
        }
        guard incoming.isEmpty else { throw ProxyError.malformed("The VLESS stream ended within a UDP packet") }
    }
}

extension VLESSSession: ProxySession {
    var usesDatagramSocket: Bool { false }
    func openingBytes() throws -> Data? { try requestHeader() }
    func encode(_ payload: Data) throws -> [Data] { udp ? [try encodeDatagram(payload)] : [payload] }
    func decode(_ received: Data) throws -> [Data] { try decodeResponse(received) }
    func closingBytes() throws -> Data? { nil }
    func transportEnded() throws { try finishReceiving() }
    var remoteEnded: Bool { false }
}
