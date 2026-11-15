// Turns raster samples into screen pixels: normalization by sample kind, black and white levels,
// exposure, a tone curve for HDR, sRGB encoding, and channel views. DOM-free, so it is tested in
// Node; the view runs it on tiles and on a small overview of the image.

import { halfTable } from '../core/half'
import type { Raster } from '../core/model'

export type ToneMap = 'clip' | 'reinhard' | 'aces'
export type ChannelView = 'rgb' | 'r' | 'g' | 'b' | 'a' | 'luma'

export interface Tone {
  /** Stops of exposure: values are multiplied by 2^exposure in linear light. */
  exposure: number
  map: ToneMap
  channel: ChannelView
  /** Levels in normalized units (0–1 for integers, raw values for floats). */
  black: number
  white: number
}

export const DEFAULT_TONE: Tone = { exposure: 0, map: 'clip', channel: 'rgb', black: 0, white: 1 }

/** The tone a raster opens with: its data range for measurements, identity otherwise. */
export function initialTone(r: Raster): Tone {
  if (r.transfer === 'data') {
    const [lo, hi] = normalizedRange(r)
    return { ...DEFAULT_TONE, black: lo, white: hi > lo ? hi : lo + 1 }
  }
  return { ...DEFAULT_TONE, map: r.transfer === 'linear' ? 'aces' : 'clip' }
}

/** Whether exposure and tone controls mean something for this raster. */
export function isHighRange(r: Raster): boolean {
  return r.transfer !== 'srgb' || r.kind !== 'u8'
}

/**
 * The tone controls a raster gets. Every image has levels with Auto (contrast, or exposure for
 * linear light) and a reset; exposure needs more than 8-bit display values; the curve, linear light.
 */
export function toneControls(r: Raster): { exposure: boolean; curve: boolean; auto: 'exposure' | 'contrast' } {
  return {
    exposure: isHighRange(r) && r.transfer !== 'data',
    curve: r.transfer === 'linear',
    auto: r.transfer === 'linear' ? 'exposure' : 'contrast'
  }
}

