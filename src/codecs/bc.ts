// Block-compressed textures (BC1–BC7, also known as DXT1–5, ATI1/2): 4×4 pixel blocks of 8 or 16
// bytes. Written from the Direct3D block compression format descriptions.

export type BcFormat = 'bc1' | 'bc2' | 'bc3' | 'bc4' | 'bc4s' | 'bc5' | 'bc5s' | 'bc6h' | 'bc6hs' | 'bc7'

export const BLOCK_BYTES: Record<BcFormat, number> = {
  bc1: 8,
  bc2: 16,
  bc3: 16,
  bc4: 8,
  bc4s: 8,
  bc5: 16,
  bc5s: 16,
  bc6h: 16,
  bc6hs: 16,
  bc7: 16
}

/** Output samples per pixel: RGBA for BC1–3 and BC7, grey for BC4, RG(B=0) for BC5, RGB half for BC6H. */
export function bcChannels(format: BcFormat): number {
  if (format === 'bc4' || format === 'bc4s') return 1
  if (format === 'bc5' || format === 'bc5s' || format === 'bc6h' || format === 'bc6hs') return 3
  return 4
}

export function bcDataSize(format: BcFormat, width: number, height: number): number {
  return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * BLOCK_BYTES[format]
}

// ---------------------------------------------------------------- BC1–BC5

const expand5 = (v: number) => (v << 3) | (v >> 2)
const expand6 = (v: number) => (v << 2) | (v >> 4)

/** A BC1 colour block into 16 RGBA pixels; `four` forces the 4-colour mode (BC2, BC3). */
function colourBlock(src: Uint8Array, at: number, out: Uint8Array, four: boolean): void {
  const c0 = src[at] | (src[at + 1] << 8)
  const c1 = src[at + 2] | (src[at + 3] << 8)
  const p = colourPalette
  p[0] = expand5(c0 >> 11)
  p[1] = expand6((c0 >> 5) & 63)
  p[2] = expand5(c0 & 31)
  p[3] = 255
  p[4] = expand5(c1 >> 11)
  p[5] = expand6((c1 >> 5) & 63)
  p[6] = expand5(c1 & 31)
  p[7] = 255
  if (four || c0 > c1) {
    for (let k = 0; k < 3; k++) {
      p[8 + k] = ((2 * p[k] + p[4 + k] + 1) / 3) | 0
      p[12 + k] = ((p[k] + 2 * p[4 + k] + 1) / 3) | 0
    }
    p[11] = 255
    p[15] = 255
  } else {
    for (let k = 0; k < 3; k++) p[8 + k] = (p[k] + p[4 + k] + 1) >> 1
    p[11] = 255
    p[12] = p[13] = p[14] = p[15] = 0
  }
  const bits = (src[at + 4] | (src[at + 5] << 8) | (src[at + 6] << 16) | (src[at + 7] << 24)) >>> 0
  for (let i = 0; i < 16; i++) {
    const c = ((bits >>> (2 * i)) & 3) * 4
    out[i * 4] = p[c]
    out[i * 4 + 1] = p[c + 1]
    out[i * 4 + 2] = p[c + 2]
    out[i * 4 + 3] = p[c + 3]
  }
}
const colourPalette = new Uint8Array(16)

