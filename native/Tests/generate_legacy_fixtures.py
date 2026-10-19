#!/usr/bin/env python3
"""Independent tiny binary fixtures, constructed directly from public formats.
Never loads an old database or invokes LevelDB/Snappy libraries.
"""
import pathlib, struct, sys
root = pathlib.Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
def fixed(n, width): return n.to_bytes(width, 'little')
def var(n):
    out = bytearray()
    while n > 127: out.append((n & 127) | 128); n >>= 7
    out.append(n); return bytes(out)
def blob(b): return var(len(b)) + b
def crc(data):
    value = 0xffffffff
    for byte in data:
        value ^= byte
        for _ in range(8): value = (value >> 1) ^ (0x82f63b78 if value & 1 else 0)
    c = (~value) & 0xffffffff
    return (((c >> 15) | ((c << 17) & 0xffffffff)) + 0xa282ead8) & 0xffffffff
assert crc(b'123456789') == 0xc78ab0e5

def logs(records):
    out = bytearray()
    for rec in records:
        first = True
        while first or rec:
            remain = 32768 - len(out) % 32768
            if remain < 7: out.extend(bytes(remain)); remain = 32768
            take = min(remain - 7, len(rec)); last = take == len(rec)
            kind = (1 if first else 4) if last else (2 if first else 3)
            piece, rec = rec[:take], rec[take:]
            out += fixed(crc(bytes([kind]) + piece), 4) + fixed(take, 2) + bytes([kind]) + piece
            first = False
    return bytes(out)
def text(s, wide=False): return bytes([0 if wide else 1]) + s.encode('utf-16le' if wide else 'latin1')
def key(s, wide=False): return b'_file://\0' + text(s, wide)
def internal(k, seq, kind=1): return k + fixed((seq << 8) | kind, 8)
def block(entries):
    out = bytearray(); restart = []; prior = b''
    for i, (k, value) in enumerate(entries):
        shared = 0
        if i % 2: 
            while shared < min(len(k), len(prior)) and k[shared] == prior[shared]: shared += 1
        else: restart.append(len(out))
        out += var(shared) + var(len(k) - shared) + var(len(value)) + k[shared:] + value; prior = k
    if not restart: restart = [0]
    return bytes(out) + b''.join(fixed(n, 4) for n in restart) + fixed(len(restart), 4)
def literal(data):
    n = len(data) - 1
    if n < 60: tag = bytes([n << 2])
    else:
        width = (n.bit_length() + 7) // 8; tag = bytes([(59 + width) << 2]) + fixed(n, width)
    return var(len(data)) + tag + data

def table(entries, compressed=True):
    out = bytearray()
    def append(data, use_snappy=False):
        offset = len(out); kind = int(use_snappy); data = literal(data) if kind else data
        out.extend(data + bytes([kind]) + fixed(crc(data + bytes([kind])), 4))
        return var(offset) + var(len(data))
    entries = sorted(entries, key=lambda entry: (entry[0][:-8], -int.from_bytes(entry[0][-8:], 'little')))
    data = append(block(entries), compressed)
    meta = append(block([])); index = append(block([(entries[-1][0], data)]))
    footer = meta + index; out += footer + bytes(40 - len(footer)) + fixed(0xdb4775248b80fb57, 8)
    return bytes(out)
def batch(start, entries):
    return fixed(start, 8) + fixed(len(entries), 4) + b''.join(bytes([int(value is not None)]) + blob(k) + (blob(value) if value is not None else b'') for k, value in entries)
def new_table(number, data):
    return var(7) + var(0) + var(number) + var(len(data)) + blob(b'a') + blob(b'z')

def directory(name, corrupt=False, partial=False, large=False):
    path = root / name; path.mkdir(exist_ok=True)
    old = table([(internal(key('wlsaplus:todos'), 2), text('resurrected-obsolete-data'))])
    current = table([(internal(b'VERSION', 1), b'1'),
        (internal(key('wlsaplus:todos'), 2), text('["old"]')),
        (internal(key('wlsaplus:settings'), 4), text('{"label":"学校 café"}', True)),
        (internal(key('wlsaplus:schedule', True), 5), text('["Tue"]')),
        (internal(key('wlsaplus:password'), 6), text('MUST-NOT-RETURN')),
        (internal(key('wlsaplus:progress'), 7), text('[1]'))])
    manifest = logs([var(1) + blob(b'leveldb.BytewiseComparator') + var(2) + var(10) + var(3) + var(11) + var(4) + var(7) + new_table(2, old),
        var(6) + var(0) + var(2) + new_table(3, current)])
    updates = [(key('wlsaplus:todos'), text('["new"]')), (key('wlsaplus:progress'), None),
        (key('wlsaplus:vpn-source'), text('policy')), (key('wlsaplus:vpn-node'), text('NodeA'))]
    if large: updates[0] = (key('wlsaplus:todos'), text('x' * 70000))
    wal = bytearray(logs([batch(8, updates)]))
    if corrupt: wal[10] ^= 1
    if partial: wal += b'\0\0\0'
    (path / 'CURRENT').write_text('MANIFEST-000001\n')
    (path / 'MANIFEST-000001').write_bytes(manifest)
    (path / '000002.ldb').write_bytes(old) # Obsolete file must be ignored.
    (path / '000003.ldb').write_bytes(current)
    (path / '000010.log').write_bytes(wal)
    (path / '000009.log').write_bytes(b'not even a valid log') # Obsolete WAL ignored.
    return path
for name, options in [('valid', {}), ('bad-crc', {'corrupt':True}), ('partial', {'partial':True}), ('fragmented', {'large':True})]: directory(name, **options)
bad_table = directory('bad-table'); p=bad_table / '000003.ldb'; data=bytearray(p.read_bytes()); data[5]^=1; p.write_bytes(data)
missing = directory('missing'); (missing / '000003.ldb').unlink()
