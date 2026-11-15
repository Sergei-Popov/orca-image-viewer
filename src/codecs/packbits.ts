// PackBits run-length coding (TIFF compression 32773, PSD and ICNS-like RLE rows): a signed count
// byte, then n+1 literal bytes, or one byte repeated 1−n times; −128 is a no-op.

import type { Decompressed } from './lzw'

export function packbitsDecode(src: Uint8Array, expected: number, from = 0, to = src.length): Decompressed & { end: number } {
  const out = new Uint8Array(expected)
  let i = from
  let o = 0
  while (o < expected && i < to) {
    const n = src[i++]
    if (n < 128) {
      const count = Math.min(n + 1, expected - o, to - i)
      out.set(src.subarray(i, i + count), o)
      o += count
      i += n + 1
    } else if (n > 128) {
      if (i >= to) break
      const count = Math.min(257 - n, expected - o)
      out.fill(src[i++], o, o + count)
      o += count
    }
  }
  return { out, complete: o >= expected, end: Math.min(i, to) }
}

/** PackBits encoding, for test fixtures. */
export function packbitsEncode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    let run = 1
    while (i + run < data.length && run < 128 && data[i + run] === data[i]) run++
    if (run >= 2) {
      out.push(257 - run, data[i])
      i += run
      continue
    }
    const start = i
    while (i < data.length && i - start < 128 && !(i + 1 < data.length && data[i + 1] === data[i])) i++
    if (i === start) i++
    out.push(i - start - 1)
    for (let k = start; k < i; k++) out.push(data[k])
  }
  return new Uint8Array(out)
}
