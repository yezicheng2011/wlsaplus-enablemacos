import Foundation
import CryptoKit

// Original implementation from the public SIP004/SIP007 wire description:
// https://shadowsocks.org/doc/aead.html
// Password expansion is EVP_BytesToKey with MD5, one iteration and no salt.

/// AEAD methods from SIP004. Key size equals salt size; every method uses a 12-byte
/// little-endian counter nonce and a 16-byte tag.
public enum ShadowsocksCipher: String, CaseIterable {
    case aes128gcm = "aes-128-gcm"
    case aes256gcm = "aes-256-gcm"
    case chacha20poly1305 = "chacha20-ietf-poly1305"

    /// Accepts the common spellings found in subscriptions (case-insensitive).
    public init?(name: String?) {
        switch (name ?? "").lowercased().trimmingCharacters(in: .whitespaces) {
        case "aes-128-gcm": self = .aes128gcm
        case "aes-256-gcm": self = .aes256gcm
        case "chacha20-ietf-poly1305", "chacha20-poly1305": self = .chacha20poly1305
        default: return nil
        }
    }
    var keySize: Int { self == .aes128gcm ? 16 : 32 }
    var saltSize: Int { keySize }

    func seal(_ plain: Data, key: Data, nonce: Data) throws -> Data {
        switch self {
        case .aes128gcm, .aes256gcm: return try ProtocolCrypto.seal(plain, key: key, nonce: nonce)
        case .chacha20poly1305:
            let box = try ChaChaPoly.seal(plain, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: nonce))
            return box.ciphertext + box.tag
        }
    }
    func open(_ encrypted: Data, key: Data, nonce: Data) throws -> Data {
        switch self {
        case .aes128gcm, .aes256gcm: return try ProtocolCrypto.open(encrypted, key: key, nonce: nonce)
        case .chacha20poly1305:
            guard encrypted.count >= 16 else { throw ProxyError.authentication }
            do {
                let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce),
                                                   ciphertext: encrypted.dropLast(16), tag: encrypted.suffix(16))
                return try ChaChaPoly.open(box, using: SymmetricKey(data: key))
            } catch { throw ProxyError.authentication }
        }
    }
}

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
    private let cipher: ShadowsocksCipher
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

    init(password: String, destinationHost: String, destinationPort: UInt16, udp: Bool,
         cipher: ShadowsocksCipher = .aes256gcm) throws {
        guard !password.isEmpty else {
            throw ProxyError.configuration("Shadowsocks requires a non-empty password")
        }
        self.cipher = cipher
        master = ShadowsocksKeys.master(password: password, count: cipher.keySize)
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
            let salt = try ProtocolCrypto.random(cipher.saltSize)
            try SaltReplayCache.shared.insert(key: master, salt: salt)
            outboundSalt = salt; outboundKey = ShadowsocksKeys.subkey(master: master, salt: salt)
            result.append(salt)
        }
        result.append(try cipher.seal(WireBytes.be16(UInt16(plain.count)), key: outboundKey!,
                                               nonce: outboundNonce.next()))
        result.append(try cipher.seal(plain, key: outboundKey!, nonce: outboundNonce.next()))
        return result
    }

    func decodeStream(_ received: Data) throws -> [Data] {
        guard !udp, incoming.count + received.count <= 1024 * 1024 else { throw ProxyError.bufferLimit }
        incoming.append(received)
        var output = [Data]()
        if inboundKey == nil {
            guard incoming.count >= cipher.saltSize else { return output }
            let salt = take(cipher.saltSize)
            guard salt != outboundSalt else { throw ProxyError.authentication }
            inboundSalt = salt; inboundKey = ShadowsocksKeys.subkey(master: master, salt: salt)
        }
        while true {
            if payloadLength == nil {
                guard incoming.count >= 18 else { break }
                let decoded = try cipher.open(take(18), key: inboundKey!, nonce: inboundNonce.next())
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
            let plain = try cipher.open(take(size + 16), key: inboundKey!, nonce: inboundNonce.next())
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
        guard udp, plain.count + destination.count + cipher.saltSize + 16 <= 65_507 else { throw ProxyError.bufferLimit }
        let salt = try ProtocolCrypto.random(cipher.saltSize)
        try SaltReplayCache.shared.insert(key: master, salt: salt)
        let key = ShadowsocksKeys.subkey(master: master, salt: salt)
        return salt + (try cipher.seal(destination + plain, key: key, nonce: Data(repeating: 0, count: 12)))
    }

    func decodeDatagram(_ packet: Data) throws -> Data {
        guard udp, packet.count >= cipher.saltSize + 16, packet.count <= 65_507 else { throw ProxyError.malformed("Invalid Shadowsocks UDP packet length") }
        let salt = Data(packet.prefix(cipher.saltSize))
        let key = ShadowsocksKeys.subkey(master: master, salt: salt)
        let plain = try cipher.open(Data(packet.dropFirst(cipher.saltSize)), key: key, nonce: Data(repeating: 0, count: 12))
        try SaltReplayCache.shared.insert(key: master, salt: salt)
        return try ProxyAddress.stripSOCKS(plain)
    }

    private func take(_ count: Int) -> Data {
        let result = Data(incoming.prefix(count))
        incoming = Data(incoming.dropFirst(count))
        return result
    }
}
