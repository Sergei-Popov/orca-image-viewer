// OpenEXR luminance/chroma (Y, RY, BY) to RGB as OpenEXR's RGBA interface reads it
// (ImfRgbaYca.cpp and RgbaInputFile::FromYca): chroma sampled on every second pixel and line is
// rebuilt with a 27-tap filter, converted with the luminance weights of the file's primaries,
// and over-saturated pixels next to colour edges are toned down. OpenEXR keeps every step in
// half floats, and so does this, so the result matches it value for value.

import { halfToFloat, toHalf } from '../core/half'

const f = Math.fround
/** A float rounded to the nearest half, as OpenEXR stores each step. */
const half = (v: number) => halfToFloat(toHalf(v))

/** The weights of chroma samples 1, 3, 5 … 13 positions away (reconstructChromaHoriz/Vert). */
const TAPS = [0.627123, -0.186077, 0.087929, -0.043159, 0.019597, -0.00754, 0.002128].map(f)

/** Rec. 709 primaries and D65 white: OpenEXR's default chromaticities. */
const REC709 = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329]

/**
 * The luminance weights of a set of primaries (OpenEXR's computeYw: the Y row of RGBtoXYZ,
 * normalised), from a `chromaticities` attribute (red, green, blue and white x, y) or Rec. 709.
 */
export function lumaWeights(chromaticities: readonly number[] | null): [number, number, number] {
  const c = (chromaticities && chromaticities.length >= 8 && chromaticities.every(Number.isFinite) ? chromaticities : REC709).map(f)
  const [rx, ry, gx, gy, bx, by, wx, wy] = c
  const X = f(wx / wy)
  const Z = f(f(f(1 - wx) - wy) / wy)
  const XZ = f(X + Z)
  const d = f(f(f(rx * f(by - gy)) + f(bx * f(gy - ry))) + f(gx * f(ry - by)))
  const sr = f(f(f(f(X * f(by - gy)) - f(gx * f(f(by - 1) + f(by * XZ)))) + f(bx * f(f(gy - 1) + f(gy * XZ)))) / d)
  const sg = f(f(f(f(X * f(ry - by)) + f(rx * f(f(by - 1) + f(by * XZ)))) - f(bx * f(f(ry - 1) + f(ry * XZ)))) / d)
  const sb = f(f(f(f(X * f(gy - ry)) - f(rx * f(f(gy - 1) + f(gy * XZ)))) + f(gx * f(f(ry - 1) + f(ry * XZ)))) / d)
  const w = [f(sr * ry), f(sg * gy), f(sb * by)]
  const sum = f(f(w[0] + w[1]) + w[2])
  const yw = w.map((v) => f(v / sum))
  // Degenerate primaries: fall back to Rec. 709 rather than show NaN.
  return yw.every((v) => Number.isFinite(v)) && sum !== 0 ? (yw as [number, number, number]) : lumaWeights(null)
}

const saturation = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b)
  return max > 0 ? f(1 - f(Math.min(r, g, b) / max)) : 0
}

/**
 * Converts in place: `out` holds `c` samples per pixel with Y, RY and BY in slots 0, 1 and 2 and
 * chroma replicated over its sampling; R, G and B take their place. `xs`/`ys` are the chroma
 * sampling and `x0`/`y0` the data window origin: chroma sampled every second column or line from
 * an even origin is filtered back as OpenEXR does, any other sampling stays replicated.
 */
