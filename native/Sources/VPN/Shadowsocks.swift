import Foundation
import CryptoKit

// Original implementation from the public SIP004/SIP007 wire description:
// https://shadowsocks.org/doc/aead.html
// Password expansion is EVP_BytesToKey with MD5, one iteration and no salt.
enum ShadowsocksKeys {
    static func master(password: String, count: Int = 32) -> Data {
        var expanded = Data(); var previous = Data()
        let passwordBytes = Data(password.utf8)
        while expanded.count < count {
            previous = ProtocolCrypto.md5(previous + passwordBytes)
            expanded.append(previous)
        }
        return Data(expanded.prefix(count))
    }
    static func subkey(master: Data, salt: Data) -> Data {
        let derived = HKDF<Insecure.SHA1>.deriveKey(inputKeyMaterial: SymmetricKey(data: master),
                                                   salt: salt, info: Data("ss-subkey".utf8),
                                                   outputByteCount: master.count)
        return derived.withUnsafeBytes { Data($0) }
    }
}

struct ShadowsocksNonce {
    private(set) var bytes = Data(repeating: 0, count: 12)
    private var exhausted = false
    mutating func next() throws -> Data {
        guard !exhausted else { throw ProxyError.nonceExhausted }
        let value = bytes
        var n = [UInt8](bytes)
        var carry = true
        for i in n.indices {
            if !carry { break }
            n[i] &+= 1; carry = n[i] == 0
        }
        exhausted = carry; bytes = Data(n)
        return value
    }
}

final class ShadowsocksSession {
    private let master: Data
    private let destination: Data
    private let udp: Bool
    private var outboundSalt: Data?
    private var outboundKey: Data?
    private var outboundNonce = ShadowsocksNonce()
    private var inboundSalt: Data?
    private var inboundKey: Data?
    private var inboundNonce = ShadowsocksNonce()
    private var saltRegistered = false
    private var incoming = Data()
    private var payloadLength: Int?
    private var headerSent = false

    init(password: String, destinationHost: String, destinationPort: UInt16, udp: Bool) throws {
        master = ShadowsocksKeys.master(password: password)
        destination = try ProxyAddress.socks(destinationHost, destinationPort)
        self.udp = udp
    }

    func requestHeader() throws -> Data {
        guard !udp, !headerSent else { throw ProxyError.malformed("Shadowsocks header already sent") }
        headerSent = true
        return try encodeChunk(destination)
    }

    func encodeStream(_ plain: Data) throws -> [Data] {
        guard !udp, headerSent else { throw ProxyError.malformed("Missing Shadowsocks stream header") }
        var frames = [Data](); var position = 0
        while position < plain.count {
            let end = min(position + 0x3fff, plain.count)
            frames.append(try encodeChunk(Data(plain.dropFirst(position).prefix(end - position))))
            position = end
        }
        return frames
    }

    private func encodeChunk(_ plain: Data) throws -> Data {
        guard plain.count <= 0x3fff else { throw ProxyError.bufferLimit }
        var result = Data()
        if outboundKey == nil {
            let salt = try ProtocolCrypto.random(32)
            try SaltReplayCache.shared.insert(key: master, salt: salt)
            outboundSalt = salt; outboundKey = ShadowsocksKeys.subkey(master: master, salt: salt)
            result.append(salt)
        }
        result.append(try ProtocolCrypto.seal(WireBytes.be16(UInt16(plain.count)), key: outboundKey!,
                                               nonce: outboundNonce.next()))
        result.append(try ProtocolCrypto.seal(plain, key: outboundKey!, nonce: outboundNonce.next()))
        return result
    }

    func decodeStream(_ received: Data) throws -> [Data] {
        guard !udp, incoming.count + received.count <= 1024 * 1024 else { throw ProxyError.bufferLimit }
        incoming.append(received)
        var output = [Data]()
        if inboundKey == nil {
            guard incoming.count >= 32 else { return output }
            let salt = take(32)
            guard salt != outboundSalt else { throw ProxyError.authentication }
            inboundSalt = salt; inboundKey = ShadowsocksKeys.subkey(master: master, salt: salt)
        }
        while true {
            if payloadLength == nil {
                guard incoming.count >= 18 else { break }
                let decoded = try ProtocolCrypto.open(take(18), key: inboundKey!, nonce: inboundNonce.next())
                let length = WireBytes.uint16(decoded)
                guard length <= 0x3fff else { throw ProxyError.malformed("Invalid Shadowsocks chunk length") }
                if !saltRegistered {
                    try SaltReplayCache.shared.insert(key: master, salt: inboundSalt!)
                    saltRegistered = true
                }
                payloadLength = length
            }
            let size = payloadLength!
            guard incoming.count >= size + 16 else { break }
            let plain = try ProtocolCrypto.open(take(size + 16), key: inboundKey!, nonce: inboundNonce.next())
            payloadLength = nil
            if !plain.isEmpty { output.append(plain) }
        }
        return output
    }

    func finishReceiving() throws {
        guard incoming.isEmpty, payloadLength == nil, inboundKey != nil, saltRegistered else {
            throw ProxyError.malformed("The Shadowsocks stream ended before a complete authenticated chunk")
        }
    }

    func encodeDatagram(_ plain: Data) throws -> Data {
        guard udp, plain.count + destination.count + 48 <= 65_507 else { throw ProxyError.bufferLimit }
        let salt = try ProtocolCrypto.random(32)
        try SaltReplayCache.shared.insert(key: master, salt: salt)
        let key = ShadowsocksKeys.subkey(master: master, salt: salt)
        return salt + (try ProtocolCrypto.seal(destination + plain, key: key, nonce: Data(repeating: 0, count: 12)))
    }

    func decodeDatagram(_ packet: Data) throws -> Data {
        guard udp, packet.count >= 48, packet.count <= 65_507 else { throw ProxyError.malformed("Invalid Shadowsocks UDP packet length") }
        let salt = Data(packet.prefix(32))
        let key = ShadowsocksKeys.subkey(master: master, salt: salt)
        let plain = try ProtocolCrypto.open(Data(packet.dropFirst(32)), key: key, nonce: Data(repeating: 0, count: 12))
        try SaltReplayCache.shared.insert(key: master, salt: salt)
        return try ProxyAddress.stripSOCKS(plain)
    }

    private func take(_ count: Int) -> Data {
        let result = Data(incoming.prefix(count))
        incoming = Data(incoming.dropFirst(count))
        return result
    }
}