/** A BC4 channel block into 16 values, every `stride` bytes from `offset`. */
function channelBlock(src: Uint8Array, at: number, out: Uint8Array, offset: number, stride: number, signed: boolean): void {
  const v = channelPalette
  let a = src[at]
  let b = src[at + 1]
  if (signed) {
    // Signed values −127…127 (−128 counts as −127), shown as 0…255.
    a = Math.max(-127, (a << 24) >> 24)
    b = Math.max(-127, (b << 24) >> 24)
  }
  v[0] = a
  v[1] = b
  if (a > b) {
    for (let i = 1; i < 7; i++) v[i + 1] = ((7 - i) * a + i * b) / 7
  } else {
    for (let i = 1; i < 5; i++) v[i + 1] = ((5 - i) * a + i * b) / 5
    v[6] = signed ? -127 : 0
    v[7] = signed ? 127 : 255
  }
  // 48 bits of 3-bit indices, in two 24-bit halves.
  const lo = src[at + 2] | (src[at + 3] << 8) | (src[at + 4] << 16)
  const hi = src[at + 5] | (src[at + 6] << 8) | (src[at + 7] << 16)
  for (let i = 0; i < 16; i++) {
    const idx = i < 8 ? (lo >> (3 * i)) & 7 : (hi >> (3 * (i - 8))) & 7
    const value = signed ? ((v[idx] + 127) * 255) / 254 : v[idx]
    out[offset + i * stride] = Math.round(value)
  }
}
const channelPalette = new Float64Array(8)

// ---------------------------------------------------------------- BC6H and BC7 shared parts

/** Reads the 128 bits of a block, least significant bit first. */
class BlockBits {
  private readonly w = new Uint32Array(4)
  pos = 0

  load(src: Uint8Array, at: number): void {
    for (let i = 0; i < 4; i++) this.w[i] = (src[at + 4 * i] | (src[at + 4 * i + 1] << 8) | (src[at + 4 * i + 2] << 16) | (src[at + 4 * i + 3] << 24)) >>> 0
    this.pos = 0
  }

  read(n: number): number {
    if (n === 0) return 0
    const i = this.pos >>> 5
    const s = this.pos & 31
    let v = this.w[i] >>> s
    if (s + n > 32 && i < 3) v |= this.w[i + 1] << (32 - s)
    this.pos += n
    return n >= 32 ? v >>> 0 : v & ((1 << n) - 1)
  }
}

const WEIGHTS: Record<number, number[]> = {
  2: [0, 21, 43, 64],
  3: [0, 9, 18, 27, 37, 46, 55, 64],
  4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]
}

// Partition tables of the BC6H/BC7 specification: which subset each of the 16 pixels belongs to,
// one bit per pixel for two subsets and two bits per pixel for three, pixel 0 in the low bits.
// prettier-ignore
const PARTITIONS2 = [
  0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80,
  0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000,
  0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce,
  0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c,
  0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa, 0x9696, 0xa55a,
  0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
  0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c,
  0x9336, 0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22
]
// prettier-ignore
const PARTITIONS3 = [
  0xaa685050, 0x6a5a5040, 0x5a5a4200, 0x5450a0a8, 0xa5a50000, 0xa0a05050, 0x5555a0a0, 0x5a5a5050,
  0xaa550000, 0xaa555500, 0xaaaa5500, 0x90909090, 0x94949494, 0xa4a4a4a4, 0xa9a59450, 0x2a0a4250,
  0xa5945040, 0x0a425054, 0xa5a5a500, 0x55a0a0a0, 0xa8a85454, 0x6a6a4040, 0xa4a45000, 0x1a1a0500,
  0x0050a4a4, 0xaaa59090, 0x14696914, 0x69691400, 0xa08585a0, 0xaa821414, 0x50a4a450, 0x6a5a0200,
  0xa9a58000, 0x5090a0a8, 0xa8a09050, 0x24242424, 0x00aa5500, 0x24924924, 0x24499224, 0x50a50a50,
  0x500aa550, 0xaaaa4444, 0x66660000, 0xa5a0a5a0, 0x50a050a0, 0x69286928, 0x44aaaa44, 0x66666600,
  0xaa444444, 0x54a854a8, 0x95809580, 0x96969600, 0xa85454a8, 0x80959580, 0xaa141414, 0x96960000,
  0xaaaa1414, 0xa05050a0, 0xa0a5a5a0, 0x96000000, 0x40804080, 0xa9a8a9a8, 0xaaaaaa44, 0x2a4a5254
]
// The "anchor" pixel of each subset after the first, whose index has one bit less.
// prettier-ignore
const ANCHOR2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
  15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
  6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15
]
// prettier-ignore
const ANCHOR3A = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3,
  3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15,
  3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3
]
// prettier-ignore
const ANCHOR3B = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8,
  15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8,
  15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8
]

