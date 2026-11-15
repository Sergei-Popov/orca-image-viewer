"""Draws the layers of a demo poster (a fictional open-air cinema night) and writes them as raw
RGBA files with layers.json, for tools/demo/containers.ts to wrap into a layered PSD. Text is set
in Aileron, the CC0 font bundled with Pillow.

    python3 tools/demo/poster.py <out-dir>
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1600, 1000


def blank():
    return Image.new('RGBA', (W, H), (0, 0, 0, 0))


def sky():
    y = np.linspace(0, 1, H)[:, None]
    top = np.array([24, 28, 74])
    mid = np.array([132, 62, 120])
    low = np.array([246, 150, 92])
    t1 = np.clip(y / 0.62, 0, 1)
    t2 = np.clip((y - 0.62) / 0.38, 0, 1)
    c = top * (1 - t1[..., None]) + mid * t1[..., None]
    c = c * (1 - t2[..., None]) + low * t2[..., None]
    c = np.broadcast_to(c, (H, W, 3))
    # Stars in the upper sky.
    rng = np.random.default_rng(3)
    c = c.copy()
    for _ in range(260):
        x, yy = rng.integers(0, W), rng.integers(0, int(H * 0.45))
        b = rng.uniform(0.3, 1) * (1 - yy / (H * 0.45))
        c[yy, x] = c[yy, x] * (1 - b) + 255 * b
    a = np.full((H, W, 1), 255)
    return Image.fromarray(np.concatenate([c, a], axis=2).astype(np.uint8), 'RGBA')


def sun():
    im = blank()
    d = ImageDraw.Draw(im)
    d.ellipse((1040, 470, 1300, 730), fill=(255, 214, 140, 255))
    return im


def glow():
    y, x = np.mgrid[0:H, 0:W]
    r = np.hypot(x - 1170, y - 600) / 520
    a = np.clip(np.exp(-r * r * 2.2), 0, 1)
    rgb = np.stack([255 * np.ones_like(a), 170 * np.ones_like(a), 110 * np.ones_like(a)], axis=2)
    return Image.fromarray(np.concatenate([rgb, (a * 255)[..., None]], axis=2).astype(np.uint8), 'RGBA')


def ridge(seed, base, amp, colour, haze):
    rng = np.random.default_rng(seed)
    x = np.arange(W)
    h = np.zeros(W)
    for k in range(1, 7):
        h += rng.uniform(0.4, 1) / k * np.sin(x / W * np.pi * (k * 1.7 + rng.uniform(0, 2)) + rng.uniform(0, 6))
    h = base - h * amp
    y = np.arange(H)[:, None]
    inside = y >= h[None, :]
    depth = np.clip((y - h[None, :]) / 260, 0, 1)
    c = np.array(colour) * (1 - haze * (1 - depth[..., None]))  + np.array([246, 150, 92]) * haze * (1 - depth[..., None])
    a = inside * 255
    return Image.fromarray(np.concatenate([c, a[..., None]], axis=2).astype(np.uint8), 'RGBA')


def grain():
    rng = np.random.default_rng(11)
    n = rng.normal(0.86, 0.07, (H, W)).clip(0, 1)
    n = np.asarray(Image.fromarray((n * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))).astype(np.float64)
    rgb = np.stack([n, n * 0.97, n * 0.92], axis=2)
    return Image.fromarray(np.concatenate([rgb, np.full((H, W, 1), 255)], axis=2).astype(np.uint8), 'RGBA')


def text(lines):
    im = blank()
    d = ImageDraw.Draw(im)
    for (x, y), size, fill, s, spacing in lines:
        font = ImageFont.load_default(size)
        cx = x
        for ch in s:
            d.text((cx, y), ch, font=font, fill=fill)
            cx += font.getlength(ch) + spacing
    return im


def badge():
    im = blank()
    d = ImageDraw.Draw(im)
    cx, cy, r = 1420, 170, 96
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(250, 236, 214, 255))
    d.ellipse((cx - r + 10, cy - r + 10, cx + r - 10, cy + r - 10), outline=(196, 74, 66, 255), width=4)
    for s, size, dy in (('NIGHT', 26, -46), ('No. 7', 52, -18), ('FREE ENTRY', 18, 40)):
        font = ImageFont.load_default(size)
        w = font.getlength(s)
        d.text((cx - w / 2, cy + dy), s, font=font, fill=(160, 52, 52, 255))
    return im.rotate(-12, center=(cx, cy), resample=Image.BICUBIC)


def guides():
    im = blank()
    d = ImageDraw.Draw(im)
    for x in range(0, W, 100):
        d.line((x, 0, x, H), fill=(0, 220, 255, 140), width=1)
    for y in range(0, H, 100):
        d.line((0, y, W, y), fill=(0, 220, 255, 140), width=1)
    return im


def over(base, top, opacity=1.0, mode='normal'):
    b = base.astype(np.float64) / 255
    t = top.astype(np.float64) / 255
    a = t[..., 3:4] * opacity
    if mode == 'multiply':
        mixed = b[..., :3] * t[..., :3]
    elif mode == 'screen':
        mixed = 1 - (1 - b[..., :3]) * (1 - t[..., :3])
    else:
        mixed = t[..., :3]
    out = b.copy()
    out[..., :3] = b[..., :3] * (1 - a) + mixed * a
    return (out * 255 + 0.5).astype(np.uint8)


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    cream = (250, 238, 218, 255)
    layers = [
        ('Sky', sky(), {}),
        ('Sun', sun(), {}),
        ('Sun glow', glow(), {'blend': 'scrn', 'opacity': 0.7}),
        ('</Layer group>', None, {'section': 3}),
        ('Far range', ridge(5, 690, 70, (122, 70, 112), 0.55), {}),
        ('Middle range', ridge(8, 780, 90, (74, 42, 86), 0.35), {}),
        ('Near range', ridge(13, 880, 70, (34, 22, 48), 0.12), {}),
        ('Mountains', None, {'section': 1}),
        ('Paper grain', grain(), {'blend': 'mul ', 'opacity': 0.35}),
        ('Title', text([((96, 96), 132, cream, 'DESERT LIGHT', 10)]), {'marker': 'TySh'}),
        ('Dates', text([((102, 262), 40, cream, 'Open-air cinema  ·  12-14 June  ·  after sunset', 3)]), {'marker': 'TySh'}),
        ('Badge', badge(), {'marker': 'SoLd'}),
        ('Guides', guides(), {'hidden': True}),
    ]
    composite = np.zeros((H, W, 4), np.uint8)
    composite[..., 3] = 255
    spec = []
    for i, (name, im, opts) in enumerate(layers):
        if im is None:
            spec.append({'name': name, 'left': 0, 'top': 0, 'width': 0, 'height': 0, 'file': '', **opts})
            continue
        arr = np.asarray(im)
        if not opts.get('hidden'):
            mode = {'scrn': 'screen', 'mul ': 'multiply'}.get(opts.get('blend', ''), 'normal')
            composite = over(composite, arr, opts.get('opacity', 1.0), mode)
        ys, xs = np.nonzero(arr[..., 3])
        top, bottom, left, right = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        file = f'layer-{i:02d}.rgba'
        (out / file).write_bytes(np.ascontiguousarray(arr[top:bottom, left:right]).tobytes())
        spec.append({'name': name, 'left': int(left), 'top': int(top), 'width': int(right - left), 'height': int(bottom - top), 'file': file, **opts})
    (out / 'composite.rgba').write_bytes(composite.tobytes())
    Image.fromarray(composite[..., :3]).save(out / 'composite.png')
    (out / 'layers.json').write_text(json.dumps({'width': W, 'height': H, 'composite': 'composite.rgba', 'out': 'desert-light-poster.psd', 'layers': spec}, indent=1))
    print('ok', out)


if __name__ == '__main__':
    main()