export function eotf(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function oetf(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** Narkowicz's fit of the ACES filmic curve. */
function aces(x: number): number {
  const v = x * 0.6
  return (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)
}

export function curve(map: ToneMap, x: number): number {
  if (!(x > 0)) return 0
  if (map === 'reinhard') return x / (1 + x)
  if (map === 'aces') return Math.min(1, aces(x))
  return x
}

const ENCODE_SIZE = 4096
let encodeTable: Uint8Array | null = null

/** sRGB encoding of 0–1 linear light to bytes, by table. */
function encodeLinear(): Uint8Array {
  if (encodeTable) return encodeTable
  encodeTable = new Uint8Array(ENCODE_SIZE + 1)
  for (let i = 0; i <= ENCODE_SIZE; i++) encodeTable[i] = Math.round(oetf(i / ENCODE_SIZE) * 255)
  return encodeTable
}

/** The divisor that brings integer samples to 0–1. */
export function sampleMax(r: Pick<Raster, 'kind' | 'bits'>): number {
  if (r.kind === 'u8') return 255
  if (r.kind === 'u16') return r.bits > 8 && r.bits < 16 ? 2 ** r.bits - 1 : 65535
  return 1
}

/** A table from raw sample values to normalized values, or null for 32-bit floats. */
export function normTable(r: Pick<Raster, 'kind' | 'bits'>): Float32Array | null {
  if (r.kind === 'f32') return null
  if (r.kind === 'f16') return halfTable()
  const size = r.kind === 'u8' ? 256 : 65536
  const max = sampleMax(r)
  const t = new Float32Array(size)
  for (let i = 0; i < size; i++) t[i] = i / max
  return t
}

/** Colour value (normalized) to an output byte, for one transfer and tone. */
export function makeColourFn(transfer: Raster['transfer'], tone: Tone): (n: number) => number {
  const span = tone.white - tone.black || 1
  const gain = Math.pow(2, tone.exposure)
  const enc = encodeLinear()
  const encode = (lin: number) => {
    const c = lin >= 1 ? 1 : lin > 0 ? lin : 0
    return enc[(c * ENCODE_SIZE + 0.5) | 0]
  }
  if (transfer === 'data') {
    return (n) => {
      const v = (n - tone.black) / span
      return v >= 1 ? 255 : v > 0 ? (v * 255 + 0.5) | 0 : 0
    }
  }
  if (transfer === 'linear') {
    const map = tone.map
    return (n) => encode(curve(map, ((n - tone.black) / span) * gain))
  }
  // Display-encoded values: levels on the encoded value, exposure in linear light.
  if (tone.exposure === 0) {
    return (n) => {
      const v = (n - tone.black) / span
      return v >= 1 ? 255 : v > 0 ? (v * 255 + 0.5) | 0 : 0
    }
  }
  return (n) => {
    const v = (n - tone.black) / span
    return encode(eotf(v >= 1 ? 1 : v > 0 ? v : 0) * gain)
  }
}

/** Linear light of a normalized colour value, before exposure (for the luminance view). */
function toLinearFn(transfer: Raster['transfer'], tone: Tone): (n: number) => number {
  const span = tone.white - tone.black || 1
  if (transfer === 'srgb') {
    return (n) => {
      const v = (n - tone.black) / span
      return eotf(v >= 1 ? 1 : v > 0 ? v : 0)
    }
  }
  return (n) => (n - tone.black) / span
}

/**
 * Renders the region `x0, y0, w, h` of `r` into `out` (RGBA bytes, `w * h * 4`), one source pixel
 * per output pixel.
 */
export function renderRegion(r: Raster, tone: Tone, x0: number, y0: number, w: number, h: number, out: Uint8ClampedArray): void {
  const c = r.channels
  const rgb = r.color === 'rgb'
  const hasAlpha = r.alpha
  const ai = c - 1
  const data = r.data
  const norm = normTable(r)
  const nv = norm ? (v: number) => norm[v] : (v: number) => v
  const view = tone.channel
  const pick = view === 'r' ? 0 : view === 'g' ? 1 : view === 'b' ? 2 : 0
  const colourOf = makeColourFn(r.transfer, tone)

  // Fast path: integer or half samples, straight alpha, no luminance: one table for everything.
  if (norm && !r.premultiplied && view !== 'luma') {
    const table = new Uint8Array(norm.length)
    for (let i = 0; i < norm.length; i++) table[i] = colourOf(norm[i])
    const alphaTable = new Uint8Array(norm.length)
    for (let i = 0; i < norm.length; i++) {
      const a = norm[i]
      alphaTable[i] = a >= 1 ? 255 : a > 0 ? (a * 255 + 0.5) | 0 : 0
    }
    for (let y = 0; y < h; y++) {
      let s = ((y0 + y) * r.width + x0) * c
      let d = y * w * 4
      for (let x = 0; x < w; x++, s += c, d += 4) {
        if (view === 'a') {
          const a = hasAlpha ? alphaTable[data[s + ai]] : 255
          out[d] = out[d + 1] = out[d + 2] = a
          out[d + 3] = 255
        } else if (view !== 'rgb' && rgb) {
          const v = table[data[s + pick]]
          out[d] = out[d + 1] = out[d + 2] = v
          out[d + 3] = 255
        } else if (rgb) {
          out[d] = table[data[s]]
          out[d + 1] = table[data[s + 1]]
          out[d + 2] = table[data[s + 2]]
          out[d + 3] = hasAlpha ? alphaTable[data[s + ai]] : 255
        } else {
          const v = table[data[s]]
          out[d] = out[d + 1] = out[d + 2] = v
          out[d + 3] = hasAlpha ? alphaTable[data[s + ai]] : 255
        }
      }
    }
    return
  }

  const linear = toLinearFn(r.transfer, tone)
  const gain = r.transfer === 'data' ? 1 : Math.pow(2, tone.exposure)
  const map = r.transfer === 'linear' ? tone.map : 'clip'
  const enc = encodeLinear()
  const lumaOut = (y: number) => {
    if (r.transfer === 'data') return y >= 1 ? 255 : y > 0 ? (y * 255 + 0.5) | 0 : 0
    const v = curve(map, y * gain)
    return enc[((v >= 1 ? 1 : v > 0 ? v : 0) * ENCODE_SIZE + 0.5) | 0]
  }
  for (let y = 0; y < h; y++) {
    let s = ((y0 + y) * r.width + x0) * c
    let d = y * w * 4
    for (let x = 0; x < w; x++, s += c, d += 4) {
      let a = hasAlpha ? nv(data[s + ai]) : 1
      if (!(a >= 0)) a = 0
      const un = r.premultiplied && a > 0 ? 1 / a : 1
      const a8 = a >= 1 ? 255 : (a * 255 + 0.5) | 0
      if (view === 'a') {
        out[d] = out[d + 1] = out[d + 2] = a8
        out[d + 3] = 255
        continue
      }
      if (view === 'luma' && rgb) {
        const Y = 0.2126 * linear(nv(data[s]) * un) + 0.7152 * linear(nv(data[s + 1]) * un) + 0.0722 * linear(nv(data[s + 2]) * un)
        out[d] = out[d + 1] = out[d + 2] = lumaOut(Y)
        out[d + 3] = a8
        continue
      }
      if (view !== 'rgb' && view !== 'luma' && rgb) {
        out[d] = out[d + 1] = out[d + 2] = colourOf(nv(data[s + pick]) * un)
        out[d + 3] = 255
        continue
      }
      if (rgb) {
        out[d] = colourOf(nv(data[s]) * un)
        out[d + 1] = colourOf(nv(data[s + 1]) * un)
        out[d + 2] = colourOf(nv(data[s + 2]) * un)
      } else {
        out[d] = out[d + 1] = out[d + 2] = colourOf(nv(data[s]) * un)
      }
      out[d + 3] = a8
    }
  }
}

/**
 * A box-filtered copy whose longer side is at most `maxSide`, as normalized 32-bit floats with
 * the same channels. Non-finite samples are left out of each average.
 */
export function overview(r: Raster, maxSide: number): { raster: Raster; scale: number } {
  const factor = Math.max(1, Math.ceil(Math.max(r.width, r.height) / maxSide))
  if (factor === 1 && r.kind === 'f32') return { raster: r, scale: 1 }
  const w = Math.max(1, Math.floor(r.width / factor))
  const h = Math.max(1, Math.floor(r.height / factor))
  const c = r.channels
  const norm = normTable(r)
  const out = new Float32Array(w * h * c)
  const sum = new Float64Array(c)
  const cnt = new Uint32Array(c)
  for (let y = 0; y < h; y++) {
    // Boxes stay inside the image: a side shorter than the factor must not read into later rows.
    const yEnd = Math.min((y + 1) * factor, r.height)
    for (let x = 0; x < w; x++) {
      sum.fill(0)
      cnt.fill(0)
      const span = Math.min(factor, r.width - x * factor)
      for (let yy = y * factor; yy < yEnd; yy++) {
        let s = (yy * r.width + x * factor) * c
        for (let xx = 0; xx < span; xx++, s += c) {
          for (let k = 0; k < c; k++) {
            const raw = r.data[s + k]
            const v = norm ? norm[raw] : raw
            if (Number.isFinite(v)) {
              sum[k] += v
              cnt[k]++
            }
          }
        }
      }
      const d = (y * w + x) * c
      for (let k = 0; k < c; k++) out[d + k] = cnt[k] ? sum[k] / cnt[k] : 0
    }
  }
  return { raster: { ...r, width: w, height: h, kind: 'f32', data: out, bits: 32 }, scale: w / r.width }
}

/** Smallest and largest finite colour values, normalized. */
export function normalizedRange(r: Raster): [number, number] {
  if (r.range && r.kind === 'f32') return r.range
  const norm = normTable(r)
  const colour = r.color === 'rgb' ? 3 : 1
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < r.data.length; i += r.channels) {
    for (let k = 0; k < colour; k++) {
      const raw = r.data[i + k]
      const v = norm ? norm[raw] : raw
      if (Number.isFinite(v)) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
  }
  return lo === Infinity ? [0, 1] : [lo, hi]
}

function percentiles(values: Float32Array, lowP: number, highP: number): [number, number] {
  if (!values.length) return [0, 1]
  const sorted = values.slice().sort()
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]
  return [at(lowP), at(highP)]
}

/** Samples of colour (or luminance) values from a raster, at most `limit`, finite only. */
function sampleValues(r: Raster, limit: number, luminance: boolean): Float32Array {
  const norm = normTable(r)
  const pixels = r.width * r.height
  const step = Math.max(1, Math.floor(pixels / limit))
  const colour = r.color === 'rgb' ? 3 : 1
  const out = new Float32Array(Math.ceil(pixels / step) * (luminance ? 1 : colour))
  let n = 0
  for (let p = 0; p < pixels; p += step) {
    const s = p * r.channels
    const v = (k: number) => {
      const raw = r.data[s + k]
      return norm ? norm[raw] : raw
    }
    if (luminance && colour === 3) {
      const y = 0.2126 * v(0) + 0.7152 * v(1) + 0.0722 * v(2)
      if (Number.isFinite(y)) out[n++] = y
    } else {
      for (let k = 0; k < colour; k++) {
        const x = v(k)
        if (Number.isFinite(x)) out[n++] = x
      }
    }
  }
  return out.subarray(0, n)
}

/**
 * Auto levels: for linear light an exposure that puts the 99.5th luminance percentile at white;
 * for other images black and white levels at the 0.1st and 99.9th percentiles.
 */
export function autoTone(r: Raster, tone: Tone): Tone {
  if (r.transfer === 'linear') {
    const [, hi] = percentiles(sampleValues(r, 250_000, true), 0, 0.995)
    const exposure = hi > 0 ? Math.max(-20, Math.min(20, Math.log2(1 / hi))) : 0
    return { ...tone, exposure: Math.round(exposure * 10) / 10, black: 0, white: 1 }
  }
  const [lo, hi] = percentiles(sampleValues(r, 250_000, false), 0.001, 0.999)
  return { ...tone, exposure: 0, black: lo, white: hi > lo ? hi : lo + (r.transfer === 'data' ? 1 : 1 / 255) }
}

/** 256-bin histograms of the rendered bytes: R, G, B and luminance. */
export function histogram(rgba: Uint8ClampedArray): { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array } {
  const r = new Uint32Array(256)
  const g = new Uint32Array(256)
  const b = new Uint32Array(256)
  const l = new Uint32Array(256)
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    r[rgba[i]]++
    g[rgba[i + 1]]++
    b[rgba[i + 2]]++
    l[(rgba[i] * 54 + rgba[i + 1] * 183 + rgba[i + 2] * 19) >> 8]++
  }
  return { r, g, b, l }
}

/** The raw values of one pixel, formatted for the inspector. */
export function pixelValues(r: Raster, x: number, y: number): { name: string; value: string }[] {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return []
  const s = (y * r.width + x) * r.channels
  const out: { name: string; value: string }[] = []
  const half = r.kind === 'f16' ? halfTable() : null
  for (let k = 0; k < r.channels; k++) {
    const raw = r.data[s + k]
    let value: string
    if (r.kind === 'f32') value = formatFloat(raw)
    else if (half) value = formatFloat(half[raw])
    else value = String(raw)
    out.push({ name: r.names[k] ?? `C${k}`, value })
  }
  return out
}

export function formatFloat(v: number): string {
  if (Number.isNaN(v)) return 'NaN'
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '−Inf'
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.001 || a >= 100000)) return v.toExponential(3)
  return v.toFixed(4)
}