function subsetOf(subsets: number, partition: number, i: number): number {
  if (subsets === 1) return 0
  if (subsets === 2) return (PARTITIONS2[partition] >> i) & 1
  return (PARTITIONS3[partition] >>> (2 * i)) & 3
}

function isAnchor(subsets: number, partition: number, i: number): boolean {
  if (i === 0) return true
  if (subsets === 2) return i === ANCHOR2[partition]
  if (subsets === 3) return i === ANCHOR3A[partition] || i === ANCHOR3B[partition]
  return false
}

// ---------------------------------------------------------------- BC7

// Per mode: subsets, partition bits, rotation bits, index selection bit, colour bits, alpha bits,
// per-endpoint P-bits, shared P-bits, index bits, secondary index bits.
// prettier-ignore
const BC7_MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0]
]

const bc7Endpoints = new Int32Array(6 * 4)
const bc7Index1 = new Uint8Array(16)
const bc7Index2 = new Uint8Array(16)

function bc7Block(r: BlockBits, out: Uint8Array): void {
  let mode = 0
  while (mode < 8 && r.read(1) === 0) mode++
  if (mode === 8) {
    out.fill(0)
    return
  }
  const [ns, pb, rb, isb, cb, ab, epb, spb, ib, ib2] = BC7_MODES[mode]
  const partition = r.read(pb)
  const rotation = r.read(rb)
  const indexSel = r.read(isb)
  const ep = bc7Endpoints
  const n = ns * 2
  for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) ep[i * 4 + c] = r.read(cb)
  if (ab) for (let i = 0; i < n; i++) ep[i * 4 + 3] = r.read(ab)
  const components = ab ? 4 : 3
  if (epb) {
    for (let i = 0; i < n; i++) {
      const p = r.read(1)
      for (let c = 0; c < components; c++) ep[i * 4 + c] = (ep[i * 4 + c] << 1) | p
    }
  }
  if (spb) {
    for (let s = 0; s < ns; s++) {
      const p = r.read(1)
      for (let e = 0; e < 2; e++) for (let c = 0; c < components; c++) ep[(s * 2 + e) * 4 + c] = (ep[(s * 2 + e) * 4 + c] << 1) | p
    }
  }
  const extra = epb || spb ? 1 : 0
  const colourBits = cb + extra
  const alphaBits = ab + extra
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = ep[i * 4 + c] << (8 - colourBits)
      ep[i * 4 + c] = v | (v >> colourBits)
    }
    if (ab) {
      const v = ep[i * 4 + 3] << (8 - alphaBits)
      ep[i * 4 + 3] = v | (v >> alphaBits)
    } else {
      ep[i * 4 + 3] = 255
    }
  }
  for (let i = 0; i < 16; i++) bc7Index1[i] = r.read(isAnchor(ns, partition, i) ? ib - 1 : ib)
  if (ib2) for (let i = 0; i < 16; i++) bc7Index2[i] = r.read(i === 0 ? ib2 - 1 : ib2)
  for (let i = 0; i < 16; i++) {
    const s = subsetOf(ns, partition, i)
    const e0 = s * 8
    const e1 = e0 + 4
    let wc: number
    let wa: number
    if (!ib2) {
      wc = wa = WEIGHTS[ib][bc7Index1[i]]
    } else if (indexSel === 0) {
      wc = WEIGHTS[ib][bc7Index1[i]]
      wa = WEIGHTS[ib2][bc7Index2[i]]
    } else {
      wc = WEIGHTS[ib2][bc7Index2[i]]
      wa = WEIGHTS[ib][bc7Index1[i]]
    }
    const o = i * 4
    for (let c = 0; c < 3; c++) out[o + c] = ((64 - wc) * ep[e0 + c] + wc * ep[e1 + c] + 32) >> 6
    out[o + 3] = ((64 - wa) * ep[e0 + 3] + wa * ep[e1 + 3] + 32) >> 6
    if (rotation) {
      const t = out[o + 3]
      out[o + 3] = out[o + rotation - 1]
      out[o + rotation - 1] = t
    }
  }
}

