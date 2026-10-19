"""Independently constructed ZIP policy fixtures; Python is a test tool only."""
import io
import pathlib
import struct
import sys
import zipfile

destination = pathlib.Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)

def archive(extra=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as out:
        out.writestr('WLSAPlus.app/Contents/Info.plist', '<plist/>')
        out.writestr('WLSAPlus.app/Contents/MacOS/WLSAPlus', b'fixture executable')
        if extra:
            name, content, mode = extra
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = mode << 16
            out.writestr(info, content)
    return bytearray(stream.getvalue())

(destination / 'valid-native.zip').write_bytes(archive())
for name in ['WLSAPlus.app/../escape', '/absolute', 'WLSAPlus.app/./escape', 'WLSAPlus.app/a:b', 'WLSAPlus.app//escape']:
    filename = 'bad-path-' + str(len(list(destination.iterdir()))) + '.zip'
    (destination / filename).write_bytes(archive((name, b'x', 0o100644)))
(destination / 'bad-symlink.zip').write_bytes(archive(('WLSAPlus.app/link', b'/outside', 0o120777)))
(destination / 'bad-case.zip').write_bytes(archive(('WLSAPLUS.app/Contents/info.plist', b'x', 0o100644)))
data = archive()
name_size = struct.unpack_from('<H', data, 26)[0]
data[30 + name_size - 1] ^= 1
(destination / 'bad-local-name.zip').write_bytes(data)
data = archive()
struct.pack_into('<I', data, 18, 0)
(destination / 'bad-local-size.zip').write_bytes(data)
data = archive()
central = data.find(b'PK\x01\x02')
struct.pack_into('<I', data, central + 42, central)
(destination / 'bad-local-offset.zip').write_bytes(data)
data = archive()
data.extend(b'unexpected trailing bytes')
(destination / 'bad-trailing.zip').write_bytes(data)
print('Created ZIP safety fixtures')
