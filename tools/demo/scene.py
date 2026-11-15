"""Renders the demo scene: spheres on a plain at sunset, in linear light, with depth, normals and
albedo. A small ray tracer in numpy: sun with shadows, a glowing lamp, sky light through ambient
occlusion and one mirror bounce. Everything in it is made here.

    python3 tools/demo/scene.py <out-dir> [width height [samples ao-samples]]

samples × samples rays per pixel (default 2) and ao-samples sky-light rays per hit (default 6); the
listing images use 4 and 16, which takes about a minute and leaves less grain.

Writes scene.npz (beauty, depth, normal, albedo as float32 arrays) for the other demo scripts.
"""

import sys
from pathlib import Path

import numpy as np

SUN = np.array([-0.55, 0.11, -1.0])
SUN /= np.linalg.norm(SUN)
SUN_RADIANCE = np.array([260.0, 170.0, 95.0])
SUN_IRRADIANCE = np.array([4.6, 3.3, 2.1])
LAMP = np.array([-0.15, 0.36, -4.3])
LAMP_RADIUS = 0.36
LAMP_EMISSION = np.array([16.0, 9.0, 4.2])
LAMP_POWER = np.array([5.0, 2.9, 1.3])

# Spheres: centre, radius, albedo, mirror reflectance (0 for matte).
SPHERES = [
    (np.array([-1.75, 1.0, -6.2]), 1.0, np.array([0.72, 0.30, 0.17]), 0.0),
    (np.array([0.75, 1.32, -7.7]), 1.32, np.array([0.9, 0.9, 0.92]), 0.92),
    (np.array([2.55, 0.62, -5.4]), 0.62, np.array([0.12, 0.47, 0.52]), 0.0),
    (np.array([1.35, 0.3, -4.1]), 0.3, np.array([0.85, 0.78, 0.32]), 0.0),
]


def sky(d, disk=True):
    """Radiance of the sky in directions d (n×3): a sunset gradient, a halo and the sun's disk."""
    up = np.clip(d[:, 1], -1, 1)
    t = np.clip(up, 0, 1) ** 0.45
    horizon = np.array([1.35, 0.55, 0.22])
    zenith = np.array([0.09, 0.15, 0.42])
    c = horizon * (1 - t)[:, None] + zenith * t[:, None]
    cos = np.clip(d @ SUN, -1, 1)
    angle = np.arccos(cos)
    c += np.array([3.2, 1.7, 0.7]) * np.exp(-angle * 9)[:, None]
    c += np.array([0.9, 0.45, 0.2]) * np.exp(-angle * 2.2)[:, None]
    if disk:
        c[angle < 0.028] = SUN_RADIANCE
    # Below the horizon (seen in reflections): the dusky far plain.
    c[up < 0] = np.array([0.32, 0.22, 0.16])
    return c


def ground_albedo(p):
    """Warm sand with soft stripes and grain, darker far away."""
    x, z = p[:, 0], p[:, 2]
    base = np.array([0.50, 0.40, 0.31])
    stripe = 0.06 * np.sin(x * 1.7 + np.sin(z * 0.9) * 1.3) + 0.04 * np.sin(z * 3.1 + x * 0.4)
    grain = 0.03 * np.sin(x * 23.0 + z * 17.0) * np.sin(z * 29.0 - x * 7.0)
    return base[None, :] * (1 + stripe + grain)[:, None]


def intersect(o, d, skip_lamp=False):
    """Nearest hit: distance, object index (-1 sky, 0 ground, 1.. spheres, 99 lamp)."""
    n = len(o)
    best = np.full(n, np.inf)
    obj = np.full(n, -1)
    # Ground plane y = 0.
    with np.errstate(divide='ignore', invalid='ignore'):
        t = -o[:, 1] / d[:, 1]
    hit = (t > 1e-4) & (d[:, 1] < 0)
    best[hit] = t[hit]
    obj[hit] = 0
    spheres = [(c, r) for c, r, _, _ in SPHERES] + ([] if skip_lamp else [(LAMP, LAMP_RADIUS)])
    for k, (c, r) in enumerate(spheres):
        oc = o - c
        b = np.einsum('ij,ij->i', oc, d)
        q = np.einsum('ij,ij->i', oc, oc) - r * r
        disc = b * b - q
        ok = disc > 0
        s = np.sqrt(np.where(ok, disc, 0))
        t = -b - s
        t = np.where(t > 1e-4, t, -b + s)
        hit = ok & (t > 1e-4) & (t < best)
        best[hit] = t[hit]
        obj[hit] = k + 1 if k < len(SPHERES) else 99
    return best, obj


