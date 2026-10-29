import Foundation

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
        try vmessFrames()
        try vmessChaChaFrames()
        try websocketFrames()
        try configurationValidation()
        try endpointResolver()
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

    private static func vmessSession(_ alter: Int, udp: Bool = false) throws -> VMessSession {
        try VMessSession(uuid: user, alterId: alter, destinationHost: "example.com", destinationPort: 443,
                          udp: udp, requestIV: iv, requestKey: key, responseAuth: 0x42)
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
        try check(ProxyError.dial("x").errorDescription == "x", "dial error surfaces message")
    }

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
}
