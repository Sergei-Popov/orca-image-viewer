// OpenEXR PIZ: a bitmap of the 16-bit values in use, a Haar-like wavelet per channel, and a
// canonical Huffman code with run-length coding of repeats. Written from the OpenEXR file format
// description; the code is this plugin's own.

import { damaged } from '../core/errors'

const ENC_SIZE = (1 << 16) + 1
const DEC_BITS = 14
const DEC_SIZE = 1 << DEC_BITS
const DEC_MASK = DEC_SIZE - 1
const SHORT_ZEROCODE_RUN = 59
const LONG_ZEROCODE_RUN = 63
const SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN

/** A bit reader over bytes, most significant bit first, with up to 52 bits in hand. */
class Bits {
  value = 0
  count = 0
  constructor(
    readonly data: Uint8Array,
    public pos: number,
    readonly end: number
  ) {}

  fill(n: number): boolean {
    while (this.count < n) {
      if (this.pos >= this.end) return false
      this.value = this.value * 256 + this.data[this.pos++]
      this.count += 8
      if (this.count > 52) throw damaged('PIZ code length')
    }
    return true
  }

  /** The next `n` bits without consuming them. */
  peek(n: number): number {
    return Math.floor(this.value / 2 ** (this.count - n)) % 2 ** n
  }

  take(n: number): number {
    const v = this.peek(n)
    this.count -= n
    this.value %= 2 ** this.count
    return v
  }
}

/** Code lengths (6 bits each, with runs of zeros) to packed canonical codes: code << 6 | length. */
export function canonicalCodes(lengths: Float64Array): void {
  const n = new Float64Array(59)
  for (let i = 0; i < ENC_SIZE; i++) n[lengths[i]] += 1
  let c = 0
  for (let i = 58; i > 0; i--) {
    const next = (c + n[i]) / 2
    n[i] = c
    c = Math.floor(next)
  }
  for (let i = 0; i < ENC_SIZE; i++) {
    const l = lengths[i]
    if (l > 0) lengths[i] = l + n[l]++ * 64
  }
}

const codeOf = (packed: number) => Math.floor(packed / 64)
const lengthOf = (packed: number) => packed % 64

function unpackTable(bits: Bits, im: number, iM: number, codes: Float64Array): void {
  for (; im <= iM; im++) {
    if (!bits.fill(6)) throw damaged('PIZ code table')
    const l = bits.take(6)
    codes[im] = l
    if (l === LONG_ZEROCODE_RUN) {
      if (!bits.fill(8)) throw damaged('PIZ code table')
      let run = bits.take(8) + SHORTEST_LONG_RUN
      if (im + run > iM + 1) throw damaged('PIZ code table')
      while (run--) codes[im++] = 0
      im--
    } else if (l >= SHORT_ZEROCODE_RUN) {
      let run = l - SHORT_ZEROCODE_RUN + 2
      if (im + run > iM + 1) throw damaged('PIZ code table')
      while (run--) codes[im++] = 0
      im--
    }
  }
  canonicalCodes(codes)
}

interface DecodeTable {
  len: Uint8Array
  lit: Int32Array
  long: (number[] | null)[]
}

function buildDecodeTable(codes: Float64Array, im: number, iM: number): DecodeTable {
  const table: DecodeTable = { len: new Uint8Array(DEC_SIZE), lit: new Int32Array(DEC_SIZE), long: new Array(DEC_SIZE).fill(null) }
  for (; im <= iM; im++) {
    const c = codeOf(codes[im])
    const l = lengthOf(codes[im])
    if (l === 0) continue
    if (c >= 2 ** l) throw damaged('PIZ code')
    if (l > DEC_BITS) {
      const at = Math.floor(c / 2 ** (l - DEC_BITS))
      if (table.len[at]) throw damaged('PIZ code')
      ;(table.long[at] ??= []).push(im)
    } else {
      let at = c * 2 ** (DEC_BITS - l)
      for (let i = 1 << (DEC_BITS - l); i > 0; i--, at++) {
        if (table.len[at] || table.long[at]) throw damaged('PIZ code')
        table.len[at] = l
        table.lit[at] = im
      }
    }
  }
  return table
}