def normal_at(p, obj):
    n = np.zeros_like(p)
    n[obj == 0] = [0, 1, 0]
    for k, (c, r, _, _) in enumerate(SPHERES):
        m = obj == k + 1
        n[m] = (p[m] - c) / r
    m = obj == 99
    n[m] = (p[m] - LAMP) / LAMP_RADIUS
    return n


def albedo_at(p, obj):
    a = np.zeros_like(p)
    m = obj == 0
    a[m] = ground_albedo(p[m])
    for k, (_, _, alb, _) in enumerate(SPHERES):
        a[obj == k + 1] = alb
    return a


def occluded(p, d, max_t):
    t, _ = intersect(p, d, skip_lamp=True)
    return t < max_t


def hemisphere(n, rng, count):
    """Cosine-weighted directions around normals n, `count` per point (count×len(n)×3)."""
    out = []
    for _ in range(count):
        u1 = rng.random(len(n))
        u2 = rng.random(len(n))
        r = np.sqrt(u1)
        phi = 2 * np.pi * u2
        local = np.stack([r * np.cos(phi), np.sqrt(1 - u1), r * np.sin(phi)], axis=1)
        helper = np.where(np.abs(n[:, 1:2]) < 0.9, np.array([[0, 1, 0]]), np.array([[1, 0, 0]]))
        tx = np.cross(helper, n)
        tx /= np.linalg.norm(tx, axis=1, keepdims=True)
        tz = np.cross(n, tx)
        out.append(local[:, 0:1] * tx + local[:, 1:2] * n + local[:, 2:3] * tz)
    return out


def shade_diffuse(p, n, alb, rng, ao_samples):
    """Sun, lamp and sky light on matte surfaces."""
    lit = np.zeros_like(p)
    ndl = np.clip(n @ SUN, 0, None)
    facing = ndl > 0
    sun_vis = np.zeros(len(p))
    if facing.any():
        sun_vis[facing] = ~occluded(p[facing] + n[facing] * 1e-3, np.broadcast_to(SUN, (facing.sum(), 3)), np.inf)
    lit += SUN_IRRADIANCE[None, :] * (ndl * sun_vis)[:, None]
    # The lamp: a small sphere light, inverse square, with shadows.
    to = LAMP - p
    dist = np.linalg.norm(to, axis=1)
    ld = to / dist[:, None]
    ndl_l = np.clip(np.einsum('ij,ij->i', n, ld), 0, None)
    vis = ~occluded(p + n * 1e-3, ld, dist - LAMP_RADIUS)
    lit += LAMP_POWER[None, :] * (ndl_l * vis / np.maximum(dist, LAMP_RADIUS) ** 2)[:, None]
    # Sky light: cosine-weighted rays that reach the sky.
    sky_light = np.zeros_like(p)
    for d in hemisphere(n, rng, ao_samples):
        t, obj = intersect(p + n * 1e-3, d)
        # The sun and the lamp are counted as direct light above, so not here.
        sky_light += np.where((obj == -1)[:, None], sky(d, disk=False), 0) * 0.6
    lit += sky_light / ao_samples
    return alb * lit


