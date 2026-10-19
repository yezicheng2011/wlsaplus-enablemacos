import Foundation
import CryptoKit
import CommonCrypto

// Original implementation derived from published protocol descriptions, not a proxy core:
// https://www.v2fly.org/en_US/developer/protocols/vmess.html
// https://www.v2fly.org/config/protocols/vmess.html
// The latter defines alterId=0 as AEAD, >0 as legacy. The primary UUID is used
// as the authentication ID; alter IDs are optional additional accepted identities.
// Standard format (S=1), AES-128-GCM security=3. Optional masking/padding,
// authenticated-length experiments and multiplexing are deliberately not negotiated.

enum VMessCrypto {
    static let commandSalt = Data("c48619fe-8f02-49e0-b9e9-edf763e17e21".utf8)

    /// VMess KDF nests HMAC hash constructors. It is not repeated ordinary HMAC.
    static func kdf(_ key: Data, _ path: [Data]) -> Data {
        var hash: (Data) -> Data = ProtocolCrypto.sha256
        for component in [Data("VMess AEAD KDF".utf8)] + path {
            let innerHash = hash
            hash = { message in hmac(key: component, message: message, hash: innerHash) }
        }
        return hash(key)
    }
    static func derive(_ key: Data, _ label: String, _ count: Int,
                       extra: [Data] = []) -> Data {
        Data(kdf(key, [Data(label.utf8)] + extra).prefix(count))
    }
    private static func hmac(key: Data, message: Data, hash: (Data) -> Data) -> Data {
        var k = key.count > 64 ? hash(key) : key
        if k.count < 64 { k.append(Data(repeating: 0, count: 64 - k.count)) }
        let inner = Data(k.map { $0 ^ 0x36 })
        let outer = Data(k.map { $0 ^ 0x5c })
        return hash(outer + hash(inner + message))
    }
    static func fnv1a(_ data: Data) -> UInt32 {
        data.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
    }
    static func crc32(_ data: Data) -> UInt32 {
        var crc = UInt32.max
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = (crc >> 1) ^ ((crc & 1) == 1 ? 0xedb88320 : 0) }
        }
        return ~crc
    }
    static func aesBlock(_ block: Data, key: Data) throws -> Data {
        guard key.count == 16, block.count == 16 else { throw ProxyError.authentication }
        var result = [UInt8](repeating: 0, count: 32)
        var written = 0
        let status = key.withUnsafeBytes { keyPointer in
            block.withUnsafeBytes { blockPointer in
                CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionECBMode),
                        keyPointer.baseAddress, 16, nil, blockPointer.baseAddress, 16,
                        &result, 32, &written)
            }
        }
        guard status == kCCSuccess, written == 16 else { throw ProxyError.authentication }
        return Data(result.prefix(written))
    }
    static func uuidBytes(_ string: String) throws -> Data {
        guard let uuid = UUID(uuidString: string) else { throw ProxyError.configuration("Invalid VMess UUID") }
        var value = uuid.uuid
        return withUnsafeBytes(of: &value) { Data($0) }
    }
}

/// CFB128 preserves state across partial header reads. AES itself is the system primitive.
final class AESCFB128 {
    private let key: Data
    private let decrypt: Bool
    private var feedback: [UInt8]
    private var stream = [UInt8](repeating: 0, count: 16)
    private var index = 0
    init(key: Data, iv: Data, decrypt: Bool) throws {
        guard key.count == 16, iv.count == 16 else { throw ProxyError.authentication }
        self.key = key; feedback = [UInt8](iv); self.decrypt = decrypt
    }
    func update(_ input: Data) throws -> Data {
        var output = Data(); output.reserveCapacity(input.count)
        for byte in input {
            if index == 0 { stream = [UInt8](try VMessCrypto.aesBlock(Data(feedback), key: key)) }
            let converted = byte ^ stream[index]
            output.append(converted)
            feedback[index] = decrypt ? byte : converted
            index = (index + 1) & 15
        }
        return output
    }
}

final class VMessSession {
    private let commandKey: Data
    private let identity: Data
    private let aead: Bool
    private let udp: Bool
    private let address: Data
    private let requestIV: Data
    private let requestKey: Data
    private let responseIV: Data
    private let responseKey: Data
    private let responseAuth: UInt8
    private var requestCount: UInt32 = 0
    private var responseCount: UInt32 = 0
    private var headerSent = false
    private var requestEnded = false
    private var incoming = Data()
    private var responseHeaderLength: Int?
    private var legacyResponseCipher: AESCFB128?
    private var legacyResponseHeader = Data()
    private var responseHeaderComplete = false
    private var payloadLength: Int?
    private(set) var responseEnded = false

