// TIFF LZW: 9- to 12-bit codes, clear code 256, end code 257. Current TIFF writes codes MSB-first
// and widens them one code early; the pre-6.0 variant (libtiff's "compat") writes them LSB-first
// and widens on time. Output stops at `expected` bytes.

export interface Decompressed {
  out: Uint8Array
  /** The stream ended cleanly (end code, or every expected byte out). */
  complete: boolean
}

const CLEAR = 256
const END = 257

export function lzwDecode(src: Uint8Array, expected: number): Decompressed {
  const out = new Uint8Array(expected)
  const old = src.length >= 2 && src[0] === 0 && (src[1] & 1) === 1
  const prefix = new Uint16Array(4096)
  const suffix = new Uint8Array(4096)
  const length = new Uint16Array(4096)
  const first = new Uint8Array(4096)
  for (let i = 0; i < 256; i++) {
    suffix[i] = i
    length[i] = 1
    first[i] = i
  }
  let pos = 0
  let bits = 0
  let buffer = 0
  let at = 0
  let width = 9
  let next = 258
  let previous = -1
  const early = old ? 0 : 1

  const write = (code: number): boolean => {
    const n = length[code]
    if (pos + n > expected) {
      // Write the part that fits, from the start of the string.
      let c = code
      const tmp = new Uint8Array(n)
      for (let i = n - 1; i >= 0; i--) {
        tmp[i] = suffix[c]
        c = prefix[c]
      }
      out.set(tmp.subarray(0, expected - pos), pos)
      pos = expected
      return false
    }
    let c = code
    for (let i = pos + n - 1; i >= pos; i--) {
      out[i] = suffix[c]
      c = prefix[c]
    }
    pos += n
    return true
  }

  for (;;) {
    while (bits < width) {
      if (at >= src.length) return { out, complete: pos >= expected }
      if (old) buffer |= src[at++] << bits
      else buffer = ((buffer << 8) | src[at++]) >>> 0
      bits += 8
    }
    let code: number
    if (old) {
      code = buffer & ((1 << width) - 1)
      buffer >>>= width
    } else {
      code = (buffer >>> (bits - width)) & ((1 << width) - 1)
      buffer &= (1 << (bits - width)) - 1
    }
    bits -= width

    if (code === CLEAR) {
      width = 9
      next = 258
      previous = -1
      continue
    }
    if (code === END) return { out, complete: true }
    if (previous < 0) {
      if (code > 255) return { out, complete: false }
      if (!write(code)) return { out, complete: true }
      previous = code
      continue
    }
    if (code < next) {
      if (!write(code)) return { out, complete: true }
      if (next < 4096) {
        prefix[next] = previous
        suffix[next] = first[code]
        length[next] = length[previous] + 1
        first[next] = first[previous]
        next++
      }
    } else if (code === next && next < 4096) {
      prefix[next] = previous
      suffix[next] = first[previous]
      length[next] = length[previous] + 1
      first[next] = first[previous]
      next++
      if (!write(code)) return { out, complete: true }
    } else {
      return { out, complete: false }
    }
    previous = code
    if (next + early >= 1 << width && width < 12) width++
  }
}

/** LZW encoding as current TIFF writes it, for test fixtures. */
export function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  let width = 9
  const emit = (code: number) => {
    buffer = (buffer << width) | code
    bits += width
    while (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
    buffer &= (1 << bits) - 1
  }
  let dict = new Map<string, number>()
  let next = 258
  emit(CLEAR)
  let w = ''
  for (let i = 0; i < data.length; i++) {
    const c = String.fromCharCode(data[i])
    const wc = w + c
    if (w === '' || dict.has(wc) || wc.length === 1) {
      w = wc
      continue
    }
    emit(w.length === 1 ? w.charCodeAt(0) : (dict.get(w) as number))
    dict.set(wc, next++)
    // The encoder runs one table entry ahead of the decoder, so it widens on `next`, not `next + 1`.
    if (next === 4094) {
      emit(CLEAR)
      dict = new Map()
      next = 258
      width = 9
    } else if (next >= 1 << width) {
      width++
    }
    w = c
  }
  if (w) emit(w.length === 1 ? w.charCodeAt(0) : (dict.get(w) as number))
  emit(END)
  if (bits > 0) out.push((buffer << (8 - bits)) & 255)
  return new Uint8Array(out)
}