function huffmanDecode(
  codes: Float64Array,
  table: DecodeTable,
  data: Uint8Array,
  start: number,
  nBits: number,
  rlc: number,
  out: Uint16Array
): void {
  let o = 0
  const end = start + Math.ceil(nBits / 8)
  if (end > data.length) throw damaged('PIZ data')
  const bits = new Bits(data, start, end)
  const emit = (symbol: number) => {
    if (symbol === rlc) {
      if (!bits.fill(8)) throw damaged('PIZ run')
      const run = bits.take(8)
      if (o + run > out.length || o === 0) throw damaged('PIZ run')
      const v = out[o - 1]
      for (let k = 0; k < run; k++) out[o++] = v
    } else {
      if (o >= out.length) throw damaged('PIZ data')
      out[o++] = symbol
    }
  }
  // All whole bytes, then the bits of the last one that belong to the stream.
  while (bits.pos < end) {
    bits.value = bits.value * 256 + data[bits.pos++]
    bits.count += 8
    while (bits.count >= DEC_BITS) {
      const at = bits.peek(DEC_BITS) & DEC_MASK
      const len = table.len[at]
      if (len) {
        bits.take(len)
        emit(table.lit[at])
        continue
      }
      const candidates = table.long[at]
      if (!candidates) throw damaged('PIZ code')
      let found = false
      for (const symbol of candidates) {
        const l = lengthOf(codes[symbol])
        if (!bits.fill(l)) continue
        if (bits.peek(l) === codeOf(codes[symbol])) {
          bits.take(l)
          emit(symbol)
          found = true
          break
        }
      }
      if (!found) throw damaged('PIZ code')
    }
  }
  const extra = (8 - nBits) & 7
  bits.value = Math.floor(bits.value / 2 ** extra)
  bits.count -= extra
  while (bits.count > 0) {
    const at = (bits.value * 2 ** (DEC_BITS - bits.count)) % DEC_SIZE
    const len = table.len[at]
    if (!len || len > bits.count) throw damaged('PIZ code')
    bits.count -= len
    bits.value %= 2 ** bits.count
    emit(table.lit[at])
  }
  if (o !== out.length) throw damaged('PIZ data length')
}

/** Huffman-coded 16-bit values (OpenEXR's `hufUncompress`). */
export function hufUncompress(data: Uint8Array, start: number, length: number, out: Uint16Array): void {
  if (length < 20 || start + length > data.length) throw damaged('PIZ data')
  const view = new DataView(data.buffer, data.byteOffset + start, length)
  const im = view.getUint32(0, true)
  const iM = view.getUint32(4, true)
  const nBits = view.getUint32(12, true)
  if (im >= ENC_SIZE || iM >= ENC_SIZE) throw damaged('PIZ code table')
  const codes = new Float64Array(ENC_SIZE)
  const bits = new Bits(data, start + 20, start + length)
  unpackTable(bits, im, iM, codes)
  if (nBits > 8 * (start + length - bits.pos)) throw damaged('PIZ data')
  const table = buildDecodeTable(codes, im, iM)
  huffmanDecode(codes, table, data, bits.pos, nBits, iM, out)
}

// ---------------------------------------------------------------- wavelet

const A_OFFSET = 1 << 15
const MOD_MASK = (1 << 16) - 1

