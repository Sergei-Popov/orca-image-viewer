// Radiance RGBE (.hdr, .pic): the text header, flat, old run-length and new per-channel RLE
// scanlines, XYZE converted to linear sRGB, and all eight scan orders of the resolution line.

import { latin1 } from '../core/bytes'
import { checkSize, damaged, ImageError } from '../core/errors'
import { type Decoded, type InfoItem, raster } from '../core/model'

export function isRadiance(bytes: Uint8Array): boolean {
  const head = latin1(bytes.subarray(0, 10))
  return head.startsWith('#?RADIANCE') || head.startsWith('#?RGBE') || head.startsWith('#?AUTOPANO') || /^#\?[A-Z]/.test(head)
}

interface HdrHeader {
  format: string
  exposure: number
  gamma: number | null
  software: string
  view: string
  primaries: string
  lines: string[]
  /** Major axis first: e.g. `-Y 480 +X 640`. */
  resolution: string
  dataAt: number
}

function readHeader(bytes: Uint8Array): HdrHeader {
  let at = 0
  const lines: string[] = []
  const line = () => {
    const start = at
    while (at < bytes.length && bytes[at] !== 0x0a) at++
    if (at >= bytes.length) throw damaged('Radiance header')
    const s = latin1(bytes.subarray(start, at))
    at++
    return s
  }
  const first = line()
  if (!first.startsWith('#?')) throw damaged('Radiance signature')
  for (let i = 0; i < 4096; i++) {
    const s = line()
    if (s === '') break
    lines.push(s)
  }
  const resolution = line().trim()
  let format = ''
  let exposure = 1
  let gamma: number | null = null
  let software = ''
  let view = ''
  let primaries = ''
  for (const l of lines) {
    const m = /^([A-Z]+)\s*=\s*(.*)$/.exec(l)
    if (!m) {
      if (l.startsWith('#') && !software) software = l.slice(1).trim()
      continue
    }
    const [, key, value] = m
    if (key === 'FORMAT') format = value.trim()
    else if (key === 'EXPOSURE') exposure *= Number(value) || 1
    else if (key === 'GAMMA') gamma = Number(value) || null
    else if (key === 'SOFTWARE') software = value.trim()
    else if (key === 'VIEW') view = value.trim()
    else if (key === 'PRIMARIES') primaries = value.trim()
  }
  return { format, exposure, gamma, software, view, primaries, lines, resolution, dataAt: at }
}

/** Reads one scanline of `width` RGBE pixels at `at` into `out`; returns the next position. */
function scanline(bytes: Uint8Array, at: number, width: number, out: Uint8Array): number {
  const end = bytes.length
  if (at + 4 > end) throw damaged('Radiance scanline')
  if (width >= 8 && width < 32768 && bytes[at] === 2 && bytes[at + 1] === 2 && !(bytes[at + 2] & 0x80)) {
    // New RLE: each of the four components separately.
    if (((bytes[at + 2] << 8) | bytes[at + 3]) !== width) throw damaged('Radiance scanline width')
    at += 4
    for (let c = 0; c < 4; c++) {
      let x = 0
      while (x < width) {
        if (at >= end) throw damaged('Radiance scanline')
        let count = bytes[at++]
        if (count > 128) {
          count -= 128
          if (count > width - x || at >= end) throw damaged('Radiance run')
          const v = bytes[at++]
          for (let k = 0; k < count; k++) out[(x++) * 4 + c] = v
        } else {
          if (count === 0 || count > width - x || at + count > end) throw damaged('Radiance run')
          for (let k = 0; k < count; k++) out[(x++) * 4 + c] = bytes[at++]
        }
      }
    }
    return at
  }
  // Flat pixels, with the old run-length scheme (1,1,1,n repeats the previous pixel).
  let x = 0
  let shift = 0
  while (x < width) {
    if (at + 4 > end) throw damaged('Radiance scanline')
    const r = bytes[at], g = bytes[at + 1], b = bytes[at + 2], e = bytes[at + 3]
    at += 4
    if (r === 1 && g === 1 && b === 1) {
      if (x === 0) throw damaged('Radiance run')
      const count = e << shift
      const p = (x - 1) * 4
      for (let k = 0; k < count && x < width; k++, x++) {
        out[x * 4] = out[p]; out[x * 4 + 1] = out[p + 1]; out[x * 4 + 2] = out[p + 2]; out[x * 4 + 3] = out[p + 3]
      }
      shift += 8
    } else {
      out[x * 4] = r; out[x * 4 + 1] = g; out[x * 4 + 2] = b; out[x * 4 + 3] = e
      x++
      shift = 0
    }
  }
  return at
}

