import Foundation

// Original implementation of the AES-128 forward cipher from the public standard, FIPS 197
// (SubBytes, ShiftRows, MixColumns, AddRoundKey and the section 5.2 key expansion). VMess needs
// only single-block encryption: CFB128 for the legacy header and one ECB block for the AEAD
// auth ID. CryptoKit and swift-crypto expose AES only inside AEAD modes, so carrying the block
// cipher here removes VMess's CommonCrypto dependency and lets its wire tests run on Linux.
// The S-box is computed once from its definition (GF(2^8) inverse plus affine map), not copied.
struct AES128 {
    private static let sbox: [UInt8] = {
        var box = [UInt8](repeating: 0, count: 256)
        var p: UInt8 = 1, q: UInt8 = 1
        repeat {
            // p walks the multiplicative group by 3; q tracks its inverse by dividing by 3.
            p = p ^ (p << 1) ^ ((p & 0x80) != 0 ? 0x1b : 0)
            q ^= q << 1; q ^= q << 2; q ^= q << 4
            if (q & 0x80) != 0 { q ^= 0x09 }
            let r = { (x: UInt8, n: UInt8) in (x << n) | (x >> (8 - n)) }
            box[Int(p)] = q ^ r(q, 1) ^ r(q, 2) ^ r(q, 3) ^ r(q, 4) ^ 0x63
        } while p != 1
        box[0] = 0x63
        return box
    }()

    private let roundKeys: [UInt8]   // 11 round keys of 16 bytes

    init(key: Data) throws {
        guard key.count == 16 else { throw ProxyError.authentication }
        var w = [UInt8](key)
        w.reserveCapacity(176)
        var rcon: UInt8 = 1
        while w.count < 176 {
            var t = Array(w[(w.count - 4)...])
            if w.count % 16 == 0 {
                t = [Self.sbox[Int(t[1])] ^ rcon, Self.sbox[Int(t[2])], Self.sbox[Int(t[3])], Self.sbox[Int(t[0])]]
                rcon = Self.xtime(rcon)
            }
            for i in 0..<4 { w.append(w[w.count - 16] ^ t[i]) }
        }
        roundKeys = w
    }

    @inline(__always) private static func xtime(_ x: UInt8) -> UInt8 {
        (x << 1) ^ ((x & 0x80) != 0 ? 0x1b : 0)
    }

    /// Encrypts exactly one 16-byte block.
    func encrypt(_ block: [UInt8]) -> [UInt8] {
        precondition(block.count == 16)
        var s = block
        for i in 0..<16 { s[i] ^= roundKeys[i] }
        for round in 1...10 {
            // SubBytes + ShiftRows (state is column-major: byte i is row i%4, column i/4).
            var t = [UInt8](repeating: 0, count: 16)
            for c in 0..<4 {
                for r in 0..<4 { t[4 * c + r] = Self.sbox[Int(s[4 * ((c + r) & 3) + r])] }
            }
            if round < 10 {
                for c in 0..<4 {
                    let a0 = t[4 * c], a1 = t[4 * c + 1], a2 = t[4 * c + 2], a3 = t[4 * c + 3]
                    let all = a0 ^ a1 ^ a2 ^ a3
                    t[4 * c] = a0 ^ all ^ Self.xtime(a0 ^ a1)
                    t[4 * c + 1] = a1 ^ all ^ Self.xtime(a1 ^ a2)
                    t[4 * c + 2] = a2 ^ all ^ Self.xtime(a2 ^ a3)
                    t[4 * c + 3] = a3 ^ all ^ Self.xtime(a3 ^ a0)
                }
            }
            let base = 16 * round
            for i in 0..<16 { t[i] ^= roundKeys[base + i] }
            s = t
        }
        return s
    }
}