// ---------------------------------------------------------------- BC6H

// Bit layouts of the 14 modes, in stream order. `r0[9:0]` is ten bits read low bit first;
// `r0[10:15]` is six bits read high bit first. r0/g0/b0 is the base endpoint, 1–3 the others,
// d the partition.
const BC6_LAYOUTS: Record<number, string> = {
  0: 'g2[4] b2[4] b3[4] r0[9:0] g0[9:0] b0[9:0] r1[4:0] g3[4] g2[3:0] g1[4:0] b3[0] g3[3:0] b1[4:0] b3[1] b2[3:0] r2[4:0] b3[2] r3[4:0] b3[3] d[4:0]',
  1: 'g2[5] g3[4] g3[5] r0[6:0] b3[0] b3[1] b2[4] g0[6:0] b2[5] b3[2] g2[4] b0[6:0] b3[3] b3[5] b3[4] r1[5:0] g2[3:0] g1[5:0] g3[3:0] b1[5:0] b2[3:0] r2[5:0] r3[5:0] d[4:0]',
  2: 'r0[9:0] g0[9:0] b0[9:0] r1[4:0] r0[10] g2[3:0] g1[3:0] g0[10] b3[0] g3[3:0] b1[3:0] b0[10] b3[1] b2[3:0] r2[4:0] b3[2] r3[4:0] b3[3] d[4:0]',
  6: 'r0[9:0] g0[9:0] b0[9:0] r1[3:0] r0[10] g3[4] g2[3:0] g1[4:0] g0[10] g3[3:0] b1[3:0] b0[10] b3[1] b2[3:0] r2[3:0] b3[0] b3[2] r3[3:0] g2[4] b3[3] d[4:0]',
  10: 'r0[9:0] g0[9:0] b0[9:0] r1[3:0] r0[10] b2[4] g2[3:0] g1[3:0] g0[10] b3[0] g3[3:0] b1[4:0] b0[10] b2[3:0] r2[3:0] b3[1] b3[2] r3[3:0] b3[4] b3[3] d[4:0]',
  14: 'r0[8:0] b2[4] g0[8:0] g2[4] b0[8:0] b3[4] r1[4:0] g3[4] g2[3:0] g1[4:0] b3[0] g3[3:0] b1[4:0] b3[1] b2[3:0] r2[4:0] b3[2] r3[4:0] b3[3] d[4:0]',
  18: 'r0[7:0] g3[4] b2[4] g0[7:0] b3[2] g2[4] b0[7:0] b3[3] b3[4] r1[5:0] g2[3:0] g1[4:0] b3[0] g3[3:0] b1[4:0] b3[1] b2[3:0] r2[5:0] r3[5:0] d[4:0]',
  22: 'r0[7:0] b3[0] b2[4] g0[7:0] g2[5] g2[4] b0[7:0] g3[5] b3[4] r1[4:0] g3[4] g2[3:0] g1[5:0] g3[3:0] b1[4:0] b3[1] b2[3:0] r2[4:0] b3[2] r3[4:0] b3[3] d[4:0]',
  26: 'r0[7:0] b3[1] b2[4] g0[7:0] b2[5] g2[4] b0[7:0] b3[5] b3[4] r1[4:0] g3[4] g2[3:0] g1[4:0] b3[0] g3[3:0] b1[5:0] b2[3:0] r2[4:0] b3[2] r3[4:0] b3[3] d[4:0]',
  30: 'r0[5:0] g3[4] b3[0] b3[1] b2[4] g0[5:0] g2[5] b2[5] b3[2] g2[4] b0[5:0] g3[5] b3[3] b3[5] b3[4] r1[5:0] g2[3:0] g1[5:0] g3[3:0] b1[5:0] b2[3:0] r2[5:0] r3[5:0] d[4:0]',
  3: 'r0[9:0] g0[9:0] b0[9:0] r1[9:0] g1[9:0] b1[9:0]',
  7: 'r0[9:0] g0[9:0] b0[9:0] r1[8:0] r0[10] g1[8:0] g0[10] b1[8:0] b0[10]',
  11: 'r0[9:0] g0[9:0] b0[9:0] r1[7:0] r0[10:11] g1[7:0] g0[10:11] b1[7:0] b0[10:11]',
  15: 'r0[9:0] g0[9:0] b0[9:0] r1[3:0] r0[10:15] g1[3:0] g0[10:15] b1[3:0] b0[10:15]'
}