/** Parses `-Y 480 +X 640` into scan order and size. */
function parseResolution(s: string) {
  const m = /^([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)$/.exec(s)
  if (!m || m[2] === m[5]) throw damaged('Radiance resolution')
  const major = { sign: m[1], axis: m[2], n: Number(m[3]) }
  const minor = { sign: m[4], axis: m[5], n: Number(m[6]) }
  const width = major.axis === 'X' ? major.n : minor.n
  const height = major.axis === 'Y' ? major.n : minor.n
  return { major, minor, width, height }
}

const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252]

export function openRadiance(bytes: Uint8Array): Decoded {
  const h = readHeader(bytes)
  const xyz = h.format === '32-bit_rle_xyze'
  if (h.format && h.format !== '32-bit_rle_rgbe' && !xyz) throw new ImageError('unsupported-pixels', h.format)
  const res = parseResolution(h.resolution)
  const { width, height } = res
  checkSize(width, height, 12)
  const out = new Float32Array(width * height * 3)
  // Each scanline runs along the minor axis; scanlines follow each other along the major one.
  const along = (axis: string, sign: string, index: number, n: number) =>
    axis === 'Y' ? (sign === '-' ? index : n - 1 - index) : sign === '+' ? index : n - 1 - index
  const length = res.minor.n
  const rgbe = new Uint8Array(length * 4)
  let at = h.dataAt
  let partial = false
  for (let s = 0; s < res.major.n; s++) {
    try {
      at = scanline(bytes, at, length, rgbe)
    } catch {
      partial = true
      break
    }
    const majorAt = along(res.major.axis, res.major.sign, s, res.major.n)
    for (let i = 0; i < length; i++) {
      const minorAt = along(res.minor.axis, res.minor.sign, i, res.minor.n)
      const x = res.major.axis === 'X' ? majorAt : minorAt
      const y = res.major.axis === 'Y' ? majorAt : minorAt
      const e = rgbe[i * 4 + 3]
      const d = (y * width + x) * 3
      if (e === 0) {
        out[d] = out[d + 1] = out[d + 2] = 0
        continue
      }
      const f = 2 ** (e - 136)
      let r = (rgbe[i * 4] + 0.5) * f
      let g = (rgbe[i * 4 + 1] + 0.5) * f
      let b = (rgbe[i * 4 + 2] + 0.5) * f
      if (xyz) {
        const m = XYZ_TO_SRGB
        const X = r, Y = g, Z = b
        r = m[0] * X + m[1] * Y + m[2] * Z
        g = m[3] * X + m[4] * Y + m[5] * Z
        b = m[6] * X + m[7] * Y + m[8] * Z
      }
      out[d] = r
      out[d + 1] = g
      out[d + 2] = b
    }
  }
  const ras = raster(width, height, 3, 'f32', out, { transfer: 'linear', partial, bits: 32 })
  const items: InfoItem[] = [
    { key: 'dimensions', value: `${width} × ${height}` },
    { key: 'pixelFormat', value: xyz ? 'XYZE (shown as linear sRGB)' : 'RGBE (shared exponent)' },
    { key: 'channels', value: 'RGB' },
    { key: 'scanOrder', value: h.resolution.replace(/\s+\d+/g, '').replace(/\s+/g, ' ') }
  ]
  if (h.exposure !== 1) items.push({ key: 'exposureHeader', value: String(h.exposure) })
  if (h.gamma) items.push({ key: 'gamma', value: String(h.gamma) })
  if (h.primaries) items.push({ key: 'primaries', value: h.primaries })
  if (h.view) items.push({ key: 'view', value: h.view })
  if (h.software) items.push({ key: 'software', value: h.software })
  return {
    desc: {
      format: 'Radiance HDR',
      images: [{ id: 0, width, height, at: [], label: `${width}×${height}`, info: [] }],
      axes: [],
      primary: 0,
      info: [{ title: 'image', items }],
      notices: []
    },
    decode: async () => ras
  }
}
