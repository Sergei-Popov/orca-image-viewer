// Raster operations the decoders share: EXIF orientation, colour model conversions without a
// colour profile (CMYK, CIELAB, YCbCr), value ranges and plane interleaving.

import { allocate, type Raster, type Samples } from './model'

/** Applies an EXIF orientation (1–8) by moving pixels; 5–8 swap width and height. */
export function orient(r: Raster, orientation: number): Raster {
  if (orientation <= 1 || orientation > 8) return r
  const { width: W, height: H, channels: c } = r
  const swap = orientation >= 5
  const w = swap ? H : W
  const h = swap ? W : H
  const src = r.data
  const out = allocate(r.kind, src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx: number, sy: number
      switch (orientation) {
        case 2: sx = W - 1 - x; sy = y; break
        case 3: sx = W - 1 - x; sy = H - 1 - y; break
        case 4: sx = x; sy = H - 1 - y; break
        case 5: sx = y; sy = x; break
        case 6: sx = y; sy = H - 1 - x; break
        case 7: sx = W - 1 - y; sy = H - 1 - x; break
        default: sx = W - 1 - y; sy = x; break // 8
      }
      const s = (sy * W + sx) * c
      const d = (y * w + x) * c
      for (let k = 0; k < c; k++) out[d + k] = src[s + k]
    }
  }
  return { ...r, width: w, height: h, data: out }
}

/** The largest value of a sample kind, as integers count. */
export function maxOf(r: Pick<Raster, 'kind'>): number {
  return r.kind === 'u8' ? 255 : r.kind === 'u16' ? 65535 : 1
}

/**
 * CMYK (0 = no ink) to RGB with the naive formula, keeping extra channels (alpha) after it.
 * `inverted` is for Adobe's convention where 0 means full ink (PSD, JPEG from Photoshop).
 */
export function cmykToRgb(src: Samples, kind: 'u8' | 'u16', pixels: number, channels: number, inverted = false): Samples {
  const max = kind === 'u8' ? 255 : 65535
  const extra = channels - 4
  const outChannels = 3 + extra
  const out = allocate(kind, pixels * outChannels)
  for (let i = 0, s = 0, d = 0; i < pixels; i++, s += channels, d += outChannels) {
    let C = src[s], M = src[s + 1], Y = src[s + 2], K = src[s + 3]
    if (inverted) {
      C = max - C; M = max - M; Y = max - Y; K = max - K
    }
    const k = (max - K) / max
    out[d] = Math.round((max - C) * k)
    out[d + 1] = Math.round((max - M) * k)
    out[d + 2] = Math.round((max - Y) * k)
    for (let e = 0; e < extra; e++) out[d + 3 + e] = src[s + 4 + e]
  }
  return out
}

const srgbEncode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)

/** CIE L*a*b* (D50) to sRGB through XYZ with Bradford adaptation to D65. */
export function labToRgb(L: number, a: number, b: number, out: number[] = [0, 0, 0]): number[] {
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const e = 216 / 24389
  const k = 24389 / 27
  const fx3 = fx * fx * fx
  const fz3 = fz * fz * fz
  const xr = fx3 > e ? fx3 : (116 * fx - 16) / k
  const yr = L > k * e ? fy * fy * fy : L / k
  const zr = fz3 > e ? fz3 : (116 * fz - 16) / k
  const X = xr * 0.9642, Y = yr, Z = zr * 0.8249
  // XYZ (D50) → linear sRGB (D65), Bradford-adapted matrix.
  const R = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z
  const G = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z
  const B = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z
  out[0] = Math.min(1, Math.max(0, srgbEncode(R)))
  out[1] = Math.min(1, Math.max(0, srgbEncode(G)))
  out[2] = Math.min(1, Math.max(0, srgbEncode(B)))
  return out
}

/** YCbCr to RGB with the given luma coefficients and full or video range, 8-bit. */
export function yccToRgb(Y: number, Cb: number, Cr: number, kr = 0.299, kb = 0.114, out: number[] = [0, 0, 0]): number[] {
  const kg = 1 - kr - kb
  const cb = Cb - 128
  const cr = Cr - 128
  const r = Y + 2 * (1 - kr) * cr
  const b = Y + 2 * (1 - kb) * cb
  const g = (Y - kr * r - kb * b) / kg
  out[0] = Math.min(255, Math.max(0, Math.round(r)))
  out[1] = Math.min(255, Math.max(0, Math.round(g)))
  out[2] = Math.min(255, Math.max(0, Math.round(b)))
  return out
}

/** Smallest and largest finite colour value (alpha excluded). */
export function valueRange(r: Raster): [number, number] {
  const colour = r.color === 'rgb' ? 3 : 1
  let lo = Infinity
  let hi = -Infinity
  const d = r.data
  const step = r.channels
  for (let i = 0; i < d.length; i += step) {
    for (let k = 0; k < colour; k++) {
      const v = d[i + k]
      if (v < lo && Number.isFinite(v)) lo = v
      if (v > hi && Number.isFinite(v)) hi = v
    }
  }
  if (lo === Infinity) return [0, 1]
  return [lo, hi]
}

/** Separate planes (one array per channel) to one interleaved array. */
export function interleave<T extends Samples>(planes: readonly T[], out: T): T {
  const c = planes.length
  const n = planes[0]?.length ?? 0
  for (let k = 0; k < c; k++) {
    const p = planes[k]
    for (let i = 0, d = k; i < n; i++, d += c) out[d] = p[i]
  }
  return out
}

/** 8-bit RGBA from a browser decoder without its (opaque) alpha channel. */
export function dropAlpha(r: Raster): Raster {
  if (r.channels !== 4 || r.kind !== 'u8') return r
  const n = r.width * r.height
  const out = new Uint8Array(n * 3)
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 4, d += 3) {
    out[d] = r.data[s]
    out[d + 1] = r.data[s + 1]
    out[d + 2] = r.data[s + 2]
  }
  return { ...r, channels: 3, data: out, alpha: false, premultiplied: false, names: ['R', 'G', 'B'] }
}

/** Whether every alpha value of an 8-bit RGBA raster is 255. */
export function opaque(r: Raster): boolean {
  if (!r.alpha || r.kind !== 'u8') return !r.alpha
  for (let i = r.channels - 1; i < r.data.length; i += r.channels) if (r.data[i] !== 255) return false
  return true
}