// Per mode: endpoint bits, delta bits for R, G, B, transformed (deltas), regions.
const BC6_MODES: Record<number, [number, number, number, number, boolean, number]> = {
  0: [10, 5, 5, 5, true, 2],
  1: [7, 6, 6, 6, true, 2],
  2: [11, 5, 4, 4, true, 2],
  6: [11, 4, 5, 4, true, 2],
  10: [11, 4, 4, 5, true, 2],
  14: [9, 5, 5, 5, true, 2],
  18: [8, 6, 5, 5, true, 2],
  22: [8, 5, 6, 5, true, 2],
  26: [8, 5, 5, 6, true, 2],
  30: [6, 6, 6, 6, false, 2],
  3: [10, 10, 10, 10, false, 1],
  7: [11, 9, 9, 9, true, 1],
  11: [12, 8, 8, 8, true, 1],
  15: [16, 4, 4, 4, true, 1]
}

/** Parsed layouts: field (0–11 for r0 g0 b0 r1 … b3, 12 for d) and bit, in stream order. */
const BC6_STEPS = new Map<number, Int8Array>()
for (const [code, layout] of Object.entries(BC6_LAYOUTS)) {
  const steps: number[] = []
  for (const token of layout.split(' ')) {
    const m = /^([rgbd])(\d?)\[(\d+)(?::(\d+))?\]$/.exec(token)
    if (!m) continue
    const field = m[1] === 'd' ? 12 : Number(m[2]) * 3 + 'rgb'.indexOf(m[1])
    const a = Number(m[3])
    const b = m[4] === undefined ? a : Number(m[4])
    // Stream order runs from the second number to the first.
    if (a >= b) for (let k = b; k <= a; k++) steps.push(field, k)
    else for (let k = b; k >= a; k--) steps.push(field, k)
  }
  BC6_STEPS.set(Number(code), Int8Array.from(steps))
}

const signExtend = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits)

function unquantize(v: number, bits: number, signed: boolean): number {
  if (!signed) {
    if (bits >= 15) return v
    if (v === 0) return 0
    if (v === (1 << bits) - 1) return 0xffff
    return ((v << 16) + 0x8000) >> bits
  }
  if (bits >= 16) return v
  const negative = v < 0
  if (negative) v = -v
  let q: number
  if (v === 0) q = 0
  else if (v >= (1 << (bits - 1)) - 1) q = 0x7fff
  else q = ((v << 15) + 0x4000) >> (bits - 1)
  return negative ? -q : q
}

function finish(v: number, signed: boolean): number {
  if (!signed) return (v * 31) >> 6
  const s = v < 0 ? -(((-v) * 31) >> 5) : (v * 31) >> 5
  return s < 0 ? 0x8000 | -s : s
}

const bc6Fields = new Int32Array(13)