    init(uuid: String, alterId: Int = 0, destinationHost: String, destinationPort: UInt16,
         udp: Bool, requestIV: Data? = nil, requestKey: Data? = nil,
         responseAuth: UInt8? = nil) throws {
        guard (0...65535).contains(alterId) else { throw ProxyError.configuration("Invalid VMess alterId") }
        identity = try VMessCrypto.uuidBytes(uuid)
        commandKey = ProtocolCrypto.md5(identity + VMessCrypto.commandSalt)
        aead = alterId == 0; self.udp = udp
        let target = try ProxyAddress.bytes(destinationHost)
        let kind: UInt8 = target.kind == 3 ? 2 : (target.kind == 4 ? 3 : 1)
        address = WireBytes.be16(destinationPort) + Data([kind]) + target.address
        self.requestIV = try requestIV ?? ProtocolCrypto.random(16)
        self.requestKey = try requestKey ?? ProtocolCrypto.random(16)
        self.responseAuth = try responseAuth ?? ProtocolCrypto.random(1).first!
        guard self.requestIV.count == 16, self.requestKey.count == 16 else { throw ProxyError.authentication }
        responseIV = aead ? Data(ProtocolCrypto.sha256(self.requestIV).prefix(16)) : ProtocolCrypto.md5(self.requestIV)
        responseKey = aead ? Data(ProtocolCrypto.sha256(self.requestKey).prefix(16)) : ProtocolCrypto.md5(self.requestKey)
        if !aead { legacyResponseCipher = try AESCFB128(key: responseKey, iv: responseIV, decrypt: true) }
    }

    func requestHeader(timestamp: UInt64? = nil,
                       authRandom: Data? = nil, nonce: Data? = nil) throws -> Data {
        guard !headerSent else { throw ProxyError.malformed("VMess header already sent") }
        headerSent = true
        var command = Data([1]) + requestIV + requestKey
        command.append(contentsOf: [responseAuth, 0x01, 0x03, 0, udp ? 0x02 : 0x01])
        command.append(address)
        command.append(WireBytes.be32(VMessCrypto.fnv1a(command)))
        let now = Int64(Date().timeIntervalSince1970)
        // Legacy authentication permits a randomly chosen time within +/-30 seconds.
        // Rejection sampling avoids bias; all entropy comes from Security.framework.
        let selectedTime: UInt64
        if let timestamp { selectedTime = timestamp }
        else if aead { selectedTime = UInt64(max(0, now)) }
        else {
            var value = try ProtocolCrypto.random(1).first!
            while value >= 244 { value = try ProtocolCrypto.random(1).first! }
            selectedTime = UInt64(max(0, now + Int64(value % 61) - 30))
        }
        let time = WireBytes.be64(selectedTime)
        if !aead {
            let token = Data(HMAC<Insecure.MD5>.authenticationCode(for: time, using: SymmetricKey(data: identity)))
            let iv = ProtocolCrypto.md5(time + time + time + time)
            let cipher = try AESCFB128(key: commandKey, iv: iv, decrypt: false)
            return token + (try cipher.update(command))
        }
        let random = try authRandom ?? ProtocolCrypto.random(4)
        let headerNonce = try nonce ?? ProtocolCrypto.random(8)
        guard random.count == 4, headerNonce.count == 8 else { throw ProxyError.authentication }
        var authID = time + random
        authID.append(WireBytes.be32(VMessCrypto.crc32(authID)))
        let encryptedID = try VMessCrypto.aesBlock(authID, key: VMessCrypto.derive(commandKey, "AES Auth ID Encryption", 16))
        let extra = [encryptedID, headerNonce]
        let length = try ProtocolCrypto.seal(WireBytes.be16(UInt16(command.count)),
                                             key: VMessCrypto.derive(commandKey, "VMess Header AEAD Key_Length", 16, extra: extra),
                                             nonce: VMessCrypto.derive(commandKey, "VMess Header AEAD Nonce_Length", 12, extra: extra), aad: encryptedID)
        let header = try ProtocolCrypto.seal(command,
                                             key: VMessCrypto.derive(commandKey, "VMess Header AEAD Key", 16, extra: extra),
                                             nonce: VMessCrypto.derive(commandKey, "VMess Header AEAD Nonce", 12, extra: extra), aad: encryptedID)
        return encryptedID + length + headerNonce + header
    }

    func encodeBody(_ plain: Data) throws -> [Data] {
        guard headerSent, !requestEnded else { throw ProxyError.malformed("VMess request is not writable") }
        let maxPlain = 0x4000 - 16
        if udp {
            guard !plain.isEmpty else { throw ProxyError.unsupported("VMess standard framing cannot represent an empty UDP datagram") }
            guard plain.count <= maxPlain else { throw ProxyError.bufferLimit }
        }
        var result = [Data](); var position = 0
        while position < plain.count {
            let count = min(maxPlain, plain.count - position)
            let payload = Data(plain.dropFirst(position).prefix(count))
            let encrypted = try ProtocolCrypto.seal(payload, key: requestKey,
                                                     nonce: bodyNonce(iv: requestIV, counter: requestCount))
            requestCount += 1
            result.append(WireBytes.be16(UInt16(encrypted.count)) + encrypted)
            position += count
        }
        return result
    }

