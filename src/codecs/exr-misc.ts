// The smaller OpenEXR codecs: RLE, the byte predictor and interleaving shared by RLE and ZIP, PXR24
// (24-bit floats in byte planes) and B44/B44A (4×4 blocks of half floats in 14 or 3 bytes).

import { damaged } from '../core/errors'

/** OpenEXR RLE: a signed count, then −n literal bytes or one byte n+1 times. */
export function exrRleDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let i = 0
  let o = 0
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24
    if (n < 0) {
      const count = Math.min(-n, expected - o, src.length - i)
      out.set(src.subarray(i, i + count), o)
      i += -n
      o += count
    } else {
      if (i >= src.length) break
      const count = Math.min(n + 1, expected - o)
      out.fill(src[i++], o, o + count)
      o += count
    }
  }
  if (o < expected) throw damaged('EXR RLE data')
  return out
}

/** Undoes the byte predictor, then the split of even and odd bytes into two halves. */
export function exrUnpredict(t: Uint8Array): Uint8Array {
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 255
  const out = new Uint8Array(t.length)
  const half = (t.length + 1) >> 1
  for (let i = 0, a = 0, b = half; i < t.length; i += 2) {
    out[i] = t[a++]
    if (i + 1 < t.length) out[i + 1] = t[b++]
  }
  return out
}

/** The forward predictor and split, for test fixtures. */
export function exrPredict(data: Uint8Array): Uint8Array {
  const t = new Uint8Array(data.length)
  const half = (data.length + 1) >> 1
  for (let i = 0, a = 0, b = half; i < data.length; i += 2) {
    t[a++] = data[i]
    if (i + 1 < data.length) t[b++] = data[i + 1]
  }
  let prev = t[0]
  for (let i = 1; i < t.length; i++) {
    const d = (t[i] - prev + 128 + 256) & 255
    prev = t[i]
    t[i] = d
  }
  return t
}

/** A channel inside a block: samples per line, lines, and pixel type (0 uint, 1 half, 2 float). */
export interface BlockChannel {
  nx: number
  ny: number
  type: number
}

/**
 * PXR24 after inflating: line by line, channel by channel, the bytes of each value in planes
 * (most significant first) as differences from the previous value. Floats keep their top 24 bits.
 * Returns the block in OpenEXR's uncompressed layout (lines, then channels, little-endian).
 */
export function pxr24Decode(data: Uint8Array, channels: readonly BlockChannel[], lines: number, ySampling: readonly number[], y0: number): Uint8Array {
  let outSize = 0
  for (const c of channels) outSize += c.nx * c.ny * (c.type === 1 ? 2 : 4)
  const out = new Uint8Array(outSize)
  const view = new DataView(out.buffer)
  let i = 0
  let o = 0
  for (let y = 0; y < lines; y++) {
    for (const [k, c] of channels.entries()) {
      if ((y0 + y) % ySampling[k] !== 0) continue
      const n = c.nx
      if (c.type === 1) {
        if (i + n * 2 > data.length) throw damaged('PXR24 data')
        let pixel = 0
        for (let x = 0; x < n; x++) {
          const diff = (data[i + x] << 8) | data[i + n + x]
          pixel = (pixel + diff) & 0xffff
          view.setUint16(o, pixel, true)
          o += 2
        }
        i += n * 2
      } else if (c.type === 2) {
        if (i + n * 3 > data.length) throw damaged('PXR24 data')
        let pixel = 0
        for (let x = 0; x < n; x++) {
          const diff = (data[i + x] << 16) | (data[i + n + x] << 8) | data[i + 2 * n + x]
          pixel = (pixel + diff) & 0xffffff
          view.setUint32(o, pixel * 256, true)
          o += 4
        }
        i += n * 3
      } else {
        if (i + n * 4 > data.length) throw damaged('PXR24 data')
        let pixel = 0
        for (let x = 0; x < n; x++) {
          const diff = ((data[i + x] << 24) | (data[i + n + x] << 16) | (data[i + 2 * n + x] << 8) | data[i + 3 * n + x]) >>> 0
          pixel = (pixel + diff) >>> 0
          view.setUint32(o, pixel, true)
          o += 4
        }
        i += n * 4
      }
    }
  }
  return out
}

