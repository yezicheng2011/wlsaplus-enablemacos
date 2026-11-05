import Foundation
#if canImport(MockMiniVPN)   // SwiftPM builds the library as its own module
@testable import MockMiniVPN
#endif

// The password, UUID, keys and addresses here are public examples, never live credentials.
// CFB fixtures: NIST SP 800-38A F.3.13 (CFB128-AES128).
// WebSocket fixtures: RFC6455 sections 1.3 and 5.7.
// Wire fixtures were independently calculated with Python hashlib/hmac/zlib and
// cryptography 46 (OpenSSL), using only the linked public wire descriptions in Sources/VPN.
// These tests intentionally include fixed ciphertext, partial input, truncation and tampering.
enum ProtocolTests {
    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }
    static func run() throws {
        try primitiveVectors()
        try shadowsocksFrames()
        try shadowsocksCipherFrames()
        try aes128Vectors()
        try vmessPrimitives()
        try vmessFrames()
        try vmessChaChaFrames()
        try vmessCounterWrap()
        try sha224Vectors()
        try trojanFrames()
        try vlessFrames()
        try byteQueue()
        try streamCoalescing()
        try websocketFrames()
        try configurationValidation()
        try transportPlans()
        #if canImport(Network)
        try endpointResolver()
        #endif
    }
    private static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(description: message) }
    }
    private static func fails(_ message: String, _ operation: () throws -> Void) throws {
        do { try operation() } catch { return }
        throw Failure(description: "Expected rejection: \(message)")
    }
    private static func hex(_ string: String) -> Data {
        let bytes = Array(string.utf8)
        precondition(bytes.count % 2 == 0)
        func digit(_ c: UInt8) -> UInt8 { c <= 57 ? c - 48 : c - 87 }
        return Data(stride(from: 0, to: bytes.count, by: 2).map { digit(bytes[$0]) * 16 + digit(bytes[$0 + 1]) })
    }
    private static let iv = Data((0..<16).map(UInt8.init))
    private static let key = Data((16..<32).map(UInt8.init))
    private static let user = "de305d54-75b4-431b-adb2-eb6b9e546014"
    private static let legacyRequest = "5e47a5ab744b87b3cbeffd8e6cbc906b153bb895fd69fdf57afdb47022206f14997fd7ddb340ceb3ed9aebc6aa44c71725ec1eff8a49d2b0c432ae0f9d78689d9dd26fddf7a8e9dc2b"
    private static let aeadRequest = "0fadc0039741be1da55e11960db326ed2dbba3205532edc48d4f97eb951073d8443a05060708090a0b0caff7359c252a748a975d305d497b1f5bb39dbaa569c658420d48a48ddf8a0313f7722989aab385c46df3aa7c114a574fd8cac35b37584be440869123734c15fd65bacb745eb20fe2e7"
    private static let legacyResponse = "372343ca001bf4ed1713b9a1260e529322a5d961a78ad6e701da79894f0f070cc2"
    private static let aeadResponse = "9bdfb1639712b6a6348d0087b8d1af379ecf70afb5ebb377066e79586918c758b5afc6888061001b68cc48dfb6926c9b8578536f70bb9b275176172298c968c53660b9"

    private static func primitiveVectors() throws {
        try check(ShadowsocksKeys.master(password: "password") == hex("5f4dcc3b5aa765d61d8327deb882cf992b95990a9151374abd8ff8c5a7a0fe08"), "SS EVP_BytesToKey MD5")
        let subkey = ShadowsocksKeys.subkey(master: ShadowsocksKeys.master(password: "password"), salt: Data((0..<32).map(UInt8.init)))
        try check(subkey == hex("ee187aed3f87574907a39db98606f60a526114831288097cac66054b33a9464f"), "SS HKDF-SHA1")
        var counter = ShadowsocksNonce()
        try check(try counter.next() == Data(repeating: 0, count: 12), "SS starts at nonce zero")
        try check(try counter.next() == Data([1]) + Data(repeating: 0, count: 11), "SS uses little-endian nonce increments")
        for _ in 0..<254 { _ = try counter.next() }
        try check(try counter.next() == Data([0, 1]) + Data(repeating: 0, count: 10), "SS nonce carries")
    }

    private static func shadowsocksFrames() throws {
        let session = try ShadowsocksSession(password: "password", destinationHost: "example.com", destinationPort: 443, udp: false)
        _ = try session.requestHeader()
        let vector = hex("101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f22acedaffb0442488d2de33c2acde6b0e73571b220d3e5d067c80ae6a991cac0f2134ce247408dc72fb5894333b4bb37bd303c6516451297a1f2c822cc399080e0b5a5f5bbe676d4675044ef")
        var decoded = [Data]()
        for byte in vector { decoded += try session.decodeStream(Data([byte])) }
        try check(decoded == [Data("hello".utf8), Data("bye".utf8)], "SS independently encrypted stream split at every byte")
        try session.finishReceiving()
        let replay = try ShadowsocksSession(password: "password", destinationHost: "example.com", destinationPort: 443, udp: false)
        try fails("SS replayed TCP salt") { _ = try replay.decodeStream(vector) }
        let truncated = try ShadowsocksSession(password: "truncated", destinationHost: "example.com", destinationPort: 443, udp: false)
        _ = try truncated.decodeStream(Data(repeating: 1, count: 31))
        try fails("SS partial salt at EOF") { try truncated.finishReceiving() }
        let altered = try ShadowsocksSession(password: "password", destinationHost: "example.com", destinationPort: 443, udp: false)
        var corrupted = vector; corrupted[40] ^= 1
        try fails("SS length authentication") { _ = try altered.decodeStream(corrupted) }
        let datagrams = try ShadowsocksSession(password: "password", destinationHost: "192.0.2.1", destinationPort: 53, udp: true)
        let packet = hex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f652dd5858fa7fb9e8773b3c9d4b33ac1b1c37c9d6f486d98b8f0")
        try check(try datagrams.decodeDatagram(packet) == Data("dns".utf8), "SS UDP independent wire fixture")
        try fails("SS replayed UDP salt") { _ = try datagrams.decodeDatagram(packet) }
        var badPacket = packet; badPacket[badPacket.count - 1] ^= 1
        try fails("SS tampered UDP tag") { _ = try datagrams.decodeDatagram(badPacket) }
        let reflected = try datagrams.encodeDatagram(Data("query".utf8))
        try fails("SS reflected outgoing UDP packet") { _ = try datagrams.decodeDatagram(reflected) }
        try fails("SS oversized UDP packet") { _ = try datagrams.encodeDatagram(Data(repeating: 0, count: 65_507)) }
        try fails("SS invalid UDP address") { _ = try ProxyAddress.stripSOCKS(hex("0300")) }
        try check(try ProxyAddress.socks("2001:db8::1", 443).count == 19, "IPv6 address encoding")
    }

    // aes-128-gcm and chacha20-ietf-poly1305 fixtures: Python cryptography 43 (OpenSSL),
    // generator verified against the aes-256-gcm fixtures above. Distinct passwords keep the
    // process-wide salt replay cache from colliding with other fixtures.
    private static func shadowsocksCipherFrames() throws {
        let cases: [(ShadowsocksCipher, String, String, String)] = [
            (.aes128gcm, "mockmini-aes128",
             "101112131415161718191a1b1c1d1e1fea725cfab8ac4bb49d780d4f3b184f2f02228bc49a361d48e7e600e83e5f450ddb3c1ce9ba5f430e148ebef328801ad2c97ec805e8fa827050d4cb408a963cc242ff9842dad58b463c4ac630",
             "202122232425262728292a2b2c2d2e2ffad7c10a16b0ade7ee35265f27863f467a27c5602edce1ba1131"),
            (.chacha20poly1305, "mockmini-chacha",
             "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f41c9f5d76cbe27348e4edafa9fb2bcccdf5864973341633a3ce29005d1198176a0b1b30bc46040765db84f52eb0504c3c75a39842b8e528c95d37e91b3a33127a8f616a46f3d584596c8026a",
             "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3fc018e2f48dd5674861fe247e9974e7279eadbcfc5602db9b26b2"),
        ]
        try check(ShadowsocksKeys.master(password: "mockmini-aes128", count: 16) == hex("88ff720dcec21d15a48a267f945a2cb9"), "SS 16-byte EVP_BytesToKey")
        try check(ShadowsocksKeys.subkey(master: hex("88ff720dcec21d15a48a267f945a2cb9"), salt: Data((0..<16).map(UInt8.init))) == hex("7705848c18c6b4977467cf850f9bcfc2"), "SS 16-byte HKDF-SHA1 subkey")
        for (cipher, password, tcp, udp) in cases {
            let name = cipher.rawValue
            let vector = hex(tcp)
            try fails("SS \(name) tampered payload tag") {
                let fresh = try ShadowsocksSession(password: password, destinationHost: "example.com", destinationPort: 443, udp: false, cipher: cipher)
                var bad = vector; bad[cipher.saltSize + 2] ^= 1
                _ = try fresh.decodeStream(bad)
            }
            let session = try ShadowsocksSession(password: password, destinationHost: "example.com", destinationPort: 443, udp: false, cipher: cipher)
            let header = try session.requestHeader()
            try check(header.count == cipher.saltSize + 18 + 15 + 16, "SS \(name) outbound salt size")
            var decoded = [Data]()
            for byte in vector { decoded += try session.decodeStream(Data([byte])) }
            try check(decoded == [Data("hello".utf8), Data("bye".utf8)], "SS \(name) stream split at every byte")
            try session.finishReceiving()
            let large = try session.encodeStream(Data(repeating: 9, count: 40_000))
            try check(large.count == 3 && large[0].count == 18 + 0x3fff + 16, "SS \(name) bounded chunking")
            let datagrams = try ShadowsocksSession(password: password, destinationHost: "192.0.2.1", destinationPort: 53, udp: true, cipher: cipher)
            try check(try datagrams.decodeDatagram(hex(udp)) == Data("dns".utf8), "SS \(name) UDP fixture")
            try fails("SS \(name) replayed UDP salt") { _ = try datagrams.decodeDatagram(hex(udp)) }
            let outgoing = try datagrams.encodeDatagram(Data("q".utf8))
            try check(outgoing.count == cipher.saltSize + 7 + 1 + 16, "SS \(name) UDP packet layout")
            let wrong = try ShadowsocksSession(password: password, destinationHost: "192.0.2.1", destinationPort: 53, udp: true,
                                               cipher: cipher == .aes128gcm ? .aes256gcm : .aes128gcm)
            try fails("SS \(name) packet rejected under another cipher") { _ = try wrong.decodeDatagram(outgoing) }
        }
        for spelling in ["aes-128-gcm", "AES-256-GCM", "chacha20-ietf-poly1305", "chacha20-poly1305"] {
            let node = ProxyNode(id: "ss", name: "SS", type: "ss", server: "example.com", port: 8388,
                                 cipher: spelling, password: "secret")
            try node.validate()
        }
        for spelling in ["rc4-md5", "aes-256-cfb", "2022-blake3-aes-128-gcm", "none", ""] {
            let node = ProxyNode(id: "ss", name: "SS", type: "ss", server: "example.com", port: 8388,
                                 cipher: spelling, password: "secret")
            try fails("Unsupported Shadowsocks cipher \(spelling)") { try node.validate() }
        }
    }

    private static func aes128Vectors() throws {
        // FIPS 197 appendix C.1 and appendix B, plus NIST SP 800-38A F.1.1 ECB-AES128 (4 blocks).
        try check(try VMessCrypto.aesBlock(hex("00112233445566778899aabbccddeeff"), key: hex("000102030405060708090a0b0c0d0e0f"))
                  == hex("69c4e0d86a7b0430d8cdb78070b4c55a"), "FIPS 197 C.1 AES-128")
        try check(try VMessCrypto.aesBlock(hex("3243f6a8885a308d313198a2e0370734"), key: hex("2b7e151628aed2a6abf7158809cf4f3c"))
                  == hex("3925841d02dc09fbdc118597196a0b32"), "FIPS 197 appendix B AES-128")
        let ecbKey = hex("2b7e151628aed2a6abf7158809cf4f3c")
        let plain = ["6bc1bee22e409f96e93d7e117393172a", "ae2d8a571e03ac9c9eb76fac45af8e51",
                     "30c81c46a35ce411e5fbc1191a0a52ef", "f69f2445df4f9b17ad2b417be66c3710"]
        let cipher = ["3ad77bb40d7a3660a89ecaf32466ef97", "f5d3d58503b9699de785895a96fdbaaf",
                      "43b1cd7f598ece23881b00e3ed030688", "7b0c785e27e8ad3f8223207104725dd4"]
        for (p, c) in zip(plain, cipher) {
            try check(try VMessCrypto.aesBlock(hex(p), key: ecbKey) == hex(c), "SP 800-38A ECB-AES128 block \(p.prefix(8))")
        }
        try fails("AES-128 rejects a short key") { _ = try VMessCrypto.aesBlock(hex("00112233445566778899aabbccddeeff"), key: Data(count: 15)) }
        try fails("AES-128 rejects a short block") { _ = try VMessCrypto.aesBlock(Data(count: 15), key: ecbKey) }
    }
    private static func vmessPrimitives() throws {
        let kdf = VMessCrypto.kdf(iv, [Data("test path".utf8), Data("second".utf8)])
        try check(kdf == hex("9cb322b8eeb3fb387601a64e09fe065f09367d37926acd6f744f3f73a4001867"), "VMess nested HMAC KDF")
        try check(VMessCrypto.crc32(Data("123456789".utf8)) == 0xcbf43926, "IEEE CRC32")
        try check(VMessCrypto.fnv1a(Data("hello".utf8)) == 0x4f9f2cab, "FNV1a")
        let aesKey = hex("2b7e151628aed2a6abf7158809cf4f3c")
        let clear = hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710")
        let encrypted = hex("3b3fd92eb72dad20333449f8e83cfb4ac8a64537a0b3a93fcde3cdad9f1ce58b26751f67a3cbb140b1808cf187a4f4dfc04b05357c5d1c0eeac4c66f9ff7f2e6")
        let encoder = try AESCFB128(key: aesKey, iv: iv, decrypt: false)
        var encoded = Data()
        for byte in clear { encoded.append(try encoder.update(Data([byte]))) }
        try check(encoded == encrypted, "NIST AES-CFB128 encryption over partial blocks")
        let decoder = try AESCFB128(key: aesKey, iv: iv, decrypt: true)
        var decoded = Data()
        for byte in encrypted { decoded.append(try decoder.update(Data([byte]))) }
        try check(decoded == clear, "NIST AES-CFB128 decryption over partial blocks")
    }
    private static func vmessSession(_ alter: Int, udp: Bool = false) throws -> VMessSession {
        try VMessSession(uuid: user, alterId: alter, destinationHost: "example.com", destinationPort: 443,
                          udp: udp, requestIV: iv, requestKey: key, responseAuth: 0x42)
    }
    private static func vmessFrames() throws {
        for alter in [1, 0] {
            let session = try vmessSession(alter)
            let request = try session.requestHeader(timestamp: 1_700_000_000,
                                                    authRandom: hex("01020304"), nonce: hex("05060708090a0b0c"))
            try check(request == hex(alter == 0 ? aeadRequest : legacyRequest), "VMess full independent request wire fixture alterId=\(alter)")
            let outgoing = try session.encodeBody(Data("hello VMess".utf8))
            try check(outgoing == [hex("001bc76e58df1d70b8434e332e286d68c403e8ee6bb458ed146c3d1b97")], "VMess request body wire fixture")
            let vector = hex(alter == 0 ? aeadResponse : legacyResponse)
            var decoded = [Data]()
            for byte in vector { decoded += try session.decodeResponse(Data([byte])) }
            try check(decoded == [Data("hello VMess".utf8)], "VMess response split at every byte alterId=\(alter)")
            try session.finishReceiving()
            let end = try session.finishWriting()
            try check(end.count == 18, "VMess authenticated termination length")
            let endNonce = WireBytes.be16(1) + Data(iv.dropFirst(2).prefix(10))
            try check(try ProtocolCrypto.open(Data(end.dropFirst(2)), key: key, nonce: endNonce).isEmpty, "VMess authenticated termination content")
            try fails("VMess writes after termination") { _ = try session.encodeBody(Data([1])) }
            let altered = try vmessSession(alter)
            var bad = vector; bad[bad.count - 1] ^= 1
            try fails("VMess tampered body tag") { _ = try altered.decodeResponse(bad) }
            let truncated = try vmessSession(alter)
            _ = try truncated.decodeResponse(Data(vector.dropLast()))
            try fails("VMess truncated authenticated body") { try truncated.finishReceiving() }
            let wrongHeader = try vmessSession(alter)
            var badHeader = vector; badHeader[0] ^= 1
            try fails("VMess altered response authentication") { _ = try wrongHeader.decodeResponse(badHeader) }
        }
        let datagrams = try vmessSession(1, udp: true)
        _ = try datagrams.requestHeader(timestamp: 1_700_000_000)
        try check(try datagrams.encodeBody(Data("one UDP datagram".utf8)).count == 1, "VMess UDP preserves packet boundary")
        try fails("VMess oversized UDP packet") { _ = try datagrams.encodeBody(Data(repeating: 0, count: 0x4000)) }
        try fails("VMess empty UDP cannot alias end signal") { _ = try datagrams.encodeBody(Data()) }
        let stream = try vmessSession(0)
        _ = try stream.requestHeader(timestamp: 1_700_000_000)
        let chunks = try stream.encodeBody(Data(repeating: 7, count: 50_000))
        try check(chunks.count == 4 && chunks.allSatisfy { $0.count <= 0x4002 }, "VMess bounded large-stream chunks")
    }

    // Same public example identity, security=4. Fixtures from an independent Python
    // implementation that first reproduces every AES-128-GCM fixture above.
    private static let chachaAeadRequest = "0fadc0039741be1da55e11960db326ed2dbba3205532edc48d4f97eb951073d8443a05060708090a0b0caff7359c252a748a975d305d497b1f5bb39dbaa569c658420d48a48ddf8a0313f772298eaab385c46df3aa7c114a574fd8cac35b37f8b062af33eeb5827a2813194f4419d90dc30389"
    private static let chachaLegacyRequest = "5e47a5ab744b87b3cbeffd8e6cbc906b153bb895fd69fdf57afdb47022206f14997fd7ddb340ceb3ed9aebc6aa44c71725ec1ef88a49d2b0c432ae0f9d78689d896268ccfc3af53a3f"
    private static let chachaAeadResponse = "9bdfb1639712b6a6348d0087b8d1af379ecf70afb5ebb377066e79586918c758b5afc6888061001be647892a54ecd8b0a3650771b7701b3a4437942b2cc38a85f85e65"
    private static let chachaLegacyResponse = "372343ca001b22e73b78a96970a566911b3916ef87b83eb868cff35adf5ec67244"
    private static func vmessChaChaFrames() throws {
        try check(VMessSecurity.chacha20poly1305.bodyKey(key) == hex("1bf42e241816ba29ff5f307bb1bc1d168b39e04ece3e33ab822442d7e6cefd5f"), "VMess ChaCha body key expansion")
        try check(VMessSecurity(name: nil) == .aes128gcm && VMessSecurity(name: "AUTO") == .aes128gcm, "VMess auto keeps AES-128-GCM")
        try check(VMessSecurity(name: "chacha20-ietf-poly1305") == .chacha20poly1305, "VMess ChaCha spelling alias")
        try check(VMessSecurity(name: "none") == nil && VMessSecurity(name: "zero") == nil, "VMess unauthenticated security rejected")
        for alter in [1, 0] {
            func make() throws -> VMessSession {
                try VMessSession(uuid: user, alterId: alter, destinationHost: "example.com", destinationPort: 443,
                                 udp: false, requestIV: iv, requestKey: key, responseAuth: 0x42, security: .chacha20poly1305)
            }
            let session = try make()
            let request = try session.requestHeader(timestamp: 1_700_000_000,
                                                    authRandom: hex("01020304"), nonce: hex("05060708090a0b0c"))
            try check(request == hex(alter == 0 ? chachaAeadRequest : chachaLegacyRequest), "VMess ChaCha request wire fixture alterId=\(alter)")
            try check(try session.encodeBody(Data("hello VMess".utf8)) == [hex("001b8aa8b3dd91970d0f2138e4a5f05e5b37344a99aac4a060c5f05422")], "VMess ChaCha request body wire fixture")
            let vector = hex(alter == 0 ? chachaAeadResponse : chachaLegacyResponse)
            var decoded = [Data]()
            for byte in vector { decoded += try session.decodeResponse(Data([byte])) }
            try check(decoded == [Data("hello VMess".utf8)], "VMess ChaCha response split at every byte alterId=\(alter)")
            try session.finishReceiving()
            try check(try session.finishWriting() == hex("0010b43dee00b470c0dae2f5a20fb3d27125"), "VMess ChaCha authenticated termination fixture")
            let altered = try make()
            var bad = vector; bad[bad.count - 1] ^= 1
            try fails("VMess ChaCha tampered body tag") { _ = try altered.decodeResponse(bad) }
            let aesReader = try vmessSession(alter)
            try fails("VMess AES session rejects ChaCha body") { _ = try aesReader.decodeResponse(vector) }
        }
    }

    /// The 16-bit body counter wraps after 65,536 chunks, as in v2ray/Xray; it must not end the stream.
    private static func vmessCounterWrap() throws {
        let writer = try vmessSession(0)
        _ = try writer.requestHeader(timestamp: 1_700_000_000)
        let first = try writer.encodeBody(Data("x".utf8))
        for _ in 1..<65_536 { _ = try writer.encodeBody(Data("x".utf8)) }
        try check(try writer.encodeBody(Data("x".utf8)) == first, "VMess request counter wraps to nonce zero")
        _ = try writer.finishWriting()

        let responseKey = Data(ProtocolCrypto.sha256(key).prefix(16))
        let responseIV = Data(ProtocolCrypto.sha256(iv).prefix(16))
        func chunk(_ plain: Data, _ counter: Int) throws -> Data {
            let nonce = WireBytes.be16(UInt16(truncatingIfNeeded: counter)) + Data(responseIV.dropFirst(2).prefix(10))
            let sealed = try ProtocolCrypto.seal(plain, key: responseKey, nonce: nonce)
            return WireBytes.be16(UInt16(sealed.count)) + sealed
        }
        let vector = hex(aeadResponse)
        try check(Data(vector.suffix(29)) == (try chunk(Data("hello VMess".utf8), 0)), "VMess response body chunk reproduces fixture")
        let reader = try vmessSession(0)
        try check(try reader.decodeResponse(Data(vector.dropLast(29))).isEmpty, "VMess response header alone yields no data")
        let total = 65_538
        var received = 0, batch = Data(), lastByte: UInt8 = 0
        for counter in 0..<total {
            batch.append(try chunk(Data([UInt8(truncatingIfNeeded: counter)]), counter))
            if batch.count >= 64 * 1024 || counter == total - 1 {
                for plain in try reader.decodeResponse(batch) { received += 1; lastByte = plain.last ?? 0 }
                batch = Data()
            }
        }
        try check(received == total && lastByte == UInt8(truncatingIfNeeded: total - 1), "VMess response counter wraps past 65,536 chunks")
        _ = try reader.decodeResponse(try chunk(Data(), total))
        try check(reader.responseEnded, "VMess wrapped-counter termination")
        try reader.finishReceiving()
    }


    // SHA-224 vectors: FIPS 180-4 / NIST CAVS examples, confirmed with Python hashlib.
    // Lengths 55, 56 and 64 cover the one-block/two-block padding boundary.
    private static func sha224Vectors() throws {
        let vectors: [(Data, String)] = [
            (Data(), "d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f"),
            (Data("abc".utf8), "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7"),
            (Data("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8),
             "75388b16512776cc5dba5da1fd890150b0c6455cb4f58b1952522525"),
            (Data(repeating: 0x61, count: 55), "fb0bd626a70c28541dfa781bb5cc4d7d7f56622a58f01a0b1ddd646f"),
            (Data(repeating: 0x61, count: 56), "d40854fc9caf172067136f2e29e1380b14626bf6f0dd06779f820dcd"),
            (Data(repeating: 0x61, count: 64), "a88cd5cde6d6fe9136a4e58b49167461ea95d388ca2bdb7afdc3cbf4"),
            (Data(repeating: 0x61, count: 1_000_000), "20794655980c91d8bbb4c1ea97618a4bf03f42581948b2ee4ee7ad67"),
        ]
        for (message, digest) in vectors {
            try check(Data(SHA224.hash(message)) == hex(digest), "SHA-224 of \(message.count) bytes")
        }
    }

    // Trojan fixtures computed with Python hashlib from the public protocol description.
    private static let trojanConnect = "64363364633931396532303164376263346338323536333064326366323566646339336434623266306434363730366432393033386430310d0a01030b6578616d706c652e636f6d01bb0d0a"
    private static let trojanAssociate = "64363364633931396532303164376263346338323536333064326366323566646339336434623266306434363730366432393033386430310d0a0301c000020100350d0a"
    private static let trojanServerDatagrams = "01c0000201003500030d0a6f6e65030b646e732e6578616d706c65003500000d0a0420010db8000000000000000000000001003500030d0a74776f"
    private static func trojanFrames() throws {
        try check(TrojanSession.token("password") == Data("d63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01".utf8), "Trojan SHA-224 hex token")
        try check(TrojanSession.token("pässwörd") == Data("1fa1dc9715a45491364693be5cfc25e1e8478204b8b4ef6deee9d3b3".utf8), "Trojan token hashes UTF-8")
        let stream = try TrojanSession(password: "password", destinationHost: "example.com", destinationPort: 443, udp: false)
        try check(try stream.requestHeader() == hex(trojanConnect), "Trojan CONNECT request wire fixture")
        try fails("Trojan header sent twice") { _ = try stream.requestHeader() }
        try fails("Trojan TCP session has no datagram framing") { _ = try stream.encodeDatagram(Data([1])) }
        try fails("Trojan empty password") {
            _ = try TrojanSession(password: "", destinationHost: "example.com", destinationPort: 443, udp: false)
        }

        let datagrams = try TrojanSession(password: "password", destinationHost: "192.0.2.1", destinationPort: 53, udp: true)
        try fails("Trojan datagram before request") { _ = try datagrams.encodeDatagram(Data("hello".utf8)) }
        try check(try datagrams.requestHeader() == hex(trojanAssociate), "Trojan UDP ASSOCIATE request wire fixture")
        try check(try datagrams.encodeDatagram(Data("hello".utf8)) == hex("01c0000201003500050d0a68656c6c6f"), "Trojan UDP packet wire fixture")
        try check(try datagrams.encodeDatagram(Data()).count == 11, "Trojan carries empty UDP datagrams")
        try fails("Trojan oversized UDP datagram") { _ = try datagrams.encodeDatagram(Data(count: TrojanSession.maxDatagram + 1)) }

        let vector = hex(trojanServerDatagrams)
        let expected = [Data("one".utf8), Data(), Data("two".utf8)]
        var whole = try TrojanSession(password: "password", destinationHost: "192.0.2.1", destinationPort: 53, udp: true)
        try check(try whole.decodeDatagrams(vector) == expected, "Trojan IPv4, domain and IPv6 source datagrams")
        try whole.finishReceiving()
        whole = try TrojanSession(password: "password", destinationHost: "192.0.2.1", destinationPort: 53, udp: true)
        var split = [Data]()
        for byte in vector { split += try whole.decodeDatagrams(Data([byte])) }
        try check(split == expected, "Trojan UDP stream split at every byte")
        try whole.finishReceiving()

        let truncated = try TrojanSession(password: "password", destinationHost: "192.0.2.1", destinationPort: 53, udp: true)
        try check(try truncated.decodeDatagrams(Data(vector.prefix(16))) == [Data("one".utf8)], "Trojan delivers complete datagrams before a partial one")
        try fails("Trojan stream ends inside a datagram") { try truncated.finishReceiving() }
        for bad in ["05c0000201003500030d0a6f6e65", "01c0000201003500030a0d6f6e65", "030000350000"] {
            let session = try TrojanSession(password: "password", destinationHost: "192.0.2.1", destinationPort: 53, udp: true)
            try fails("Trojan malformed UDP framing \(bad)") { _ = try session.decodeDatagrams(hex(bad)) }
        }
        try fails("Trojan TCP session rejects datagram decoding") { _ = try stream.decodeDatagrams(vector) }
    }

    // VLESS fixtures computed with Python from the public protocol description.
    private static func vlessFrames() throws {
        let stream = try VLESSSession(uuid: user, destinationHost: "example.com", destinationPort: 443, udp: false)
        try check(try stream.requestHeader() == hex("00de305d5475b4431badb2eb6b9e546014000101bb020b6578616d706c652e636f6d"), "VLESS TCP request, domain target")
        try fails("VLESS header sent twice") { _ = try stream.requestHeader() }
        let v6 = try VLESSSession(uuid: user, destinationHost: "2001:db8::1", destinationPort: 8443, udp: false)
        try check(try v6.requestHeader() == hex("00de305d5475b4431badb2eb6b9e546014000120fb0320010db8000000000000000000000001"), "VLESS IPv6 target uses type 3")
        try fails("VLESS invalid UUID") { _ = try VLESSSession(uuid: "nope", destinationHost: "example.com", destinationPort: 443, udp: false) }

        let response = hex("0000") + Data("hello VLESS".utf8)
        var reader = try VLESSSession(uuid: user, destinationHost: "example.com", destinationPort: 443, udp: false)
        var text = Data()
        for byte in response { for chunk in try reader.decodeResponse(Data([byte])) { text.append(chunk) } }
        try check(text == Data("hello VLESS".utf8), "VLESS response header stripped across every split")
        try reader.finishReceiving()
        reader = try VLESSSession(uuid: user, destinationHost: "example.com", destinationPort: 443, udp: false)
        try check(try reader.decodeResponse(hex("0002aabb") + Data("x".utf8)) == [Data("x".utf8)], "VLESS response addons skipped")
        reader = try VLESSSession(uuid: user, destinationHost: "example.com", destinationPort: 443, udp: false)
        try fails("VLESS unknown response version") { _ = try reader.decodeResponse(hex("0100")) }
        reader = try VLESSSession(uuid: user, destinationHost: "example.com", destinationPort: 443, udp: false)
        _ = try reader.decodeResponse(hex("0003aa"))
        try fails("VLESS stream ends inside its response header") { try reader.finishReceiving() }
        reader = try VLESSSession(uuid: user, destinationHost: "example.com", destinationPort: 443, udp: false)
        try reader.finishReceiving()   // closed before any response: a clean, empty stream

        let datagrams = try VLESSSession(uuid: user, destinationHost: "192.0.2.1", destinationPort: 53, udp: true)
        try fails("VLESS datagram before request") { _ = try datagrams.encodeDatagram(Data([1])) }
        try check(try datagrams.requestHeader() == hex("00de305d5475b4431badb2eb6b9e5460140002003501c0000201"), "VLESS UDP request")
        try check(try datagrams.encodeDatagram(Data("ping".utf8)) == hex("000470696e67"), "VLESS UDP packet framing")
        try check(try datagrams.encodeDatagram(Data()) == hex("0000"), "VLESS carries empty datagrams")
        try fails("VLESS oversized datagram") { _ = try datagrams.encodeDatagram(Data(count: 65_536)) }
        let packets = hex("0000") + hex("0003") + Data("one".utf8) + hex("0000") + hex("0003") + Data("two".utf8)
        var received = [Data]()
        for byte in packets { received += try datagrams.decodeResponse(Data([byte])) }
        try check(received == [Data("one".utf8), Data(), Data("two".utf8)], "VLESS UDP packets reassembled across every split")
        try datagrams.finishReceiving()
        let partial = try VLESSSession(uuid: user, destinationHost: "192.0.2.1", destinationPort: 53, udp: true)
        _ = try partial.decodeResponse(hex("00000005abcd"))
        try fails("VLESS stream ends inside a UDP packet") { try partial.finishReceiving() }

        var node = ProxyNode(id: "vless", name: "VLESS", type: "vless", server: "example.com", port: 443,
                             uuid: user, tls: true, network: "ws", wsPath: "/vless", udp: true)
        try node.validate()
        try check(try TransportPlan.make(for: node, datagramSocket: false) == TransportPlan(dial: .tcp, security: .systemTLS(serverName: "example.com"),
                                      framing: .webSocket(path: "/vless", host: "example.com:443")), "VLESS WS+TLS plan")
        node.cipher = "none"; try node.validate()
        node.cipher = "aes-128-gcm"
        try fails("VLESS encryption other than none") { try node.validate() }
        node.cipher = nil; node.flow = "xtls-rprx-vision"
        try fails("VLESS vision flow not yet supported") { try node.validate() }
        node.flow = nil; node.uuid = "bad"
        try fails("VLESS invalid UUID in node") { try node.validate() }
        node.uuid = user; node.network = "grpc"
        try fails("VLESS gRPC transport") { try node.validate() }
    }

    private static func streamCoalescing() throws {
        try check(StreamCoalescer.coalesce([]) == [], "Coalesce: nothing in, nothing out")
        try check(StreamCoalescer.coalesce([Data("a".utf8)]) == [Data("a".utf8)], "Coalesce: one chunk untouched")
        try check(StreamCoalescer.coalesce([Data(), Data("ab".utf8), Data(), Data("c".utf8)]) == [Data("abc".utf8)],
                  "Coalesce: empty chunks dropped, order kept")
        try check(StreamCoalescer.coalesce([Data([1, 2]), Data([3, 4]), Data([5])], limit: 4) == [Data([1, 2, 3, 4]), Data([5])],
                  "Coalesce: exact limit fills one write")
        try check(StreamCoalescer.coalesce([Data([1]), Data(repeating: 7, count: 9), Data([2])], limit: 4)
                  == [Data([1]), Data(repeating: 7, count: 9), Data([2])], "Coalesce: oversize chunk passes alone")
        // Randomized: bytes and order are identical, writes respect the limit.
        var seed: UInt32 = 0x9e3779b9
        for _ in 0..<200 {
            var chunks = [Data]()
            for _ in 0..<Int(seed % 9) {
                seed = seed &* 1_664_525 &+ 1_013_904_223
                chunks.append(Data(repeating: UInt8(truncatingIfNeeded: seed >> 24), count: Int(seed >> 8) % 70))
            }
            seed = seed &* 1_664_525 &+ 1_013_904_223; let limit = Int(seed >> 16) % 120 + 1
            let writes = StreamCoalescer.coalesce(chunks, limit: limit)
            try check(writes.reduce(Data(), +) == chunks.reduce(Data(), +), "Coalesce: bytes identical")
            try check(writes.allSatisfy { !$0.isEmpty }, "Coalesce: no empty writes")
            for (i, w) in writes.enumerated() where w.count > limit {
                try check(chunks.contains(w), "Coalesce: only a single oversize chunk may exceed the limit (\(i))")
            }
            try check(writes.count <= max(1, chunks.filter { !$0.isEmpty }.count), "Coalesce: never more writes than chunks")
        }
        // Shadowsocks: header plus a 40 000-byte write (three AEAD chunks) leave as one write.
        let session = try ShadowsocksSession(password: "password", destinationHost: "example.com", destinationPort: 443, udp: false)
        let header = try session.requestHeader()
        let chunks = try session.encodeStream(Data(repeating: 5, count: 40_000))
        let merged = StreamCoalescer.coalesce([header] + chunks)
        try check(merged.count == 1 && merged[0] == ([header] + chunks).reduce(Data(), +), "Coalesce: SS header + 3 chunks in one write")
    }

    private static func byteQueue() throws {
        var queue = ByteQueue(), reference = Data(), next: UInt8 = 0
        for round in 0..<2_000 {
            let appended = Data((0..<(round % 37 + 1)).map { _ in next &+= 1; return next })
            queue.append(appended); reference.append(appended)
            try check(queue.prefix(10) == Data(reference.prefix(10)), "ByteQueue prefix matches")
            let length = round % 41
            try check(queue.take(length) == Data(reference.prefix(length)), "ByteQueue take matches at round \(round)")
            reference = Data(reference.dropFirst(length))
            try check(queue.count == reference.count && queue.isEmpty == reference.isEmpty, "ByteQueue count matches")
        }
        try check(queue.take(queue.count) == reference && queue.isEmpty && queue.take(4).isEmpty, "ByteQueue drains")
    }

    private static func websocketFrames() throws {
        try check(WebSocketWire.accept("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "RFC6455 handshake accept")
        let masked = try WebSocketWire.clientFrame(Data("Hello".utf8), opcode: 1, mask: hex("37fa213d"))
        try check(masked == hex("818537fa213d7f9f4d5158"), "RFC6455 client masking example")
        // Every length-encoding boundary, against a naive per-byte reference, with a sliced
        // (non-zero startIndex) payload to catch index-base mistakes.
        let mask = hex("a1b2c3d4"); let mb = [UInt8](mask)
        for length in [0, 1, 3, 4, 5, 125, 126, 127, 65535, 65536, 65537, 300_001] {
            let backing = Data((0..<(length + 7)).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) })
            let payload = backing.subdata(in: 7..<(length + 7))
            let sliced = backing[7...]
            var expected = Data([0x82])
            if length < 126 { expected.append(0x80 | UInt8(length)) }
            else if length <= 65535 { expected.append(0xfe); expected.append(WireBytes.be16(UInt16(length))) }
            else { expected.append(0xff); expected.append(WireBytes.be64(UInt64(length))) }
            expected.append(mask)
            for (index, value) in [UInt8](payload).enumerated() { expected.append(value ^ mb[index & 3]) }
            try check(try WebSocketWire.clientFrame(payload, mask: mask) == expected, "WebSocket masking length \(length)")
            try check(try WebSocketWire.clientFrame(sliced, mask: mask) == expected, "WebSocket masking sliced length \(length)")
        }
        try fails("WebSocket oversized client frame") { _ = try WebSocketWire.clientFrame(Data(count: 2 * 1024 * 1024 + 1)) }
        try fails("WebSocket oversized control frame") { _ = try WebSocketWire.clientFrame(Data(count: 126), opcode: 9) }
        var decoder = WebSocketFrameDecoder()
        let stream = hex("020361626389017880026465")
        var binary = [Data](); var pings = [Data]()
        for byte in stream {
            for event in try decoder.receive(Data([byte])) {
                switch event {
                case .binary(let data): binary.append(data)
                case .ping(let data): pings.append(data)
                default: break
                }
            }
        }
        try check(binary == [Data("abcde".utf8)] && pings == [Data("x".utf8)], "WebSocket fragmented binary with interleaved ping, partial input")
        try decoder.finish()
        var maskedServer = WebSocketFrameDecoder()
        try fails("WebSocket masked server frame") { _ = try maskedServer.receive(hex("8280")) }
        var noncanonical = WebSocketFrameDecoder()
        try fails("WebSocket noncanonical length") { _ = try noncanonical.receive(hex("827e000100")) }
        var truncated = WebSocketFrameDecoder()
        _ = try truncated.receive(hex("82050102"))
        try fails("WebSocket truncated frame") { try truncated.finish() }
        var close = WebSocketFrameDecoder()
        try fails("WebSocket one-byte close status") { _ = try close.receive(hex("880100")) }
        let upgrade = Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".utf8)
        try WebSocketWire.validateUpgrade(upgrade, key: "dGhlIHNhbXBsZSBub25jZQ==")
        try fails("WebSocket wrong accept") { try WebSocketWire.validateUpgrade(upgrade, key: "wrong") }
        let refused = Data("HTTP/1.1 400 Bad Request\r\n\r\n".utf8)
        do {
            try WebSocketWire.validateUpgrade(refused, key: "dGhlIHNhbXBsZSBub25jZQ==")
            throw Failure(description: "Expected rejection: WebSocket HTTP 400")
        } catch let error as ProxyError {
            let text = error.errorDescription ?? ""
            try check(text.contains("400"), "WebSocket refusal names HTTP status")
        } catch {
            throw Failure(description: "Expected ProxyError for WebSocket HTTP 400")
        }
        let http10 = Data("HTTP/1.0 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".utf8)
        try WebSocketWire.validateUpgrade(http10, key: "dGhlIHNhbXBsZSBub25jZQ==")
        var huge = WebSocketFrameDecoder()
        // 64-bit length that claims more than 2 MiB must be rejected before buffering the body.
        try fails("WebSocket oversized 64-bit length") {
            _ = try huge.receive(Data([0x82, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0x00, 0x00]))
        }
        var closeOk = WebSocketFrameDecoder()
        let events = try closeOk.receive(Data([0x88, 0x02, 0x03, 0xe8])) // close 1000
        try check(events.count == 1, "WebSocket clean close frame")
    }

    private static func configurationValidation() throws {
        var node = ProxyNode(id: "test", name: "Example", type: "vmess", server: "example.com", port: 443,
                             cipher: "auto", uuid: user, alterId: 1, tls: true, udp: true)
        try node.validate()
        node.skipCertVerify = true
        try fails("Insecure TLS config") { try node.validate() }
        node.skipCertVerify = false; node.alterId = -1
        try fails("Negative alterId") { try node.validate() }
        node.alterId = 65_536
        try fails("Too large alterId") { try node.validate() }
        node.alterId = 0; node.cipher = "chacha20-poly1305"
        try node.validate()
        node.cipher = "unknown"
        try fails("Unsupported VMess cipher") { try node.validate() }
        var ss = ProxyNode(id: "ss", name: "SS", type: "ss", server: "example.com", port: 8388,
                           cipher: "aes-256-gcm", password: "secret")
        try ss.validate()
        ss.password = ""
        try fails("Empty Shadowsocks password still validates cipher pair") {
            // validate() only checks password != nil today; empty is caught at session start.
            _ = try ShadowsocksSession(password: "", destinationHost: "example.com",
                                       destinationPort: 443, udp: false)
        }
        var trojan = ProxyNode(id: "trojan", name: "Trojan", type: "trojan", server: "example.com", port: 443,
                               password: "secret", udp: true)
        try trojan.validate()
        try check(trojan.usesTLS && !ss.usesTLS && node.usesTLS, "Trojan defaults to TLS; Shadowsocks does not")
        ss.password = "secret"; ss.network = "ws"; ss.tls = true
        try ss.validate()
        ss.network = "grpc"
        try fails("Shadowsocks gRPC transport") { try ss.validate() }
        trojan.network = "ws"; trojan.wsPath = "/trojan"
        try trojan.validate()
        trojan.network = "grpc"
        try fails("Trojan gRPC transport") { try trojan.validate() }
        trojan.network = nil; trojan.tls = false
        try trojan.validate()
        try check(!trojan.usesTLS, "Trojan accepts an explicit tls=false")
        trojan.network = "ws"
        try trojan.validate()
        trojan.network = nil; trojan.tls = nil; trojan.password = ""
        try fails("Trojan empty password") { try trojan.validate() }
        trojan.password = "secret"; trojan.skipCertVerify = true
        try fails("Trojan insecure TLS") { try trojan.validate() }
        try check(ProxyError.dial("x").errorDescription == "x", "dial error surfaces message")
    }

    private static func transportPlans() throws {
        let ss = ProxyNode(id: "ss", name: "SS", type: "ss", server: "example.com", port: 8388,
                           cipher: "aes-256-gcm", password: "secret", udp: true)
        try check(try TransportPlan.make(for: ss, datagramSocket: false) == TransportPlan(dial: .tcp, security: .none, framing: .raw), "SS TCP plan")
        try check(try TransportPlan.make(for: ss, datagramSocket: true) == TransportPlan(dial: .udp, security: .none, framing: .raw), "SS UDP plan")
        try check(try TransportPlan.make(for: ss, datagramSocket: false).framingCarriesEOF, "raw framing carries EOF")
        var vmess = ProxyNode(id: "v", name: "V", type: "vmess", server: "192.0.2.7", port: 8443, uuid: user,
                              tls: true, network: "ws", wsPath: "/ray")
        let ws = try TransportPlan.make(for: vmess, datagramSocket: false)
        try check(ws == TransportPlan(dial: .tcp, security: .systemTLS(serverName: "192.0.2.7"),
                                      framing: .webSocket(path: "/ray", host: "192.0.2.7:8443")), "VMess WS+TLS plan defaults")
        try check(!ws.framingCarriesEOF, "WebSocket framing cannot carry EOF")
        vmess.serverName = "cdn.example"; vmess.wsHost = "front.example"; vmess.wsPath = nil
        try check(try TransportPlan.make(for: vmess, datagramSocket: false) == TransportPlan(dial: .tcp, security: .systemTLS(serverName: "cdn.example"),
                                      framing: .webSocket(path: "/", host: "front.example")), "VMess SNI, Host and default path")
        vmess.server = "2001:db8::7"; vmess.wsHost = nil
        try check(try TransportPlan.make(for: vmess, datagramSocket: false).framing == .webSocket(path: "/", host: "[2001:db8::7]:8443"), "IPv6 Host literal")
        let trojan = ProxyNode(id: "t", name: "T", type: "trojan", server: "example.com", port: 443, password: "secret")
        try check(try TransportPlan.make(for: trojan, datagramSocket: false).security == .systemTLS(serverName: "example.com"), "Trojan implies system TLS")
        // The four layer combinations: protocol-framing-security.
        var plain = trojan; plain.tls = false
        try check(try TransportPlan.make(for: plain, datagramSocket: false) == TransportPlan(dial: .tcp, security: .none, framing: .raw), "trojan-raw tcp-none plan")
        plain.network = "ws"; plain.wsPath = "/t"
        try check(try TransportPlan.make(for: plain, datagramSocket: false) == TransportPlan(dial: .tcp, security: .none,
                  framing: .webSocket(path: "/t", host: "example.com:443")), "trojan-websocket-none plan")
        var wsss = ss; wsss.network = "ws"; wsss.tls = true; wsss.wsPath = "/ss"
        try check(try TransportPlan.make(for: wsss, datagramSocket: false) == TransportPlan(dial: .tcp, security: .systemTLS(serverName: "example.com"),
                  framing: .webSocket(path: "/ss", host: "example.com:8388")), "shadowsocks-websocket-systemtls plan")
        try check(try TransportPlan.make(for: wsss, datagramSocket: true) == TransportPlan(dial: .udp, security: .none, framing: .raw), "SS UDP stays on the datagram socket")
        vmess.serverName = "bad name"
        try fails("TLS server name with a space") { _ = try TransportPlan.make(for: vmess, datagramSocket: false) }
        vmess.serverName = nil; vmess.wsPath = "ray"
        try fails("WebSocket path without leading slash") { _ = try TransportPlan.make(for: vmess, datagramSocket: false) }
        vmess.wsPath = "/ray"; vmess.skipCertVerify = true
        try fails("Plan refuses insecure TLS") { _ = try TransportPlan.make(for: vmess, datagramSocket: false) }
    }

    #if canImport(Network)
    private static func endpointResolver() throws {
        try check(ProxyEndpointResolver.literalAddress("192.0.2.10") == "192.0.2.10", "IPv4 literal")
        try check(ProxyEndpointResolver.literalAddress("2001:db8::1") == "2001:db8::1", "IPv6 literal")
        try check(ProxyEndpointResolver.literalAddress("proxy.example.test") == nil, "hostname is not literal")
        let ordered = try ProxyEndpointResolver.addresses(host: "127.0.0.1", port: 443)
        try check(ordered == ["127.0.0.1"], "loopback resolve stays IPv4 literal")
        // When both families exist, IPv4 must sort ahead of IPv6 for SS/WS dial reliability.
        if let both = try? ProxyEndpointResolver.addresses(host: "localhost", port: 9), both.count >= 2 {
            try check(!both[0].contains(":"), "localhost prefers IPv4 before IPv6")
            try check(both.count <= 8, "resolver caps address fan-out at 8")
        }
    }
    #endif
}
