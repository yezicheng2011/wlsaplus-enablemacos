import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
#if canImport(Security)
import Security
#endif
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// Portable model and wire helpers: no Network.framework, so they also build on Linux
// with swift-crypto for local and CI unit tests.

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
    /// VLESS flow control (e.g. xtls-rprx-vision); only the plain flow is supported today.
    public var flow: String?

    public init(id: String, name: String, type: String, server: String, port: UInt16,
                cipher: String? = nil, password: String? = nil, uuid: String? = nil,
                alterId: Int? = nil, tls: Bool? = nil, serverName: String? = nil,
                skipCertVerify: Bool? = nil, network: String? = nil,
                wsPath: String? = nil, wsHost: String? = nil, udp: Bool? = nil, flow: String? = nil) {
        self.id = id; self.name = name; self.type = type; self.server = server; self.port = port
        self.cipher = cipher; self.password = password; self.uuid = uuid; self.alterId = alterId
        self.tls = tls; self.serverName = serverName; self.skipCertVerify = skipCertVerify
        self.network = network; self.wsPath = wsPath; self.wsHost = wsHost; self.udp = udp
        self.flow = flow
    }

    /// Trojan defaults to TLS, so subscriptions often leave `tls` unset for it; an explicit
    /// `tls: false` selects plaintext for servers behind a TLS-terminating proxy or on loopback.
    var usesTLS: Bool { tls ?? (type.lowercased() == "trojan") }

    public func validate() throws {
        guard !server.isEmpty, !server.contains(where: { $0.isWhitespace || $0.isNewline }),
              port != 0 else { throw ProxyError.configuration("Missing server address or port") }
        guard skipCertVerify != true else {
            throw ProxyError.unsupported("Disabling TLS certificate verification is not supported")
        }
        switch type.lowercased() {
        case "ss", "shadowsocks":
            guard ShadowsocksCipher(name: cipher) != nil, password != nil else {
                throw ProxyError.unsupported("Shadowsocks requires a password and one of aes-128-gcm, aes-256-gcm, chacha20-ietf-poly1305")
            }
            guard ["tcp", "ws"].contains((network ?? "tcp").lowercased()) else {
                throw ProxyError.unsupported("Shadowsocks requires TCP or WebSocket transport")
            }
        case "vmess":
            guard UUID(uuidString: uuid ?? "") != nil else {
                throw ProxyError.configuration("VMess requires a valid UUID")
            }
            guard (0...65535).contains(alterId ?? 0) else {
                throw ProxyError.configuration("VMess alterId must be in 0...65535")
            }
            guard VMessSecurity(name: cipher) != nil else {
                throw ProxyError.unsupported("This VMess implementation supports auto, aes-128-gcm and chacha20-poly1305")
            }
            guard ["tcp", "ws"].contains((network ?? "tcp").lowercased()) else {
                throw ProxyError.unsupported("VMess requires TCP or WebSocket transport")
            }
        case "vless":
            guard UUID(uuidString: uuid ?? "") != nil else {
                throw ProxyError.configuration("VLESS requires a valid UUID")
            }
            guard (cipher ?? "none").lowercased() == "none" || cipher == "" else {
                throw ProxyError.unsupported("VLESS encryption must be none; use TLS for transport security")
            }
            guard (flow ?? "").isEmpty else {
                throw ProxyError.unsupported("VLESS flow control (e.g. xtls-rprx-vision) is not supported")
            }
            guard ["tcp", "ws"].contains((network ?? "tcp").lowercased()) else {
                throw ProxyError.unsupported("VLESS requires TCP or WebSocket transport")
            }
        case "trojan":
            guard let password, !password.isEmpty else {
                throw ProxyError.configuration("Trojan requires a non-empty password")
            }
            guard ["tcp", "ws"].contains((network ?? "tcp").lowercased()) else {
                throw ProxyError.unsupported("Trojan requires TCP or WebSocket transport")
            }
        default: throw ProxyError.unsupported("Unsupported proxy protocol")
        }
    }
}

public enum ProxyError: LocalizedError {
    case configuration(String), unsupported(String), malformed(String), dial(String)
    case authentication, nonceExhausted, bufferLimit, randomness, closed, timeout
    public var errorDescription: String? {
        switch self {
        case .configuration(let reason), .unsupported(let reason), .malformed(let reason), .dial(let reason):
            return reason
        case .authentication: return "The proxy response failed authentication"
        case .nonceExhausted: return "The encrypted session reached its nonce limit; reconnect"
        case .bufferLimit: return "The proxy exceeded its bounded buffering limit"
        case .randomness: return "The system could not generate secure random bytes"
        case .closed: return "The proxy connection is closed"
        case .timeout: return "The proxy connection timed out"
        }
    }
}

enum ProtocolCrypto {
    static func random(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        #if canImport(Security)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { throw ProxyError.randomness }
        #else
        var generator = SystemRandomNumberGenerator()   // getrandom(2) on Linux
        for index in bytes.indices { bytes[index] = generator.next() }
        #endif
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

/// Receive buffer consumed from the front. Reads advance an offset instead of recopying the
/// remainder; consumed bytes are reclaimed on append once they are at least half the storage,
/// so total copying stays linear in the bytes received.
struct ByteQueue {
    private var storage = Data()
    private var start = 0
    var count: Int { storage.count - start }
    var isEmpty: Bool { count == 0 }

    mutating func append(_ data: Data) {
        if start > 0, start >= storage.count / 2 {
            storage = Data(storage.dropFirst(start)); start = 0
        }
        storage.append(data)
    }
    func prefix(_ length: Int) -> Data {
        let from = storage.startIndex + start
        return Data(storage[from..<(from + min(length, count))])
    }
    mutating func take(_ length: Int) -> Data {
        let result = prefix(length)
        start += result.count
        if start == storage.count { storage.removeAll(keepingCapacity: true); start = 0 }
        return result
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
