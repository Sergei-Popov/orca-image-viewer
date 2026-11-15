"""Demo textures and a terrain: a BC1 brick texture with its MIP chain and an RGBA16F sky cube map
(DDS), and a multi-page GeoTIFF-like terrain (hillshade, float32 elevation with predictor 3,
16-bit slope) with reduced-resolution sub-IFDs. All procedural.

    python3 tools/demo/textures.py <out-dir>
"""

import struct
import sys
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scene import sky  # noqa: E402


def value_noise(shape, cells, rng):
    """Smooth noise: random values on a grid, bicubic-upsampled."""
    small = rng.random((cells[0] + 3, cells[1] + 3)).astype(np.float32)
    big = Image.fromarray(small, 'F').resize((shape[1] + shape[1] // cells[1] * 3, shape[0] + shape[0] // cells[0] * 3), Image.BICUBIC)
    a = np.asarray(big)
    oy, ox = shape[0] // cells[0], shape[1] // cells[1]
    return a[oy : oy + shape[0], ox : ox + shape[1]]


def fbm(shape, rng, octaves=7, base=4):
    out = np.zeros(shape, np.float32)
    amp, total = 1.0, 0.0
    for k in range(octaves):
        c = base * 2**k
        out += value_noise(shape, (min(c, shape[0] // 2), min(c, shape[1] // 2)), rng) * amp
        total += amp
        amp *= 0.5
    return out / total


# --- DDS -------------------------------------------------------------------------------------


def dds_header(width, height, mips, fourcc=None, dxgi=None, cube=False):
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | (0x20000 if mips > 1 else 0) | 0x80000
    linear = 0
    h = struct.pack('<4sIIIIIII', b'DDS ', 124, flags, height, width, linear, 0, mips) + b'\0' * 44
    code = b'DX10' if dxgi is not None else fourcc.encode()
    h += struct.pack('<II4sIIIII', 32, 4, code, 0, 0, 0, 0, 0)
    caps = 0x1000 | (0x400008 if mips > 1 else 0) | (0x8 if cube else 0)
    caps2 = (0x200 | 0xFC00) if cube else 0
    h += struct.pack('<IIIII', caps, caps2, 0, 0, 0)
    if dxgi is not None:
        h += struct.pack('<IIIII', dxgi, 3, 0x4 if cube else 0, 1, 0)
    return h


def to565(c):
    c = np.clip(np.round(c), 0, 255).astype(np.int32)
    return ((c[..., 0] >> 3) << 11) | ((c[..., 1] >> 2) << 5) | (c[..., 2] >> 3)


def from565(v):
    r = (v >> 11) & 31
    g = (v >> 5) & 63
    b = v & 31
    return np.stack([(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)], axis=-1).astype(np.float64)


def bc1(rgb):
    """BC1 blocks for an RGB image (sides multiple of 4): endpoints along the block's principal
    axis, four-colour mode, nearest palette entry per pixel."""
    h, w, _ = rgb.shape
    blocks = rgb.reshape(h // 4, 4, w // 4, 4, 3).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 3).astype(np.float64)
    mean = blocks.mean(axis=1, keepdims=True)
    centred = blocks - mean
    cov = np.einsum('nki,nkj->nij', centred, centred)
    axis = np.ones((len(blocks), 3)) / np.sqrt(3)
    for _ in range(8):
        axis = np.einsum('nij,nj->ni', cov, axis)
        axis /= np.maximum(np.linalg.norm(axis, axis=1, keepdims=True), 1e-9)
    proj = np.einsum('nki,ni->nk', centred, axis)
    lo = mean[:, 0] + axis * proj.min(axis=1, keepdims=True)
    hi = mean[:, 0] + axis * proj.max(axis=1, keepdims=True)
    c0, c1 = to565(hi), to565(lo)
    # Four-colour mode needs c0 > c1; equal endpoints give a flat block.
    swap = c0 < c1
    c0, c1 = np.where(swap, c1, c0), np.where(swap, c0, c1)
    e0, e1 = from565(c0), from565(c1)
    palette = np.stack([e0, e1, (2 * e0 + e1) / 3, (e0 + 2 * e1) / 3], axis=1)
    d = ((blocks[:, :, None, :] - palette[:, None, :, :]) ** 2).sum(axis=-1)
    idx = d.argmin(axis=2)
    idx = np.where((c0 == c1)[:, None], 0, idx)
    bits = (idx.astype(np.uint32) << (2 * np.arange(16, dtype=np.uint32))).sum(axis=1).astype('<u4')
    out = np.zeros((len(blocks), 8), np.uint8)
    out[:, 0:2] = c0.astype('<u2').view(np.uint8).reshape(-1, 2)
    out[:, 2:4] = c1.astype('<u2').view(np.uint8).reshape(-1, 2)
    out[:, 4:8] = bits.view(np.uint8).reshape(-1, 4)
    return out.tobytes()


def bricks(size, rng):
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    bh, bw, mortar = size / 8, size / 4, size / 128
    row = np.floor(y / bh)
    xs = x + (row % 2) * bw / 2
    col = np.floor(xs / bw)
    in_mortar = ((y % bh) < mortar) | ((xs % bw) < mortar)
    tone = rng.uniform(0.75, 1.15, (9, 9))[row.astype(int) % 9, col.astype(int) % 9]
    grain = fbm((size, size), rng, octaves=5, base=8)
    base = np.array([150, 66, 46]) * (tone * (0.8 + 0.4 * grain))[..., None]
    mortar_c = np.array([196, 188, 172]) * (0.85 + 0.3 * grain)[..., None]
    rgb = np.where(in_mortar[..., None], mortar_c, base)
    # Soft shading at brick edges.
    edge = np.minimum((y % bh) / mortar, 1) * np.minimum((xs % bw) / mortar, 1)
    return np.clip(rgb * (0.82 + 0.18 * edge)[..., None], 0, 255)


def write_bricks(out):
    rng = np.random.default_rng(21)
    size = 512
    img = bricks(size, rng).astype(np.float32)
    data = b''
    mips = 0
    level = img
    while True:
        data += bc1(level)
        mips += 1
        if level.shape[0] <= 4:
            break
        n = level.shape[0] // 2
        level = np.asarray(Image.fromarray(level.astype(np.uint8)).resize((n, n), Image.BOX)).astype(np.float32)
    (out / 'brick-wall.dds').write_bytes(dds_header(size, size, mips, fourcc='DXT1') + data)


FACES = [  # +X, -X, +Y, -Y, +Z, -Z: direction = forward + u * right + v * down
    ((1, 0, 0), (0, 0, -1), (0, -1, 0)),
    ((-1, 0, 0), (0, 0, 1), (0, -1, 0)),
    ((0, 1, 0), (1, 0, 0), (0, 0, 1)),
    ((0, -1, 0), (1, 0, 0), (0, 0, -1)),
    ((0, 0, 1), (1, 0, 0), (0, -1, 0)),
    ((0, 0, -1), (-1, 0, 0), (0, -1, 0)),
]


def write_sky_cube(out):
    size = 128
    mips = 8  # 128 … 1
    data = b''
    for fwd, right, down in FACES:
        v, u = np.mgrid[0:size, 0:size]
        u = (u + 0.5) / size * 2 - 1
        v = (v + 0.5) / size * 2 - 1
        d = np.array(fwd)[None, None] + u[..., None] * np.array(right) + v[..., None] * np.array(down)
        d = d / np.linalg.norm(d, axis=-1, keepdims=True)
        c = sky(d.reshape(-1, 3), disk=True).reshape(size, size, 3)
        level = np.concatenate([c, np.ones((size, size, 1))], axis=-1)
        for m in range(mips):
            data += level.astype('<f2').tobytes()
            if level.shape[0] > 1:
                n = level.shape[0] // 2
                level = level.reshape(n, 2, n, 2, 4).mean(axis=(1, 3))
    (out / 'sunset-sky-cube.dds').write_bytes(dds_header(size, size, mips, dxgi=10, cube=True) + data)


# --- TIFF terrain ----------------------------------------------------------------------------


def terrain(out):
    rng = np.random.default_rng(42)
    h, w = 900, 1440
    n = fbm((h, w), rng, octaves=8, base=3)
    ridges = 1 - np.abs(fbm((h, w), rng, octaves=6, base=4) * 2 - 1)
    elev = (n * 0.45 + ridges**3 * 0.95) * 3600 + 300  # metres
    elev = elev.astype(np.float32)
    # A lake: flat water below 1150 m.
    # A lake fills the lowest ground; colours follow the elevation's percentiles.
    sea = np.percentile(elev, 6)
    water = elev < sea
    elev[water] = sea
    gy, gx = np.gradient(elev, 20.0)  # 20 m cells
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    az, alt = np.radians(315), np.radians(40)
    aspect = np.arctan2(-gx, gy)
    shade = np.sin(alt) * np.cos(np.radians(slope)) + np.cos(alt) * np.sin(np.radians(slope)) * np.cos(az - aspect)
    shade = np.clip(shade, 0, 1)
    stops = np.percentile(elev, [6, 30, 55, 78, 90, 97])
    colours = np.array([[86, 128, 74], [128, 156, 88], [176, 164, 112], [150, 118, 92], [136, 128, 124], [246, 246, 250]], np.float32)
    tint = np.stack([np.interp(elev, stops, colours[:, k]) for k in range(3)], axis=-1)
    rgb = tint * (0.5 + 0.6 * shade[..., None])
    rgb[water] = np.array([58, 104, 150]) * (0.9 + 0.1 * shade[water, None])
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)

    def reduced(a, f):
        im = Image.fromarray(a)
        return np.asarray(im.resize((a.shape[1] // f, a.shape[0] // f), Image.BOX))

    common = dict(software='Image Viewer demo', datetime='2026:10:02 09:15:00', resolution=(72, 72))
    geo = {
        'extratags': [
            (33550, 'd', 3, (20.0, 20.0, 0.0), True),  # ModelPixelScale
            (33922, 'd', 6, (0, 0, 0, 512000.0, 4510000.0, 0), True),  # ModelTiepoint
        ]
    }
    with tifffile.TiffWriter(out / 'alpine-terrain.tif') as tif:
        tif.write(rgb, photometric='rgb', compression='zlib', predictor=2, tile=(256, 256), subifds=2,
                  description='Shaded relief of a procedural mountain range', metadata=None,
                  extratags=[(285, 's', 0, 'Shaded relief', True)] + geo['extratags'], **common)
        tif.write(reduced(rgb, 2), photometric='rgb', compression='zlib', predictor=2, subfiletype=1, metadata=None)
        tif.write(reduced(rgb, 4), photometric='rgb', compression='zlib', predictor=2, subfiletype=1, metadata=None)
        tif.write(elev, photometric='minisblack', compression='zlib', predictor=3, tile=(256, 256), metadata=None,
                  extratags=[(285, 's', 0, 'Elevation (m)', True), (42113, 's', 0, '-9999', True)] + geo['extratags'], **common)
        slope16 = np.round(slope / 90 * 65535).astype(np.uint16)
        tif.write(slope16, photometric='minisblack', compression='lzw', metadata=None,
                  extratags=[(285, 's', 0, 'Slope (0-90 degrees)', True)], **common)


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    write_bricks(out)
    write_sky_cube(out)
    terrain(out)
    print('ok', out)


if __name__ == '__main__':
    main()