/** Undoes OpenEXR's 2D wavelet on 16-bit values, in place: `n` values at `start`, steps `ox`/`oy`. */
export function wav2Decode(buf: Uint16Array, start: number, nx: number, ox: number, ny: number, oy: number, mx: number): void {
  const w14 = mx < 1 << 14
  const n = nx > ny ? ny : nx
  let p = 1
  while (p <= n) p <<= 1
  p >>= 1
  let p2 = p
  p >>= 1
  const pair = [0, 0]
  const dec = (l: number, h: number): void => {
    if (w14) {
      const ls = (l << 16) >> 16
      const hs = (h << 16) >> 16
      const ai = ls + (hs & 1) + (hs >> 1)
      pair[0] = ai & 0xffff
      pair[1] = (ai - hs) & 0xffff
    } else {
      const bb = (l - (h >> 1)) & MOD_MASK
      const aa = (h + bb - A_OFFSET) & MOD_MASK
      pair[1] = bb
      pair[0] = aa
    }
  }
  while (p >= 1) {
    const oy1 = oy * p
    const oy2 = oy * p2
    const ox1 = ox * p
    const ox2 = ox * p2
    const ey = start + oy * (ny - p2)
    let py = start
    for (; py <= ey; py += oy2) {
      const ex = py + ox * (nx - p2)
      let px = py
      for (; px <= ex; px += ox2) {
        const p01 = px + ox1
        const p10 = px + oy1
        const p11 = p10 + ox1
        dec(buf[px], buf[p10])
        const i00 = pair[0]
        const i10 = pair[1]
        dec(buf[p01], buf[p11])
        const i01 = pair[0]
        const i11 = pair[1]
        dec(i00, i01)
        buf[px] = pair[0]
        buf[p01] = pair[1]
        dec(i10, i11)
        buf[p10] = pair[0]
        buf[p11] = pair[1]
      }
      if (nx & p) {
        const p10 = px + oy1
        dec(buf[px], buf[p10])
        buf[px] = pair[0]
        buf[p10] = pair[1]
      }
    }
    if (ny & p) {
      const ex = py + ox * (nx - p2)
      let px = py
      for (; px <= ex; px += ox2) {
        const p01 = px + ox1
        dec(buf[px], buf[p01])
        buf[px] = pair[0]
        buf[p01] = pair[1]
      }
    }
    p2 = p
    p >>= 1
  }
}

/** One PIZ channel: samples per line (`nx`), lines (`ny`) and 16-bit words per sample (`size`). */
export interface PizChannel {
  nx: number
  ny: number
  size: number
}

/**
 * Decodes a PIZ block into per-channel planes of 16-bit words (each channel `nx × ny × size`
 * words, low word first for 32-bit samples), in channel order.
 */
export function pizDecode(data: Uint8Array, channels: readonly PizChannel[]): Uint16Array {
  const total = channels.reduce((s, c) => s + c.nx * c.ny * c.size, 0)
  const out = new Uint16Array(total)
  if (data.length < 4) throw damaged('PIZ data')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const minNonZero = view.getUint16(0, true)
  const maxNonZero = view.getUint16(2, true)
  let pos = 4
  const bitmap = new Uint8Array(8192)
  if (maxNonZero >= 8192) throw damaged('PIZ bitmap')
  if (minNonZero <= maxNonZero) {
    const n = maxNonZero - minNonZero + 1
    if (pos + n > data.length) throw damaged('PIZ bitmap')
    bitmap.set(data.subarray(pos, pos + n), minNonZero)
    pos += n
  }
  const lut = new Uint16Array(65536)
  let k = 0
  for (let i = 0; i < 65536; i++) if (i === 0 || bitmap[i >> 3] & (1 << (i & 7))) lut[k++] = i
  const maxValue = k - 1
  if (pos + 4 > data.length) throw damaged('PIZ data')
  const length = view.getInt32(pos, true)
  pos += 4
  if (length < 0 || pos + length > data.length) throw damaged('PIZ data')
  if (total) hufUncompress(data, pos, length, out)
  let at = 0
  for (const c of channels) {
    for (let j = 0; j < c.size; j++) wav2Decode(out, at + j, c.nx, c.size, c.ny, c.nx * c.size, maxValue)
    at += c.nx * c.ny * c.size
  }
  for (let i = 0; i < total; i++) out[i] = lut[out[i]]
  return out
}
