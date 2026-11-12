#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Regenerate every WLSAPlus icon artifact from the single design defined here.

Outputs (all committed, so a normal build needs none of this):
  AppIcon.icon/Assets/*.svg   layers for the macOS 26 layered icon
  AppIcon.icns                bitmap icon for macOS 13-15 and Command Line Tools builds
  ../Resources/brand-mark.svg flat mark used by the README

Needs Python 3 and a Chrome/Chromium binary (CHROME_BIN) to rasterize.
AppIcon.icon/icon.json is maintained by hand; keep its colors in step with PALETTE.
"""
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
CANVAS = 1024

PALETTE = {
    "tile_top": "#0b7a8f",
    "tile_mid": "#005f73",
    "tile_bottom": "#073b4c",
    "ink": "#ffffff",
    "ink_soft": "#b8f1fc",
    "accent_top": "#e8fbff",
    "accent_bottom": "#9be7f5",
    "badge": "#7be0f4",
}

# Each layer is drawn on the full 1024 canvas; the system (or the legacy
# composite below) supplies the tile shape and background.
LAYERS = {
    "card": (
        '<rect x="192" y="216" width="640" height="592" rx="104" fill="{ink}" fill-opacity="0.14"/>'
        '<rect x="198" y="222" width="628" height="580" rx="98" fill="none" stroke="{ink_soft}" stroke-opacity="0.38" stroke-width="12"/>'
    ),
    "lines": (
        '<defs><linearGradient id="a" x1="272" y1="320" x2="572" y2="384" gradientUnits="userSpaceOnUse">'
        '<stop offset="0" stop-color="{accent_top}"/><stop offset="1" stop-color="{accent_bottom}"/></linearGradient></defs>'
        '<rect x="272" y="320" width="300" height="64" rx="32" fill="url(#a)"/>'
        '<rect x="272" y="456" width="480" height="64" rx="32" fill="{ink}" fill-opacity="0.94"/>'
        '<rect x="272" y="592" width="380" height="64" rx="32" fill="{ink}" fill-opacity="0.74"/>'
    ),
    "badge": (
        '<circle cx="712" cy="352" r="80" fill="{badge}" fill-opacity="0.26"/>'
        '<path d="M712 304v96M664 352h96" fill="none" stroke="{accent_top}" stroke-width="28" stroke-linecap="round"/>'
    ),
}
ORDER = ["card", "lines", "badge"]  # back to front

BACKGROUND = (
    '<defs><linearGradient id="t" x1="96" y1="64" x2="928" y2="960" gradientUnits="userSpaceOnUse">'
    '<stop offset="0" stop-color="{tile_top}"/><stop offset="0.55" stop-color="{tile_mid}"/>'
    '<stop offset="1" stop-color="{tile_bottom}"/></linearGradient></defs>'
)

# (icns type, pixel size). PNG payloads; covers 16-512 pt at 1x and 2x.
ICNS_ENTRIES = [
    ("icp4", 16), ("icp5", 32), ("ic11", 32), ("ic12", 64), ("ic07", 128),
    ("ic13", 256), ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024),
]


def svg(body, extra=""):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}"{extra}>'
            f'{body}</svg>\n')


def layer(name):
    return LAYERS[name].format(**PALETTE)


def artwork():
    """Background plus every layer, full bleed, ids made unique per layer."""
    parts = [BACKGROUND.format(**PALETTE), f'<rect width="{CANVAS}" height="{CANVAS}" fill="url(#t)"/>']
    parts += [layer(name) for name in ORDER]
    return "".join(parts)


def brand_mark():
    body = (f'<clipPath id="c"><rect width="{CANVAS}" height="{CANVAS}" rx="230"/></clipPath>'
            f'<g clip-path="url(#c)">{artwork()}</g>')
    return svg(body, ' role="img" aria-label="WLSAPlus"')


def legacy_composite():
    """Pre-macOS 26 icon grid: 824 px tile centred on 1024 with a soft shadow."""
    scale = 824 / CANVAS
    body = (
        '<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%">'
        '<feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#000" flood-opacity="0.28"/></filter>'
        '<clipPath id="c"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath></defs>'
        '<rect x="100" y="100" width="824" height="824" rx="186" fill="#073b4c" filter="url(#s)"/>'
        f'<g clip-path="url(#c)"><g transform="translate(100 100) scale({scale:.6f})">{artwork()}</g></g>'
    )
    return svg(body)


def find_chrome():
    home = pathlib.Path.home()
    candidates = [os.environ.get("CHROME_BIN"),
                  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                  "/Applications/Chromium.app/Contents/MacOS/Chromium",
                  "/usr/local/bin/google-chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    candidates += [str(p) for p in sorted((home / ".cache/ms-playwright").glob("chromium-*/chrome-linux*/chrome"))]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    sys.exit("Set CHROME_BIN to a Chrome or Chromium binary to rasterize the icon.")