def render(width, height, samples=2, ao_samples=6, seed=7):
    rng = np.random.default_rng(seed)
    eye = np.array([0.0, 1.35, 0.0])
    look = np.array([0.15, 0.85, -6.0])
    fwd = look - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    fov = np.tan(np.radians(46) / 2)
    aspect = width / height
    beauty = np.zeros((height, width, 3), np.float32)
    depth = np.zeros((height, width), np.float32)
    normal = np.zeros((height, width, 3), np.float32)
    albedo = np.zeros((height, width, 3), np.float32)
    rows = 50
    for y0 in range(0, height, rows):
        h = min(rows, height - y0)
        yy, xx = np.mgrid[y0 : y0 + h, 0:width].astype(np.float64)
        acc = np.zeros((h * width, 3))
        for sy in range(samples):
            for sx in range(samples):
                px = (xx.ravel() + (sx + rng.random(h * width)) / samples) / width * 2 - 1
                py = 1 - (yy.ravel() + (sy + rng.random(h * width)) / samples) / height * 2
                d = fwd[None, :] + right[None, :] * (px * fov * aspect)[:, None] + up[None, :] * (py * fov)[:, None]
                d /= np.linalg.norm(d, axis=1, keepdims=True)
                o = np.broadcast_to(eye, d.shape)
                c, first = trace(o, d, rng, ao_samples)
                acc += c
                if sy == 0 and sx == 0:
                    t, obj, p, n, alb = first
                    depth[y0 : y0 + h] = np.where(obj == -1, 0, t).reshape(h, width)
                    normal[y0 : y0 + h] = n.reshape(h, width, 3)
                    albedo[y0 : y0 + h] = alb.reshape(h, width, 3)
        beauty[y0 : y0 + h] = (acc / samples**2).reshape(h, width, 3)
        print(f'\r{y0 + h}/{height}', end='', file=sys.stderr)
    print(file=sys.stderr)
    return beauty, depth, normal, albedo


def trace(o, d, rng, ao_samples):
    t, obj = intersect(o, d)
    c = np.zeros((len(d), 3))
    sky_m = obj == -1
    c[sky_m] = sky(d[sky_m])
    lamp_m = obj == 99
    c[lamp_m] = LAMP_EMISSION
    p = o + d * np.where(np.isfinite(t), t, 0)[:, None]
    n = normal_at(p, obj)
    alb = albedo_at(p, obj)
    surf = (obj >= 0) & (obj != 99)
    mirror = np.zeros(len(d))
    for k, (_, _, _, refl) in enumerate(SPHERES):
        mirror[obj == k + 1] = refl
    matte = surf & (mirror == 0)
    if matte.any():
        c[matte] = shade_diffuse(p[matte], n[matte], alb[matte], rng, ao_samples)
    glossy = surf & (mirror > 0)
    if glossy.any():
        nd = np.einsum('ij,ij->i', d[glossy], n[glossy])
        r = d[glossy] - 2 * nd[:, None] * n[glossy]
        ro = p[glossy] + n[glossy] * 1e-3
        t2, obj2 = intersect(ro, r)
        c2 = np.zeros((len(r), 3))
        s2 = obj2 == -1
        c2[s2] = sky(r[s2])
        c2[obj2 == 99] = LAMP_EMISSION
        h2 = (obj2 >= 0) & (obj2 != 99)
        if h2.any():
            p2 = ro[h2] + r[h2] * t2[h2][:, None]
            n2 = normal_at(p2, obj2[h2])
            c2[h2] = shade_diffuse(p2, n2, albedo_at(p2, obj2[h2]), rng, max(2, ao_samples // 2))
        # A slightly warm metal with a Fresnel lift at grazing angles.
        fres = mirror[glossy] + (1 - mirror[glossy]) * (1 + nd) ** 5
        c[glossy] = c2 * fres[:, None] * np.array([1.0, 0.96, 0.9])
    return c, (t, obj, p, n, alb)


def main():
    out = Path(sys.argv[1])
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 1600
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 1000
    samples = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    ao_samples = int(sys.argv[5]) if len(sys.argv) > 5 else 6
    out.mkdir(parents=True, exist_ok=True)
    beauty, depth, normal, albedo = render(width, height, samples, ao_samples)
    np.savez_compressed(out / 'scene.npz', beauty=beauty, depth=depth, normal=normal, albedo=albedo)
    print(out / 'scene.npz', float(beauty.max()), float(np.median(beauty)))


if __name__ == '__main__':
    main()
