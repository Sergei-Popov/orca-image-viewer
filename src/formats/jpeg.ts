// JPEG structure without decoding pixels: frame size and process, EXIF, XMP and ICC segments, and
// where the stream ends. Used for previews inside RAW files, JPEG-in-TIFF and mis-named files;
// the browser decodes the pixels.

import { latin1 } from '../core/bytes'

export interface JpegInfo {
  start: number
  /** Position just after the EOI marker. */
  end: number
  width: number
  height: number
  components: number
  /** SOF marker number: 0 baseline, 1 extended, 2 progressive, 3 lossless… */
  sof: number
  precision: number
  exif: Uint8Array | null
  xmp: string | null
  icc: Uint8Array | null
  /** Adobe APP14 colour transform (0 none/CMYK, 1 YCbCr, 2 YCCK), -1 without the segment. */
  adobe: number
  jfif: boolean
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

export const SOF_NAMES: Record<number, string> = {
  0: 'Baseline', 1: 'Extended sequential', 2: 'Progressive', 3: 'Lossless', 9: 'Arithmetic sequential',
  10: 'Arithmetic progressive', 11: 'Arithmetic lossless'
}

/**
 * Parses the JPEG at `start` (FF D8). Returns null when it is not a well-formed stream, or when
 * `needEnd` and the end of the entropy-coded data cannot be found.
 */
export function jpegInfo(bytes: Uint8Array, start = 0, needEnd = true, limit = bytes.length): JpegInfo | null {
  if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) return null
  const info: JpegInfo = {
    start, end: 0, width: 0, height: 0, components: 0, sof: -1, precision: 8,
    exif: null, xmp: null, icc: null, adobe: -1, jfif: false
  }
  const iccParts: Uint8Array[] = []
  let p = start + 2
  const end = Math.min(limit, bytes.length)
  for (let guard = 0; guard < 100000; guard++) {
    // Skip fill bytes between markers.
    if (p >= end) return needEnd ? null : info.sof >= 0 ? finish(info, iccParts, end) : null
    if (bytes[p] !== 0xff) return null
    while (p < end && bytes[p] === 0xff) p++
    if (p >= end) return null
    const marker = bytes[p++]
    if (marker === 0xd9) {
      info.end = p
      return finish(info, iccParts, p)
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (p + 2 > end) return null
    const length = (bytes[p] << 8) | bytes[p + 1]
    if (length < 2 || p + length > end) return null
    const body = bytes.subarray(p + 2, p + length)
    if (SOF.has(marker)) {
      if (body.length < 6) return null
      info.sof = marker - 0xc0
      info.precision = body[0]
      info.height = (body[1] << 8) | body[2]
      info.width = (body[3] << 8) | body[4]
      info.components = body[5]
    } else if (marker === 0xe1) {
      if (!info.exif && latin1(body.subarray(0, 6)) === 'Exif\0\0') info.exif = body
      else if (!info.xmp && latin1(body.subarray(0, 29)) === 'http://ns.adobe.com/xap/1.0/\0') {
        info.xmp = new TextDecoder().decode(body.subarray(29))
      }
    } else if (marker === 0xe2) {
      if (latin1(body.subarray(0, 12)) === 'ICC_PROFILE\0') iccParts.push(body.subarray(14))
    } else if (marker === 0xe0) {
      if (latin1(body.subarray(0, 5)) === 'JFIF\0') info.jfif = true
    } else if (marker === 0xee) {
      if (latin1(body.subarray(0, 5)) === 'Adobe' && body.length >= 12) info.adobe = body[11]
    }
    p += length
    if (marker === 0xda) {
      if (!needEnd) return finish(info, iccParts, p)
      // Entropy-coded data: runs until a marker that is not a stuffed zero or a restart.
      for (;;) {
        while (p < end && bytes[p] !== 0xff) p++
        if (p + 1 >= end) return null
        const next = bytes[p + 1]
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
          p += next === 0xff ? 1 : 2
          continue
        }
        break
      }
    }
  }
  return null
}

function finish(info: JpegInfo, icc: Uint8Array[], end: number): JpegInfo | null {
  if (info.sof < 0 || !info.width || !info.height) return null
  if (!info.end) info.end = end
  if (icc.length) {
    let n = 0
    for (const c of icc) n += c.length
    const all = new Uint8Array(n)
    let at = 0
    for (const c of icc) {
      all.set(c, at)
      at += c.length
    }
    info.icc = all
  }
  return info
}

/** Whether a browser can decode this JPEG: 8-bit DCT, Huffman-coded, 1, 3 or 4 components. */
export function browserDecodable(info: JpegInfo): boolean {
  return (info.sof === 0 || info.sof === 1 || info.sof === 2) && info.precision === 8 && [1, 3, 4].includes(info.components)
}

/** Every well-formed, browser-decodable JPEG found by scanning for SOI markers. */
export function findJpegs(bytes: Uint8Array, from = 0, to = bytes.length, max = 64): JpegInfo[] {
  const out: JpegInfo[] = []
  let p = from
  const end = Math.min(to, bytes.length) - 4
  while (p < end && out.length < max) {
    if (bytes[p] === 0xff && bytes[p + 1] === 0xd8 && bytes[p + 2] === 0xff) {
      const info = jpegInfo(bytes, p, true, to)
      if (info) {
        if (browserDecodable(info) && info.width >= 32 && info.height >= 32) out.push(info)
        p = info.end
        continue
      }
    }
    p++
  }
  return out
}