def png_size(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("not a PNG")
    return struct.unpack(">II", data[16:24])


def rasterize(chrome, source, size, workdir):
    """Render the 1024 design straight to `size` pixels with a transparent background."""
    page = workdir / f"icon-{size}.html"
    page.write_text(
        "<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}"
        f"svg{{display:block;width:{size}px;height:{size}px}}</style>{source}", encoding="utf-8")
    target = workdir / f"icon-{size}.png"
    # Headless Chrome has a minimum window size, so small icons are drawn in
    # the top-left corner of a larger viewport and cropped afterwards.
    viewport = max(size, 512)
    process = subprocess.Popen(
        [chrome, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
         "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
         "--disable-dev-shm-usage", "--force-device-scale-factor=1", "--default-background-color=00000000",
         f"--user-data-dir={workdir / f'profile-{size}'}", f"--window-size={viewport},{viewport}",
         f"--screenshot={target}", page.as_uri()],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Some Chrome wrappers keep running after the screenshot is written, so
    # wait for a complete PNG rather than for the process to exit.
    deadline, data = time.monotonic() + 90, b""
    try:
        while time.monotonic() < deadline:
            if target.exists():
                data = target.read_bytes()
                if data.endswith(b"IEND\xaeB`\x82"):
                    break
            if process.poll() is not None and not target.exists():
                break
            time.sleep(0.2)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
    if not data.endswith(b"IEND\xaeB`\x82"):
        sys.exit(f"Chrome did not produce a {size} px screenshot.")
    if png_size(data) != (size, size):
        data = crop_png(data, size)
    return data


def crop_png(data, size):
    """Crop the top-left size x size square of an 8-bit RGBA PNG (stdlib only)."""
    import zlib
    width, height = png_size(data)
    bit_depth, color_type = data[24], data[25]
    if (bit_depth, color_type) != (8, 6) or width < size or height < size:
        raise ValueError(f"unexpected screenshot format {width}x{height} depth {bit_depth} type {color_type}")
    position, compressed = 8, b""
    while position < len(data):
        length, kind = struct.unpack(">I4s", data[position:position + 8])
        if kind == b"IDAT":
            compressed += data[position + 8:position + 8 + length]
        position += 12 + length
    raw, stride, bpp = zlib.decompress(compressed), width * 4, 4
    rows, previous = [], bytearray(stride)
    for y in range(size):
        start = y * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for x in range(stride):
            left = line[x - bpp] if x >= bpp else 0
            up = previous[x]
            upleft = previous[x - bpp] if x >= bpp else 0
            if kind == 1:
                line[x] = (line[x] + left) & 255
            elif kind == 2:
                line[x] = (line[x] + up) & 255
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 255
            elif kind == 4:
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                line[x] = (line[x] + (left if pa <= pb and pa <= pc else up if pb <= pc else upleft)) & 255
        rows.append(bytes(line[:size * 4]))
        previous = line

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    body = b"".join(b"\x00" + row for row in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(body, 9)) + chunk(b"IEND", b""))


def build_icns(images):
    body = b"".join(kind.encode("ascii") + struct.pack(">I", len(images[size]) + 8) + images[size]
                    for kind, size in ICNS_ENTRIES)
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main():
    assets = HERE / "AppIcon.icon" / "Assets"
    assets.mkdir(parents=True, exist_ok=True)
    for name in ORDER:
        (assets / f"{name}.svg").write_text(svg(layer(name)), encoding="utf-8")
    (HERE.parent / "Resources" / "brand-mark.svg").write_text(brand_mark(), encoding="utf-8")

    chrome = find_chrome()
    composite = legacy_composite()
    with tempfile.TemporaryDirectory(prefix="wlsaplus-icon-") as temporary:
        workdir = pathlib.Path(temporary)
        images = {size: rasterize(chrome, composite, size, workdir) for size in sorted({s for _, s in ICNS_ENTRIES})}
        for size, data in images.items():
            assert png_size(data) == (size, size), size
        if "--previews" in sys.argv:
            previews = HERE / "previews"
            previews.mkdir(exist_ok=True)
            for size in (1024, 128, 32, 16):
                (previews / f"legacy-{size}.png").write_bytes(images[size])
    (HERE / "AppIcon.icns").write_bytes(build_icns(images))
    print(f"Wrote {len(ORDER)} layers, brand-mark.svg and AppIcon.icns ({(HERE / 'AppIcon.icns').stat().st_size} bytes).")


if __name__ == "__main__":
    main()
