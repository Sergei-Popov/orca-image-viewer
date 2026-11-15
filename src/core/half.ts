// IEEE 754 half-precision floats: a 65,536-entry table turns the 16 bits into a float, and
// `toHalf` goes back (for test fixtures and the EXR writer).

let table: Float32Array | null = null

/** Every half value as a float, indexed by its 16 bits. */
export function halfTable(): Float32Array {
  if (table) return table
  table = new Float32Array(65536)
  for (let h = 0; h < 65536; h++) table[h] = halfToFloat(h)
  return table
}

export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const mantissa = h & 0x3ff
  if (exponent === 0) return sign * mantissa * 2 ** -24
  if (exponent === 31) return mantissa ? NaN : sign * Infinity
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15)
}

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** The nearest half (round to nearest even) for a float. */
export function toHalf(value: number): number {
  f32[0] = value
  const x = u32[0]
  const sign = (x >>> 16) & 0x8000
  const exponent = (x >>> 23) & 0xff
  let mantissa = x & 0x7fffff
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0)
  let e = exponent - 127 + 15
  if (e >= 31) return sign | 0x7c00
  if (e <= 0) {
    if (e < -10) return sign
    mantissa |= 0x800000
    const shift = 14 - e
    let half = mantissa >> shift
    const rest = mantissa & ((1 << shift) - 1)
    const halfway = 1 << (shift - 1)
    if (rest > halfway || (rest === halfway && half & 1)) half++
    return sign | half
  }
  let half = (e << 10) | (mantissa >> 13)
  const rest = mantissa & 0x1fff
  if (rest > 0x1000 || (rest === 0x1000 && half & 1)) half++
  return sign | half
}

/** 24-bit floats (TIFF SampleFormat 3, BitsPerSample 24): 1 sign, 7 exponent, 16 mantissa bits. */
export function float24ToFloat(v: number): number {
  const sign = v & 0x800000 ? -1 : 1
  const exponent = (v >> 16) & 0x7f
  const mantissa = v & 0xffff
  if (exponent === 0) return sign * mantissa * 2 ** (-62 - 16)
  if (exponent === 127) return mantissa ? NaN : sign * Infinity
  return sign * (1 + mantissa / 65536) * 2 ** (exponent - 63)
}