function b44Block(b: Uint8Array, at: number, s: Uint16Array): number {
  if (b[at + 2] >= 13 << 2) {
    // A flat block (B44A): one value for all 16 pixels.
    let v = (b[at] << 8) | b[at + 1]
    v = v & 0x8000 ? v & 0x7fff : ~v & 0xffff
    s.fill(v)
    return 3
  }
  const shift = b[at + 2] >> 2
  const bias = 0x20 << shift
  const c = (v: number) => v << shift
  s[0] = (b[at] << 8) | b[at + 1]
  s[4] = s[0] + c((((b[at + 2] << 4) | (b[at + 3] >> 4)) & 0x3f)) - bias
  s[8] = s[4] + c((((b[at + 3] << 2) | (b[at + 4] >> 6)) & 0x3f)) - bias
  s[12] = s[8] + c(b[at + 4] & 0x3f) - bias
  s[1] = s[0] + c(b[at + 5] >> 2) - bias
  s[5] = s[4] + c((((b[at + 5] << 4) | (b[at + 6] >> 4)) & 0x3f)) - bias
  s[9] = s[8] + c((((b[at + 6] << 2) | (b[at + 7] >> 6)) & 0x3f)) - bias
  s[13] = s[12] + c(b[at + 7] & 0x3f) - bias
  s[2] = s[1] + c(b[at + 8] >> 2) - bias
  s[6] = s[5] + c((((b[at + 8] << 4) | (b[at + 9] >> 4)) & 0x3f)) - bias
  s[10] = s[9] + c((((b[at + 9] << 2) | (b[at + 10] >> 6)) & 0x3f)) - bias
  s[14] = s[13] + c(b[at + 10] & 0x3f) - bias
  s[3] = s[2] + c(b[at + 11] >> 2) - bias
  s[7] = s[6] + c((((b[at + 11] << 4) | (b[at + 12] >> 4)) & 0x3f)) - bias
  s[11] = s[10] + c((((b[at + 12] << 2) | (b[at + 13] >> 6)) & 0x3f)) - bias
  s[15] = s[14] + c(b[at + 13] & 0x3f) - bias
  for (let i = 0; i < 16; i++) s[i] = s[i] & 0x8000 ? s[i] & 0x7fff : ~s[i] & 0xffff
  return 14
}

/**
 * B44 and B44A: half channels in 4×4 blocks, other channels raw. Returns per-channel planes of
 * raw sample bytes (little-endian), in channel order.
 */
export function b44Decode(data: Uint8Array, channels: readonly BlockChannel[]): Uint8Array[] {
  const planes: Uint8Array[] = []
  const s = new Uint16Array(16)
  let at = 0
  for (const c of channels) {
    if (c.type !== 1) {
      const n = c.nx * c.ny * 4
      if (at + n > data.length) throw damaged('B44 data')
      planes.push(data.slice(at, at + n))
      at += n
      continue
    }
    const plane = new Uint8Array(c.nx * c.ny * 2)
    const view = new DataView(plane.buffer)
    for (let by = 0; by < c.ny; by += 4) {
      for (let bx = 0; bx < c.nx; bx += 4) {
        if (at + 3 > data.length) throw damaged('B44 data')
        if (data[at + 2] < 13 << 2 && at + 14 > data.length) throw damaged('B44 data')
        at += b44Block(data, at, s)
        for (let y = 0; y < 4 && by + y < c.ny; y++) {
          for (let x = 0; x < 4 && bx + x < c.nx; x++) view.setUint16(((by + y) * c.nx + bx + x) * 2, s[y * 4 + x], true)
        }
      }
    }
    planes.push(plane)
  }
  return planes
}
