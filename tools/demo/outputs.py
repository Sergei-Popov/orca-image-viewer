"""Turns the rendered scene into demo files: a multi-part OpenEXR with render passes, a Radiance
HDR, an sRGB PNG, a HEIC (macOS sips) and the parts of a DNG (JPEG previews and a Bayer mosaic,
which tools/demo/containers.ts wraps into the DNG).

    python3 tools/demo/outputs.py <dir with scene.npz>
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import OpenEXR as E
from PIL import Image


def aces(x):
    v = x * 0.6
    return np.clip(v * (2.51 * v + 0.03) / (v * (2.43 * v + 0.59) + 0.14), 0, 1)


def oetf(v):
    return np.where(v <= 0.0031308, 12.92 * v, 1.055 * np.power(np.clip(v, 0, None), 1 / 2.4) - 0.055)


def srgb8(linear, exposure=0.0):
    return (oetf(aces(linear * 2**exposure)) * 255 + 0.5).astype(np.uint8)


def write_exr(path, beauty, depth, normal, albedo):
    h, w, _ = beauty.shape
    half = lambda a: np.ascontiguousarray(a.astype(np.float16))
    beauty_part = E.Part(
        {'compression': E.PIZ_COMPRESSION, 'type': E.scanlineimage, 'comments': 'Image Viewer demo: spheres on a plain at sunset, rendered in linear light'},
        {'R': half(beauty[..., 0]), 'G': half(beauty[..., 1]), 'B': half(beauty[..., 2]), 'A': half(np.ones((h, w)))},
        'beauty',
    )
    aov_part = E.Part(
        {'compression': E.ZIP_COMPRESSION, 'type': E.scanlineimage},
        {
            'depth.Z': np.ascontiguousarray(depth.astype(np.float32)),
            'normal.X': half(normal[..., 0]),
            'normal.Y': half(normal[..., 1]),
            'normal.Z': half(normal[..., 2]),
            'albedo.R': half(albedo[..., 0]),
            'albedo.G': half(albedo[..., 1]),
            'albedo.B': half(albedo[..., 2]),
        },
        'passes',
    )
    E.File([beauty_part, aov_part]).write(str(path))


def rle(values):
    """Radiance's per-component run-length coding of one scanline component."""
    out = bytearray()
    i, n = 0, len(values)
    while i < n:
        run = 1
        while i + run < n and run < 127 and values[i + run] == values[i]:
            run += 1
        if run >= 4:
            out += bytes([128 + run, values[i]])
            i += run
            continue
        start = i
        while i < n and i - start < 128:
            if i + 3 < n and values[i] == values[i + 1] == values[i + 2] == values[i + 3]:
                break
            i += 1
        out += bytes([i - start]) + bytes(values[start:i])
    return bytes(out)


def write_hdr(path, linear):
    h, w, _ = linear.shape
    m = linear.max(axis=2)
    e = np.zeros((h, w), np.int32)
    mant = np.zeros((h, w), np.float64)
    ok = m > 1e-32
    mant[ok], e[ok] = np.frexp(m[ok])
    scale = np.where(ok, mant * 256 / np.where(ok, m, 1), 0)
    rgbe = np.zeros((h, w, 4), np.uint8)
    rgbe[..., :3] = np.clip(linear * scale[..., None], 0, 255).astype(np.uint8)
    rgbe[..., 3] = np.where(ok, e + 128, 0)
    with open(path, 'wb') as f:
        f.write(b'#?RADIANCE\n# Image Viewer demo scene\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n')
        f.write(f'-Y {h} +X {w}\n'.encode())
        for y in range(h):
            f.write(bytes([2, 2, w >> 8, w & 255]))
            for c in range(4):
                f.write(rle(rgbe[y, :, c].tolist()))


def main():
    out = Path(sys.argv[1])
    z = np.load(out / 'scene.npz')
    beauty, depth, normal, albedo = z['beauty'], z['depth'], z['normal'], z['albedo']
    h, w, _ = beauty.shape
    write_exr(out / 'sunset-render.exr', beauty, depth, normal, albedo)
    write_hdr(out / 'sunset.hdr', beauty)
    picture = Image.fromarray(srgb8(beauty))
    picture.save(out / 'sunset.png')
    subprocess.run(['sips', '-s', 'format', 'heic', '-s', 'formatOptions', '80', str(out / 'sunset.png'), '--out', str(out / 'sunset.heic')], check=True, capture_output=True)

    # DNG parts: a full-size and a small JPEG preview, an RGB thumbnail, a 12-bit RGGB mosaic.
    dng = out / 'dng'
    dng.mkdir(exist_ok=True)
    picture.save(dng / 'preview.jpg', quality=90)
    picture.resize((w // 4, h // 4), Image.LANCZOS).save(dng / 'preview-small.jpg', quality=85)
    thumb = picture.resize((256, 160), Image.LANCZOS)
    (dng / 'thumbnail.rgb').write_bytes(np.asarray(thumb).tobytes())
    black, white = 256, 4095
    sensor = np.clip(beauty * 0.42, 0, 1)
    mosaic = np.zeros((h, w), np.float64)
    mosaic[0::2, 0::2] = sensor[0::2, 0::2, 0]
    mosaic[0::2, 1::2] = sensor[0::2, 1::2, 1]
    mosaic[1::2, 0::2] = sensor[1::2, 0::2, 1]
    mosaic[1::2, 1::2] = sensor[1::2, 1::2, 2]
    raw = (black + mosaic * (white - black) + 0.5).astype('<u2')
    (dng / 'mosaic.u16').write_bytes(raw.tobytes())
    (dng / 'meta.json').write_text(json.dumps({'width': w, 'height': h, 'thumb': [256, 160], 'black': black, 'white': white}))
    print('ok', out)


if __name__ == '__main__':
    main()