export function ycaToRgb(out: Float32Array, W: number, H: number, c: number, xs: number, ys: number, x0: number, y0: number, yw: readonly number[]): void {
  const [wr, wg, wb] = yw
  const fx = xs === 2 && x0 % 2 === 0 && W > 1
  const fy = ys === 2 && y0 % 2 === 0 && H > 1
  // Lines past the edges repeat the first line, or the last but one (OpenEXR's yMax − 1); chroma
  // there comes from the nearest line that has it.
  const lineOf = (p: number) => (p < 0 ? 0 : p > H - 1 ? Math.max(0, H - 2) : p)
  // With an odd height the last but one line has no chroma; the last line does.
  const chromaLine = (p: number) => {
    const q = lineOf(p)
    return fy && q % 2 ? H - 1 : q
  }
  const lastX = fx ? (W % 2 ? W - 1 : W - 2) : W - 1

  const luma = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) luma[i] = out[i * c]

  // Chroma of each line that has it, rebuilt across the line (reconstructChromaHoriz).
  const rows = new Map<number, Float32Array>()
  const chromaRow = (y: number): Float32Array => {
    let row = rows.get(y)
    if (row) return row
    row = new Float32Array(W * 2)
    const at = (x: number, k: number) => out[(y * W + (x < 0 ? 0 : x > lastX ? lastX : x)) * c + 1 + k]
    for (let x = 0; x < W; x++) {
      for (let k = 0; k < 2; k++) {
        if (!fx || x % 2 === 0) {
          row[x * 2 + k] = at(x, k)
          continue
        }
        let s = f(at(x - 13, k) * TAPS[6])
        for (let t = 5; t >= 0; t--) s = f(s + f(at(x - 1 - 2 * t, k) * TAPS[t]))
        for (let t = 0; t < 7; t++) s = f(s + f(at(x + 1 + 2 * t, k) * TAPS[t]))
        row[x * 2 + k] = half(s)
      }
    }
    rows.set(y, row)
    return row
  }
  for (let y = 0; y < H; y++) if (!fy || y % 2 === 0) chromaRow(y)

  // RGB of line L (−1 … H), before the saturation fix (YCAtoRGBA after reconstructChromaVert).
  const rgbLine = (L: number): Float32Array => {
    const line = new Float32Array(W * 3)
    const yLine = lineOf(L)
    const between = fy && L % 2 !== 0
    const near = between ? null : chromaRow(chromaLine(L))
    const taps = between ? Array.from({ length: 14 }, (_, i) => chromaRow(chromaLine(L - 13 + 2 * i))) : []
    for (let x = 0; x < W; x++) {
      let ry: number, by: number
      if (near) {
        ry = near[x * 2]
        by = near[x * 2 + 1]
      } else {
        // Lines L − 13, L − 11 … L + 13, weighted as in reconstructChromaVert.
        const weight = (i: number) => TAPS[i < 7 ? 6 - i : i - 7]
        let r = f(taps[0][x * 2] * weight(0))
        let b = f(taps[0][x * 2 + 1] * weight(0))
        for (let i = 1; i < 14; i++) {
          r = f(r + f(taps[i][x * 2] * weight(i)))
          b = f(b + f(taps[i][x * 2 + 1] * weight(i)))
        }
        ry = half(r)
        by = half(b)
      }
      const Y = luma[yLine * W + x]
      if (ry === 0 && by === 0) {
        line[x * 3] = line[x * 3 + 1] = line[x * 3 + 2] = Y
      } else {
        const R = f(f(ry + 1) * Y)
        const B = f(f(by + 1) * Y)
        line[x * 3] = half(R)
        line[x * 3 + 1] = half(f(f(f(Y - f(R * wr)) - f(B * wb)) / wg))
        line[x * 3 + 2] = half(B)
      }
    }
    return line
  }

  // fixSaturation: a pixel much more saturated than its four diagonal neighbours is toned down.
  let above = rgbLine(-1)
  let here = rgbLine(0)
  for (let y = 0; y < H; y++) {
    const below = rgbLine(y + 1)
    const sat = (line: Float32Array, x: number) => {
      const i = (x < 0 ? 0 : x > W - 1 ? W - 1 : x) * 3
      return saturation(line[i], line[i + 1], line[i + 2])
    }
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * c
      let r = here[x * 3]
      let g = here[x * 3 + 1]
      let b = here[x * 3 + 2]
      const mean = Math.min(1, f(0.25 * f(f(f(sat(above, x - 1) + sat(above, x + 1)) + sat(below, x - 1)) + sat(below, x + 1))))
      const s = saturation(r, g, b)
      if (s > mean) {
        const most = Math.min(1, f(1 - f(f(1 - mean) * 0.25)))
        if (s > most) {
          const k = f(most / s)
          const max = Math.max(r, g, b)
          const yIn = f(f(f(r * wr) + f(g * wg)) + f(b * wb))
          const nr = half(Math.max(f(max - f(f(max - r) * k)), 0))
          const ng = half(Math.max(f(max - f(f(max - g) * k)), 0))
          const nb = half(Math.max(f(max - f(f(max - b) * k)), 0))
          const yOut = f(f(f(nr * wr) + f(ng * wg)) + f(nb * wb))
          ;[r, g, b] = yOut > 0 ? [nr, ng, nb].map((v) => half(f(v * f(yIn / yOut)))) : [nr, ng, nb]
        }
      }
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
    }
    above = here
    here = below
  }
}