    func finishWriting() throws -> Data {
        guard headerSent, !requestEnded else { throw ProxyError.closed }
        let terminator = try ProtocolCrypto.seal(Data(), key: requestKey,
                                                  nonce: bodyNonce(iv: requestIV, counter: requestCount))
        requestCount += 1; requestEnded = true
        return WireBytes.be16(UInt16(terminator.count)) + terminator
    }

    func decodeResponse(_ received: Data) throws -> [Data] {
        guard !responseEnded || received.isEmpty else { throw ProxyError.malformed("Data after VMess termination") }
        guard incoming.count + received.count <= 1024 * 1024 else { throw ProxyError.bufferLimit }
        incoming.append(received)
        if !responseHeaderComplete {
            guard try decodeHeader() else { return [] }
        }
        var result = [Data]()
        while !responseEnded {
            if payloadLength == nil {
                guard incoming.count >= 2 else { break }
                let length = WireBytes.uint16(take(2))
                guard (16...0x4000).contains(length) else { throw ProxyError.malformed("Invalid VMess body length") }
                payloadLength = length
            }
            guard incoming.count >= payloadLength! else { break }
            let packet = take(payloadLength!)
            let plain = try ProtocolCrypto.open(packet, key: responseKey,
                                                 nonce: bodyNonce(iv: responseIV, counter: responseCount))
            responseCount += 1; payloadLength = nil
            if plain.isEmpty {
                responseEnded = true
                guard incoming.isEmpty else { throw ProxyError.malformed("Data after VMess termination") }
            } else { result.append(plain) }
        }
        return result
    }

    private func decodeHeader() throws -> Bool {
        let header: Data
        if aead {
            if responseHeaderLength == nil {
                guard incoming.count >= 18 else { return false }
                let length = try ProtocolCrypto.open(take(18),
                    key: VMessCrypto.derive(responseKey, "AEAD Resp Header Len Key", 16),
                    nonce: VMessCrypto.derive(responseIV, "AEAD Resp Header Len IV", 12))
                let count = WireBytes.uint16(length)
                guard (4...1024).contains(count) else { throw ProxyError.malformed("Invalid VMess response header length") }
                responseHeaderLength = count
            }
            guard incoming.count >= responseHeaderLength! + 16 else { return false }
            header = try ProtocolCrypto.open(take(responseHeaderLength! + 16),
                key: VMessCrypto.derive(responseKey, "AEAD Resp Header Key", 16),
                nonce: VMessCrypto.derive(responseIV, "AEAD Resp Header IV", 12))
        } else {
            if legacyResponseHeader.count < 4 {
                let count = min(4 - legacyResponseHeader.count, incoming.count)
                if count > 0 { legacyResponseHeader.append(try legacyResponseCipher!.update(take(count))) }
                guard legacyResponseHeader.count == 4 else { return false }
                let h = [UInt8](legacyResponseHeader)
                guard h[0] == responseAuth else { throw ProxyError.authentication }
                responseHeaderLength = 4 + Int(h[3])
            }
            let need = responseHeaderLength! - legacyResponseHeader.count
            if need > 0 {
                let count = min(need, incoming.count)
                if count > 0 { legacyResponseHeader.append(try legacyResponseCipher!.update(take(count))) }
            }
            guard legacyResponseHeader.count == responseHeaderLength! else { return false }
            header = legacyResponseHeader
        }
        let h = [UInt8](header)
        guard h.count >= 4, h[0] == responseAuth else { throw ProxyError.authentication }
        guard h.count == 4 + Int(h[3]), h[1] & 0xfe == 0,
              (h[2] == 0 && h[3] == 0) || (h[2] == 1 && h[3] == 23) else {
            throw ProxyError.malformed("Unsupported VMess response command")
        }
        // Dynamic-port advice can be ignored: this connection retains its original endpoint.
        responseHeaderComplete = true; legacyResponseCipher = nil
        return true
    }

    func finishReceiving() throws {
        guard responseHeaderComplete, incoming.isEmpty, payloadLength == nil else {
            throw ProxyError.malformed("The VMess stream ended within a header or authenticated chunk")
        }
    }

    private func bodyNonce(iv: Data, counter: UInt32) throws -> Data {
        guard counter <= UInt16.max else { throw ProxyError.nonceExhausted }
        return WireBytes.be16(UInt16(counter)) + Data(iv.dropFirst(2).prefix(10))
    }
    private func take(_ count: Int) -> Data {
        let result = Data(incoming.prefix(count)); incoming = Data(incoming.dropFirst(count)); return result
    }
}