/** One BC6H block into 16 RGB half-float bit patterns. */
function bc6Block(r: BlockBits, out: Uint16Array, signed: boolean): void {
  let code = r.read(2)
  if (code > 1) code |= r.read(3) << 2
  const mode = BC6_MODES[code]
  const steps = BC6_STEPS.get(code)
  if (!mode || !steps) {
    out.fill(0)
    return
  }
  const f = bc6Fields
  f.fill(0)
  for (let i = 0; i < steps.length; i += 2) f[steps[i]] |= r.read(1) << steps[i + 1]
  const [bits, dr, dg, db, transformed, regions] = mode
  const deltaBits = [dr, dg, db]
  const endpoints = regions * 2
  const mask = (1 << bits) - 1
  if (signed) for (let c = 0; c < 3; c++) f[c] = signExtend(f[c], bits)
  for (let e = 1; e < endpoints; e++) {
    for (let c = 0; c < 3; c++) {
      const k = e * 3 + c
      if (transformed) {
        f[k] = (f[c] + signExtend(f[k], deltaBits[c])) & mask
        if (signed) f[k] = signExtend(f[k], bits)
      } else if (signed) {
        f[k] = signExtend(f[k], bits)
      }
    }
  }
  for (let k = 0; k < endpoints * 3; k++) f[k] = unquantize(f[k], bits, signed)
  const partition = f[12]
  const indexBits = regions === 2 ? 3 : 4
  const weights = WEIGHTS[indexBits]
  for (let i = 0; i < 16; i++) {
    const index = r.read(isAnchor(regions, partition, i) ? indexBits - 1 : indexBits)
    const s = subsetOf(regions, partition, i)
    const w = weights[index]
    for (let c = 0; c < 3; c++) {
      const a = f[s * 6 + c]
      const b = f[s * 6 + 3 + c]
      out[i * 3 + c] = finish(((64 - w) * a + w * b + 32) >> 6, signed)
    }
  }
}

// ---------------------------------------------------------------- whole images

/**
 * Decodes `width × height` pixels of blocks from `src` at `offset`: Uint8Array samples (RGBA, grey
 * or RGB) or, for BC6H, Uint16Array half-float bits. Missing blocks at the end stay zero.
 */
export function decodeBc(format: BcFormat, src: Uint8Array, offset: number, width: number, height: number): Uint8Array | Uint16Array {
  const channels = bcChannels(format)
  const bw = Math.max(1, Math.ceil(width / 4))
  const bh = Math.max(1, Math.ceil(height / 4))
  const size = BLOCK_BYTES[format]
  const hdr = format === 'bc6h' || format === 'bc6hs'
  const out = hdr ? new Uint16Array(width * height * channels) : new Uint8Array(width * height * channels)
  const block8 = new Uint8Array(64)
  const block16 = new Uint16Array(48)
  const bits = new BlockBits()
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const at = offset + (by * bw + bx) * size
      if (at + size > src.length) return out
      let block: Uint8Array | Uint16Array = block8
      switch (format) {
        case 'bc1':
          colourBlock(src, at, block8, false)
          break
        case 'bc2':
          colourBlock(src, at + 8, block8, true)
          for (let i = 0; i < 16; i++) block8[i * 4 + 3] = ((src[at + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17
          break
        case 'bc3':
          colourBlock(src, at + 8, block8, true)
          channelBlock(src, at, block8, 3, 4, false)
          break
        case 'bc4':
        case 'bc4s':
          channelBlock(src, at, block8, 0, 1, format === 'bc4s')
          break
        case 'bc5':
        case 'bc5s':
          channelBlock(src, at, block8, 0, 3, format === 'bc5s')
          channelBlock(src, at + 8, block8, 1, 3, format === 'bc5s')
          for (let i = 0; i < 16; i++) block8[i * 3 + 2] = 0
          break
        case 'bc6h':
        case 'bc6hs':
          bits.load(src, at)
          bc6Block(bits, block16, format === 'bc6hs')
          block = block16
          break
        case 'bc7':
          bits.load(src, at)
          bc7Block(bits, block8)
          break
      }
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y
        if (py >= height) break
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x
          if (px >= width) break
          const o = (py * width + px) * channels
          const s = (y * 4 + x) * channels
          for (let c = 0; c < channels; c++) out[o + c] = block[s + c]
        }
      }
    }
  }
  return out
}
