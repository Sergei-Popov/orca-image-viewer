// Photoshop documents (PSD) and large documents (PSB): the flattened image, every layer with its
// pixels, visibility, opacity, blend mode, groups and mask, and the document's image resources
// (resolution, ICC profile, EXIF, XMP, guides). A file saved without "Maximize compatibility" has no
// real flattened image; the layers are then composited here, simply: pixel, text and smart-object
// layers with their blend modes, masks and clipping, without adjustment layers or layer effects.

import { packbitsDecode } from '../codecs/packbits'
import { undoFloatingPoint, undoHorizontal } from '../codecs/predictor'
import { latin1, Reader, text, utf16be } from '../core/bytes'
import { checkSize, damaged, ImageError, MAX_RASTER_BYTES, unsupportedPixels } from '../core/errors'
import type { Decoded, ImageDesc, InfoItem, InfoSection, LayerDesc, Notice, Platform, Raster, SampleKind, Samples } from '../core/model'
import { allocate, joinLabel, raster } from '../core/model'
import { cmykToRgb, labToRgb } from '../core/pixels'
import { count as counted } from '../core/plural'
import { exifFromBlock } from '../meta/exif'
import { iccItems, readIcc } from '../meta/icc'
import { xmpSection } from '../meta/xmp'

export const MODE_NAMES: Record<number, string> = {
  0: 'Bitmap',
  1: 'Greyscale',
  2: 'Indexed',
  3: 'RGB',
  4: 'CMYK',
  7: 'Multichannel',
  8: 'Duotone',
  9: 'Lab'
}

export const BLEND_NAMES: Record<string, string> = {
  pass: 'Pass through',
  norm: 'Normal',
  diss: 'Dissolve',
  dark: 'Darken',
  'mul ': 'Multiply',
  idiv: 'Colour burn',
  lbrn: 'Linear burn',
  dkCl: 'Darker colour',
  lite: 'Lighten',
  scrn: 'Screen',
  'div ': 'Colour dodge',
  lddg: 'Linear dodge (add)',
  lgCl: 'Lighter colour',
  over: 'Overlay',
  sLit: 'Soft light',
  hLit: 'Hard light',
  vLit: 'Vivid light',
  lLit: 'Linear light',
  pLit: 'Pin light',
  hMix: 'Hard mix',
  diff: 'Difference',
  smud: 'Exclusion',
  fsub: 'Subtract',
  fdiv: 'Divide',
  'hue ': 'Hue',
  'sat ': 'Saturation',
  colr: 'Colour',
  'lum ': 'Luminosity'
}

const ADJUSTMENTS = new Set([
  'levl', 'curv', 'brit', 'blnc', 'hue ', 'hue2', 'selc', 'thrs', 'nvrt', 'post', 'mixr', 'grdm', 'phfl', 'expA', 'vibA', 'clrL', 'blwh', 'CgEd'
])
const FILLS = new Set(['SoCo', 'GdFl', 'PtFl'])
const LONG_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'])

interface Header {
  version: number
  channels: number
  height: number
  width: number
  depth: number
  mode: number
}

interface Channel {
  id: number
  length: number
  /** Start of the channel's data (its compression word), set after the records are read. */
  at: number
}

interface Mask {
  top: number
  left: number
  bottom: number
  right: number
  defaultColor: number
  disabled: boolean
}

interface LayerRecord {
  index: number
  top: number
  left: number
  bottom: number
  right: number
  channels: Channel[]
  blend: string
  opacity: number
  fillOpacity: number
  clipping: boolean
  hidden: boolean
  name: string
  section: number
  kind: LayerDesc['kind']
  mask: Mask | null
}

interface Resources {
  icc: Uint8Array | null
  xmp: Uint8Array | null
  exif: Uint8Array | null
  resolution: { h: number; v: number; unit: number } | null
  realMerged: boolean | null
  writer: string
  guides: number
  palette: Uint8Array | null
  transparentIndex: number
  /** Unicode alpha channel names (resource 1045), one per channel after the colour channels. */
  alphaNames: string[]
  /** Pascal alpha channel names (resource 1006), written by tools that skip 1045. */
  pascalAlphaNames: string[]
  /** Alpha identifiers (resource 1053); Photoshop gives the flattened image's transparency 0. */
  alphaIds: number[]
}

function readResources(bytes: Uint8Array, from: number, to: number): Resources {
  const res: Resources = { icc: null, xmp: null, exif: null, resolution: null, realMerged: null, writer: '', guides: 0, palette: null, transparentIndex: -1, alphaNames: [], pascalAlphaNames: [], alphaIds: [] }
  const r = new Reader(bytes.subarray(0, to), false, from)
  while (r.left >= 12) {
    const sig = r.ascii(4)
    if (sig !== '8BIM' && sig !== 'MeSa' && sig !== 'AgHg' && sig !== 'PHUT' && sig !== 'DCSR') break
    const id = r.u16()
    const nameLength = r.u8()
    r.skip(nameLength + ((nameLength + 1) % 2))
    const size = r.u32()
    if (size > r.left) break
    const data = r.take(size)
    if (size % 2) r.skip(Math.min(1, r.left))
    try {
      switch (id) {
        case 1039:
          res.icc = data
          break
        case 1060:
          res.xmp = data
          break
        case 1058:
          res.exif = data
          break
        case 1005: {
          const d = new Reader(data, false)
          const h = d.u32() / 65536
          const hu = d.u16()
          d.u16()
          const v = d.u32() / 65536
          res.resolution = { h, v, unit: hu }
          break
        }
        case 1057: {
          const d = new Reader(data, false)
          d.u32()
          res.realMerged = d.u8() !== 0
          const n = d.u32()
          res.writer = utf16be(d.take(Math.min(n * 2, d.left))).replace(/\0+$/, '')
          break
        }
        case 1032: {
          const d = new Reader(data, false)
          d.skip(12)
          res.guides = d.u32()
          break
        }
        case 1047:
          res.transparentIndex = new Reader(data, false).u16()
          break
        case 1045: {
          const d = new Reader(data, false)
          while (d.left >= 4) {
            const n = d.u32()
            res.alphaNames.push(utf16be(d.take(Math.min(n * 2, d.left))).replace(/\0+$/, ''))
          }
          break
        }
        case 1006: {
          const d = new Reader(data, false)
          while (d.left >= 1) {
            const n = d.u8()
            res.pascalAlphaNames.push(latin1(d.take(Math.min(n, d.left))))
          }
          break
        }
        case 1053: {
          const d = new Reader(data, false)
          while (d.left >= 4) res.alphaIds.push(d.u32())
          break
        }
      }
    } catch {
      // A damaged resource is skipped; the image does not depend on it.
    }
  }
  return res
}

/**
 * Takes the white back out of a flattened image that was composited over white:
 * colour = (stored − (1 − alpha)) / alpha, as psd-tools and ImageMagick read it. Integer samples
 * are kept in range; 32-bit float samples are left unclamped, as psd-tools leaves them, so HDR
 * colour above 1 survives.
 */
function unmatte(colour: Samples[], alpha: Samples, top: number): void {
  const float = top === 1
  for (const plane of colour) {
    for (let i = 0; i < plane.length; i++) {
      const a = alpha[i]
      if (a <= 0 || a >= top) continue
      const v = ((plane[i] + a - top) * top) / a
      plane[i] = float ? v : v <= 0 ? 0 : v >= top ? top : Math.round(v)
    }
  }
}

/**
 * Whether a flattened image looks composited over white. White at opacity a leaves every sample
 * at least top − a (one level less for rounding), and clear pixels white; straight colour breaks
 * that at almost any dark or saturated pixel that is not opaque. GIMP mattes against white, macOS
 * sips does not, and both mark the channel the same way, so only the data can tell them apart.
 */
function looksMatted(colour: Samples[], alpha: Samples, top: number): boolean {
  const slack = top === 1 ? 1 / 4096 : 1
  for (const plane of colour) {
    for (let i = 0; i < plane.length; i++) if (plane[i] < top - alpha[i] - slack) return false
  }
  return true
}

function blendKey(r: Reader): string {
  return r.ascii(4)
}

/** Layer records and where each channel's data sits. */
function readLayerInfo(bytes: Uint8Array, at: number, end: number, psb: boolean): { layers: LayerRecord[]; mergedAlpha: boolean } {
  const r = new Reader(bytes.subarray(0, end), false, at)
  let count = r.i16()
  const mergedAlpha = count < 0
  count = Math.abs(count)
  if (count > 10000) throw damaged('PSD layer count')
  const layers: LayerRecord[] = []
  for (let i = 0; i < count; i++) {
    const top = r.i32()
    const left = r.i32()
    const bottom = r.i32()
    const right = r.i32()
    const n = r.u16()
    if (n > 64) throw damaged('PSD layer channels')
    const channels: Channel[] = []
    for (let c = 0; c < n; c++) channels.push({ id: r.i16(), length: psb ? r.u64() : r.u32(), at: 0 })
    const sig = r.ascii(4)
    if (sig !== '8BIM' && sig !== '8B64') throw damaged('PSD layer record')
    const blend = blendKey(r)
    const opacity = r.u8() / 255
    const clipping = r.u8() === 1
    const flags = r.u8()
    r.u8()
    const extraLength = r.u32()
    const extraEnd = r.pos + extraLength
    if (extraEnd > end) throw damaged('PSD layer record')
    let mask: Mask | null = null
    const maskSize = r.u32()
    if (maskSize >= 18) {
      const m = new Reader(bytes.subarray(0, r.pos + maskSize), false, r.pos)
      const mt = m.i32(), ml = m.i32(), mb = m.i32(), mr = m.i32()
      const defaultColor = m.u8()
      const mflags = m.u8()
      mask = { top: mt, left: ml, bottom: mb, right: mr, defaultColor, disabled: (mflags & 2) !== 0 }
    }
    r.skip(maskSize)
    r.skip(r.u32())
    const nameLength = r.u8()
    let name = latin1(r.take(nameLength))
    r.skip((4 - ((nameLength + 1) % 4)) % 4)
    let section = 0
    let kind: LayerDesc['kind'] = 'pixel'
    let fillOpacity = 1
    while (r.pos + 12 <= extraEnd) {
      const s = r.ascii(4)
      if (s !== '8BIM' && s !== '8B64') break
      const key = r.ascii(4)
      const size = psb && LONG_KEYS.has(key) ? r.u64() : r.u32()
      const start = r.pos
      if (start + size > extraEnd) break
      try {
        const d = new Reader(bytes.subarray(0, start + size), false, start)
        if (key === 'luni') {
          const len = d.u32()
          name = utf16be(d.take(Math.min(len * 2, d.left))).replace(/\0+$/, '')
        } else if (key === 'lsct' || key === 'lsdk') {
          section = d.u32()
        } else if (key === 'TySh' || key === 'tySh') {
          kind = 'text'
        } else if (key === 'SoLd' || key === 'PlLd' || key === 'SoLE' || key === 'plLd') {
          kind = 'smart'
        } else if (FILLS.has(key)) {
          kind = 'fill'
        } else if (ADJUSTMENTS.has(key)) {
          kind = 'adjustment'
        } else if (key === 'iOpa') {
          fillOpacity = d.u8() / 255
        }
      } catch {
        // Unknown or short tagged block.
      }
      r.seek(nextBlock(bytes, start + size, extraEnd))
    }
    r.seek(extraEnd)
    if (section === 1 || section === 2) kind = 'group'
    layers.push({ index: i, top, left, bottom, right, channels, blend, opacity, fillOpacity, clipping, hidden: (flags & 2) !== 0, name, section, kind, mask })
  }
  // Channel data follows the records, layer by layer, channel by channel.
  let pos = r.pos
  for (const layer of layers) {
    for (const ch of layer.channels) {
      ch.at = pos
      pos += ch.length
    }
  }
  return { layers, mergedAlpha }
}

/** The next tagged block: lengths are padded to 2 or 4 bytes depending on the writer. */
function nextBlock(bytes: Uint8Array, at: number, end: number): number {
  for (let k = 0; k < 4; k++) {
    const p = at + k
    if (p + 4 > end) break
    const sig = latin1(bytes.subarray(p, p + 4))
    if (sig === '8BIM' || sig === '8B64') return p
  }
  return Math.min(at, end)
}

const bytesOf = (depth: number) => (depth === 32 ? 4 : depth === 16 ? 2 : 1)

/** One channel's plane as stored (big-endian samples, or 1-bit rows). */
async function readPlane(
  bytes: Uint8Array,
  at: number,
  length: number,
  width: number,
  height: number,
  depth: number,
  psb: boolean,
  platform: Platform
): Promise<{ plane: Uint8Array; complete: boolean }> {
  const rowBytes = depth === 1 ? Math.ceil(width / 8) : width * bytesOf(depth)
  const size = rowBytes * height
  if (length < 2 || at + 2 > bytes.length) return { plane: new Uint8Array(size), complete: false }
  const compression = (bytes[at] << 8) | bytes[at + 1]
  const end = Math.min(bytes.length, at + length)
  const data = bytes.subarray(at + 2, end)
  return decodePlaneData(data, compression, rowBytes, height, width, depth, psb, platform, end < at + length)
}

async function decodePlaneData(
  data: Uint8Array,
  compression: number,
  rowBytes: number,
  height: number,
  width: number,
  depth: number,
  psb: boolean,
  platform: Platform,
  cut: boolean
): Promise<{ plane: Uint8Array; complete: boolean }> {
  const size = rowBytes * height
  switch (compression) {
    case 0: {
      const plane = new Uint8Array(size)
      plane.set(data.subarray(0, size))
      return { plane, complete: data.length >= size && !cut }
    }
    case 1: {
      const plane = new Uint8Array(size)
      const countBytes = psb ? 4 : 2
      let pos = height * countBytes
      if (pos > data.length) return { plane, complete: false }
      let complete = !cut
      for (let y = 0; y < height; y++) {
        const at = y * countBytes
        const n = psb ? ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0 : (data[at] << 8) | data[at + 1]
        if (pos >= data.length) {
          complete = false
          break
        }
        const row = packbitsDecode(data, rowBytes, pos, Math.min(data.length, pos + n))
        plane.set(row.out, y * rowBytes)
        if (!row.complete) complete = false
        pos += n
      }
      return { plane, complete }
    }
    case 2:
    case 3: {
      const plane = await platform.inflate(data, 'deflate', size)
      if (compression === 3) {
        if (depth === 32) undoFloatingPoint(plane, height, rowBytes, width, 1, 32)
        else if (depth === 16) undoHorizontal(plane, height, rowBytes, width, 1, 16, false)
        else undoHorizontal(plane, height, rowBytes, width, 1, 8, false)
      }
      return { plane, complete: !cut }
    }
    default:
      throw new ImageError('unsupported-compression', `PSD compression ${compression}`)
  }
}

/** Plane bytes to samples: u8, u16 or f32 (big-endian in the file). */
function samplesOf(plane: Uint8Array, width: number, height: number, depth: number): Samples {
  const n = width * height
  if (depth === 8) return plane
  if (depth === 1) {
    const out = new Uint8Array(n)
    const rowBytes = Math.ceil(width / 8)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) out[y * width + x] = (plane[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255
    }
    return out
  }
  const view = new DataView(plane.buffer, plane.byteOffset, plane.byteLength)
  if (depth === 16) {
    const out = new Uint16Array(n)
    for (let i = 0; i < n; i++) out[i] = view.getUint16(i * 2)
    return out
  }
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4)
  return out
}

function kindOf(depth: number): SampleKind {
  return depth === 32 ? 'f32' : depth === 16 ? 'u16' : 'u8'
}

/**
 * Colour planes (in the document's mode) plus an optional alpha plane to an RGB or grey raster.
 * CMYK and multichannel planes store 255 as no ink.
 */
function toRaster(
  header: Header,
  width: number,
  height: number,
  planes: Samples[],
  alpha: Samples | null,
  palette: Uint8Array | null,
  notices: Notice[]
): Raster {
  const n = width * height
  const depth = header.depth === 1 ? 8 : header.depth
  const kind = kindOf(depth)
  const transfer = depth === 32 ? 'linear' : 'srgb'
  const top = kind === 'u8' ? 255 : kind === 'u16' ? 65535 : 1
  const withAlpha = (colour: Samples[], color: 'gray' | 'rgb'): Raster => {
    const c = colour.length + (alpha ? 1 : 0)
    const out = allocate(kind, n * c)
    for (let k = 0; k < colour.length; k++) {
      const p = colour[k]
      for (let i = 0, d = k; i < n; i++, d += c) out[d] = p[i]
    }
    if (alpha) for (let i = 0, d = colour.length; i < n; i++, d += c) out[d] = alpha[i]
    return raster(width, height, c, kind, out, { color, alpha: !!alpha, transfer, bits: depth === 32 ? 32 : depth })
  }
  switch (header.mode) {
    case 0:
    case 1:
    case 8:
      return withAlpha([planes[0]], 'gray')
    case 7: {
      const inverted = allocate(kind, n)
      for (let i = 0; i < n; i++) inverted[i] = top - planes[0][i]
      return withAlpha([inverted], 'gray')
    }
    case 2: {
      if (!palette || palette.length < 768) throw damaged('PSD colour table')
      const out = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)]
      for (let i = 0; i < n; i++) {
        const v = planes[0][i]
        out[0][i] = palette[v]
        out[1][i] = palette[256 + v]
        out[2][i] = palette[512 + v]
      }
      return withAlpha(out, 'rgb')
    }
    case 3:
      if (planes.length < 3) return withAlpha([planes[0]], 'gray')
      return withAlpha(planes.slice(0, 3), 'rgb')
    case 4: {
      if (planes.length < 4 || kind === 'f32') throw unsupportedPixels(kind === 'f32' ? '32-bit CMYK' : 'CMYK without four channels')
      const inter = allocate(kind, n * 4)
      for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) inter[i * 4 + k] = planes[k][i]
      const rgb = cmykToRgb(inter, kind as 'u8' | 'u16', n, 4, true)
      const split = [allocate(kind, n), allocate(kind, n), allocate(kind, n)]
      for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) split[k][i] = rgb[i * 3 + k]
      if (!notices.some((x) => x.code === 'cmyk-converted')) notices.push({ code: 'cmyk-converted' })
      return withAlpha(split, 'rgb')
    }
    case 9: {
      if (planes.length < 3) throw damaged('Lab without three channels')
      const out = [allocate(kind, n), allocate(kind, n), allocate(kind, n)]
      const px = [0, 0, 0]
      for (let i = 0; i < n; i++) {
        let L: number, a: number, b: number
        if (kind === 'f32') {
          L = planes[0][i] * 100
          a = planes[1][i] * 255 - 128
          b = planes[2][i] * 255 - 128
        } else {
          L = (planes[0][i] * 100) / top
          a = (planes[1][i] * 255) / top - 128
          b = (planes[2][i] * 255) / top - 128
        }
        labToRgb(L, a, b, px)
        for (let k = 0; k < 3; k++) out[k][i] = kind === 'f32' ? px[k] : Math.round(px[k] * top)
      }
      if (!notices.some((x) => x.code === 'lab-converted')) notices.push({ code: 'lab-converted' })
      return { ...withAlpha(out, 'rgb'), transfer: 'srgb' }
    }
    default:
      throw unsupportedPixels(`${MODE_NAMES[header.mode] ?? `mode ${header.mode}`} colour mode`)
  }
}

/** Colour channel ids of a layer in this mode, in order. */
function colourIds(mode: number): number[] {
  if (mode === 3 || mode === 9) return [0, 1, 2]
  if (mode === 4) return [0, 1, 2, 3]
  return [0]
}

// ---------------------------------------------------------------- compositing

type BlendFn = (b: number, s: number) => number

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const burn: BlendFn = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s))
const dodge: BlendFn = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)))

const SEPARABLE: Record<string, BlendFn> = {
  norm: (_b, s) => s,
  diss: (_b, s) => s,
  'mul ': (b, s) => b * s,
  scrn: (b, s) => b + s - b * s,
  over: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  hLit: (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  sLit: (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b)
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)
    return b + (2 * s - 1) * (d - b)
  },
  dark: (b, s) => Math.min(b, s),
  lite: (b, s) => Math.max(b, s),
  diff: (b, s) => Math.abs(b - s),
  smud: (b, s) => b + s - 2 * b * s,
  'div ': dodge,
  idiv: burn,
  lddg: (b, s) => Math.min(1, b + s),
  lbrn: (b, s) => Math.max(0, b + s - 1),
  fsub: (b, s) => Math.max(0, b - s),
  fdiv: (b, s) => (s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s)),
  vLit: (b, s) => (s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1)),
  lLit: (b, s) => clamp(b + 2 * s - 1),
  pLit: (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  hMix: (b, s) => (b + s >= 1 ? 1 : 0)
}

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b

function clipColor(c: number[]): number[] {
  const l = lum(c[0], c[1], c[2])
  const n = Math.min(c[0], c[1], c[2])
  const x = Math.max(c[0], c[1], c[2])
  if (n < 0) for (let k = 0; k < 3; k++) c[k] = l + ((c[k] - l) * l) / (l - n || 1)
  if (x > 1) for (let k = 0; k < 3; k++) c[k] = l + ((c[k] - l) * (1 - l)) / (x - l || 1)
  return c
}

function setLum(c: number[], l: number): number[] {
  const d = l - lum(c[0], c[1], c[2])
  return clipColor([c[0] + d, c[1] + d, c[2] + d])
}

function setSat(c: number[], s: number): number[] {
  const out = [0, 0, 0]
  const order = [0, 1, 2].sort((a, b) => c[a] - c[b])
  const [lo, mid, hi] = order
  if (c[hi] > c[lo]) {
    out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo])
    out[hi] = s
  }
  return out
}

const sat = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])

/** Non-separable modes on whole colours. */
function blendColour(key: string, b: number[], s: number[]): number[] {
  switch (key) {
    case 'hue ':
      return setLum(setSat(s, sat(b)), lum(b[0], b[1], b[2]))
    case 'sat ':
      return setLum(setSat(b, sat(s)), lum(b[0], b[1], b[2]))
    case 'colr':
      return setLum(s, lum(b[0], b[1], b[2]))
    case 'lum ':
      return setLum(b, lum(s[0], s[1], s[2]))
    case 'dkCl':
      return lum(s[0], s[1], s[2]) < lum(b[0], b[1], b[2]) ? s : b
    case 'lgCl':
      return lum(s[0], s[1], s[2]) > lum(b[0], b[1], b[2]) ? s : b
    default:
      return s
  }
}

// ---------------------------------------------------------------- document

export async function openPsd(bytes: Uint8Array, platform: Platform): Promise<Decoded> {
  const r = new Reader(bytes, false)
  if (r.ascii(4) !== '8BPS') throw damaged('PSD signature')
  const version = r.u16()
  if (version !== 1 && version !== 2) throw damaged(`PSD version ${version}`)
  const psb = version === 2
  r.skip(6)
  const header: Header = { version, channels: r.u16(), height: r.u32(), width: r.u32(), depth: r.u16(), mode: r.u16() }
  if (![1, 8, 16, 32].includes(header.depth)) throw unsupportedPixels(`${header.depth}-bit PSD`)
  if (!header.width || !header.height || header.channels < 1 || header.channels > 56) throw damaged('PSD header')
  const modeLength = r.u32()
  const palette = header.mode === 2 ? r.take(Math.min(modeLength, r.left)) : (r.skip(modeLength), null)
  const resourcesLength = r.u32()
  const resStart = r.pos
  r.need(resourcesLength)
  const resources = readResources(bytes, resStart, resStart + resourcesLength)
  r.seek(resStart + resourcesLength)

  // Layer and mask information.
  let layers: LayerRecord[] = []
  let mergedAlpha = false
  let layerError: unknown = null
  const lmLength = psb ? r.u64() : r.u32()
  const lmStart = r.pos
  const lmEnd = Math.min(bytes.length, lmStart + lmLength)
  try {
    if (lmLength > 0) {
      const infoLength = psb ? r.u64() : r.u32()
      const infoStart = r.pos
      if (infoLength > 0) {
        const parsed = readLayerInfo(bytes, infoStart, Math.min(lmEnd, infoStart + infoLength), psb)
        layers = parsed.layers
        mergedAlpha = parsed.mergedAlpha
      }
      // 16- and 32-bit documents keep their layers in a tagged block after the global mask.
      if (!layers.length) {
        r.seek(infoStart + infoLength)
        const maskLength = r.u32()
        r.skip(maskLength)
        while (r.pos + 12 <= lmEnd) {
          const sig = r.ascii(4)
          if (sig !== '8BIM' && sig !== '8B64') break
          const key = r.ascii(4)
          const size = psb && LONG_KEYS.has(key) ? r.u64() : r.u32()
          const start = r.pos
          if ((key === 'Lr16' || key === 'Lr32' || key === 'Layr') && size > 0) {
            const parsed = readLayerInfo(bytes, start, Math.min(lmEnd, start + size), psb)
            layers = parsed.layers
            mergedAlpha = parsed.mergedAlpha
            break
          }
          r.seek(nextBlock(bytes, start + size, lmEnd))
        }
      }
    }
  } catch (error) {
    layerError = error
    layers = []
  }
  const imageDataAt = lmStart + lmLength
  const hasImageData = imageDataAt + 2 <= bytes.length

  // Layers in panel order (top first), with group depth.
  const ordered = layers.slice().reverse()
  const descs: LayerDesc[] = []
  const records: LayerRecord[] = []
  const parents: number[] = []
  let depth = 0
  const stack: number[] = []
  const images: ImageDesc[] = [{ id: 0, width: header.width, height: header.height, at: [], label: 'Composite', info: [] }]
  const layerImage = new Map<number, LayerRecord>()
  for (const rec of ordered) {
    if (rec.section === 3) {
      depth = Math.max(0, depth - 1)
      stack.pop()
      continue
    }
    const w = rec.right - rec.left
    const h = rec.bottom - rec.top
    const hasPixels = w > 0 && h > 0 && rec.kind !== 'group' && rec.channels.some((c) => c.id >= -1 && c.length > 2)
    const kind: LayerDesc['kind'] = rec.kind === 'pixel' && !hasPixels ? 'empty' : rec.kind
    let image = -1
    if (hasPixels) {
      image = images.length
      // A layer's name is the file's text; only the stand-in for a nameless layer is translated.
      const named = rec.name ? joinLabel([{ text: rec.name, file: true }]) : { label: `Layer ${rec.index + 1}`, fileText: [] }
      images.push({ id: image, width: w, height: h, at: [], ...named, info: [] })
      layerImage.set(image, rec)
    }
    const id = descs.length
    descs.push({
      id,
      name: rec.name,
      visible: !rec.hidden,
      opacity: rec.opacity,
      blend: BLEND_NAMES[rec.blend] ?? rec.blend.trim(),
      kind,
      depth,
      left: rec.left,
      top: rec.top,
      width: Math.max(0, w),
      height: Math.max(0, h),
      clipping: rec.clipping,
      image
    })
    records.push(rec)
    parents.push(stack.length ? stack[stack.length - 1] : -1)
    if (rec.kind === 'group') {
      stack.push(id)
      depth++
    }
  }

  // The flattened image's transparency channel: Photoshop flags it with a negative layer count or
  // with alpha identifier 0; other writers save a flat document with one more channel, unnamed or
  // named "Transparency". Other named channels are spot or saved-selection channels.
  const colourTotal = colourIds(header.mode).length
  const channelNames = resources.alphaNames.length ? resources.alphaNames : resources.pascalAlphaNames
  const transparencyId = resources.alphaIds.indexOf(0)
  let transparencyAt = -1
  if (header.channels > colourTotal) {
    if (mergedAlpha) transparencyAt = colourTotal
    else if (transparencyId >= 0 && resources.alphaIds.length <= header.channels - colourTotal) transparencyAt = header.channels - resources.alphaIds.length + transparencyId
    else if (!descs.length && header.mode !== 2 && (!channelNames.length || channelNames[0] === 'Transparency')) transparencyAt = colourTotal
  }
  // Photoshop and GIMP store a transparent RGB or grey flattened image composited over white;
  // macOS sips stores the colour as it is. Photoshop's marks (alpha identifier 0, a "Transparency"
  // name in resource 1045) settle it at once; without them the pixels decide (looksMatted).
  const mattable = transparencyAt >= 0 && (header.mode === 1 || header.mode === 3)
  const marked = transparencyId >= 0 || resources.alphaNames.includes('Transparency')
  const notices: Notice[] = []
  const noComposite = resources.realMerged === false && descs.length > 0
  if (noComposite) notices.push({ code: 'psd-no-composite' })
  if (layerError && !descs.length) notices.push({ code: 'damaged-partial' })

  // ------------------------------------------------ decoding

  async function decodeComposite(): Promise<Raster> {
    if (!hasImageData) throw damaged('PSD image data')
    const { width, height, depth: d } = header
    const bpp = d === 1 ? 1 : bytesOf(d)
    checkSize(width, height, Math.max(header.channels, 4) * bpp)
    const rowBytes = d === 1 ? Math.ceil(width / 8) : width * bytesOf(d)
    const compression = (bytes[imageDataAt] << 8) | bytes[imageDataAt + 1]
    const data = bytes.subarray(imageDataAt + 2)
    const colourCount = colourIds(header.mode).length
    const wanted = Math.min(header.channels, transparencyAt >= 0 ? transparencyAt + 1 : colourCount)
    const planes: Samples[] = []
    let complete = true
    if (compression === 1) {
      const countBytes = psb ? 4 : 2
      const counts = header.channels * height
      let pos = counts * countBytes
      if (pos > data.length) throw damaged('PSD image data')
      for (let c = 0; c < header.channels; c++) {
        const plane = new Uint8Array(rowBytes * height)
        for (let y = 0; y < height; y++) {
          const at = (c * height + y) * countBytes
          const n = psb ? ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0 : (data[at] << 8) | data[at + 1]
          if (c < wanted) {
            if (pos >= data.length) {
              complete = false
            } else {
              const row = packbitsDecode(data, rowBytes, pos, Math.min(data.length, pos + n))
              plane.set(row.out, y * rowBytes)
              if (!row.complete) complete = false
            }
          }
          pos += n
        }
        if (c < wanted) planes.push(samplesOf(plane, width, height, d))
        else break
      }
    } else if (compression === 0) {
      const size = rowBytes * height
      for (let c = 0; c < wanted; c++) {
        const plane = new Uint8Array(size)
        const part = data.subarray(c * size, (c + 1) * size)
        plane.set(part)
        if (part.length < size) complete = false
        planes.push(samplesOf(plane, width, height, d))
      }
    } else if (compression === 2 || compression === 3) {
      const size = rowBytes * height
      const all = await platform.inflate(data, 'deflate', size * header.channels)
      for (let c = 0; c < wanted; c++) {
        const plane = all.slice(c * size, (c + 1) * size)
        if (compression === 3) {
          if (d === 32) undoFloatingPoint(plane, height, rowBytes, width, 1, 32)
          else undoHorizontal(plane, height, rowBytes, width, 1, d === 16 ? 16 : 8, false)
        }
        planes.push(samplesOf(plane, width, height, d))
      }
    } else {
      throw new ImageError('unsupported-compression', `PSD compression ${compression}`)
    }
    const colour = planes.slice(0, colourCount)
    const alpha = transparencyAt >= 0 && planes.length > transparencyAt ? planes[transparencyAt] : null
    const top = d === 32 ? 1 : d === 16 ? 65535 : 255
    if (alpha && mattable && (marked || looksMatted(colour, alpha, top))) unmatte(colour, alpha, top)
    const local: Notice[] = []
    const out = toRaster(header, width, height, colour, alpha, palette, local)
    if (!complete) out.partial = true
    if (local.length) out.notices = local
    return out
  }

  async function layerPlanes(rec: LayerRecord): Promise<{ colour: Samples[]; alpha: Samples | null; mask: { data: Samples; rect: Mask } | null; complete: boolean }> {
    const w = rec.right - rec.left
    const h = rec.bottom - rec.top
    checkSize(w, h, (colourIds(header.mode).length + 2) * bytesOf(header.depth))
    const depthBits = header.depth === 1 ? 8 : header.depth
    const ids = colourIds(header.mode)
    const colour: Samples[] = []
    let alpha: Samples | null = null
    let mask: { data: Samples; rect: Mask } | null = null
    let complete = true
    for (const id of ids) {
      const ch = rec.channels.find((c) => c.id === id)
      if (!ch) {
        colour.push(allocate(kindOf(depthBits), w * h))
        continue
      }
      const { plane, complete: ok } = await readPlane(bytes, ch.at, ch.length, w, h, header.depth, psb, platform)
      if (!ok) complete = false
      colour.push(samplesOf(plane, w, h, header.depth))
    }
    const a = rec.channels.find((c) => c.id === -1)
    if (a) {
      const { plane, complete: ok } = await readPlane(bytes, a.at, a.length, w, h, header.depth, psb, platform)
      if (!ok) complete = false
      alpha = samplesOf(plane, w, h, header.depth)
    }
    const m = rec.channels.find((c) => c.id === -2)
    if (m && rec.mask && !rec.mask.disabled) {
      const mw = rec.mask.right - rec.mask.left
      const mh = rec.mask.bottom - rec.mask.top
      if (mw > 0 && mh > 0 && mw * mh <= MAX_RASTER_BYTES) {
        try {
          const { plane } = await readPlane(bytes, m.at, m.length, mw, mh, header.depth, psb, platform)
          mask = { data: samplesOf(plane, mw, mh, header.depth), rect: rec.mask }
        } catch {
          // A broken mask: the layer shows unmasked.
        }
      }
    }
    return { colour, alpha, mask, complete }
  }

  async function decodeLayer(rec: LayerRecord): Promise<Raster> {
    const w = rec.right - rec.left
    const h = rec.bottom - rec.top
    const { colour, alpha, complete } = await layerPlanes(rec)
    const out = toRaster(header, w, h, colour, alpha, palette, [])
    if (!complete) out.partial = true
    return out
  }

  /** A straight-alpha composite of the visible pixel layers, bottom to top. */
  async function composite(visible: readonly boolean[]): Promise<Raster> {
    const { width: W, height: H } = header
    checkSize(W, H, 16)
    const n = W * H
    const acc = new Float32Array(n * 4)
    const top = header.depth === 32 ? 1 : header.depth === 16 ? 65535 : 255
    let baseAlpha: Float32Array | null = null
    let baseRect = { left: 0, top: 0, w: 0, h: 0 }
    const shown = (id: number): boolean => {
      for (let p = id; p >= 0; p = parents[p]) if (!(visible[p] ?? descs[p].visible)) return false
      return true
    }
    const groupOpacity = (id: number): number => {
      let o = 1
      for (let p = parents[id]; p >= 0; p = parents[p]) o *= records[p].opacity
      return o
    }
    const b = [0, 0, 0]
    const s = [0, 0, 0]
    // A layer that cannot be read, or is cut off, makes the composite partial.
    let partial = false
    // Bottom to top: the reverse of panel order.
    for (let id = descs.length - 1; id >= 0; id--) {
      const desc = descs[id]
      const rec = records[id]
      if (desc.kind === 'group') continue
      if (!rec.clipping) baseAlpha = null
      if (desc.image < 0 || !shown(id)) {
        if (!rec.clipping) baseRect = { left: 0, top: 0, w: 0, h: 0 }
        continue
      }
      let planes: Awaited<ReturnType<typeof layerPlanes>>
      try {
        planes = await layerPlanes(rec)
      } catch (error) {
        if (error instanceof ImageError && error.code === 'too-large') throw error
        partial = true
        continue
      }
      if (!planes.complete) partial = true
      const lw = rec.right - rec.left
      const lh = rec.bottom - rec.top
      const layer = toRaster(header, lw, lh, planes.colour, planes.alpha, palette, [])
      const c = layer.channels
      const grey = layer.color === 'gray'
      const scale = layer.kind === 'f32' ? 1 : 1 / top
      const opacity = rec.opacity * rec.fillOpacity * groupOpacity(id)
      const fn = SEPARABLE[rec.blend]
      const mask = planes.mask
      const thisAlpha = rec.clipping ? null : new Float32Array(lw * lh)
      for (let y = 0; y < lh; y++) {
        const dy = rec.top + y
        if (dy < 0 || dy >= H) continue
        for (let x = 0; x < lw; x++) {
          const dx = rec.left + x
          if (dx < 0 || dx >= W) continue
          const si = (y * lw + x) * c
          let a = layer.alpha ? layer.data[si + c - 1] * scale : 1
          if (mask) {
            const mx = dx - mask.rect.left
            const my = dy - mask.rect.top
            const mw = mask.rect.right - mask.rect.left
            const mh = mask.rect.bottom - mask.rect.top
            const mv = mx >= 0 && my >= 0 && mx < mw && my < mh ? mask.data[my * mw + mx] * scale : mask.rect.defaultColor / 255
            a *= mv
          }
          if (thisAlpha) thisAlpha[y * lw + x] = a
          if (rec.clipping) {
            if (!baseAlpha) continue
            const bx = dx - baseRect.left
            const by = dy - baseRect.top
            a *= bx >= 0 && by >= 0 && bx < baseRect.w && by < baseRect.h ? baseAlpha[by * baseRect.w + bx] : 0
          }
          a *= opacity
          if (a <= 0) continue
          for (let k = 0; k < 3; k++) {
            const v = layer.data[si + (grey ? 0 : k)] * scale
            s[k] = layer.kind === 'f32' ? v : clamp(v)
          }
          const di = (dy * W + dx) * 4
          const ab = acc[di + 3]
          for (let k = 0; k < 3; k++) b[k] = ab > 0 ? acc[di + k] / ab : 0
          let mixed: number[]
          if (fn) {
            mixed = [fn(b[0], s[0]), fn(b[1], s[1]), fn(b[2], s[2])]
          } else {
            mixed = blendColour(rec.blend, b.slice(), s.slice())
          }
          for (let k = 0; k < 3; k++) {
            const cs = (1 - ab) * s[k] + ab * mixed[k]
            acc[di + k] = a * cs + (1 - a) * acc[di + k]
          }
          acc[di + 3] = a + ab * (1 - a)
        }
      }
      if (thisAlpha) {
        baseAlpha = thisAlpha
        baseRect = { left: rec.left, top: rec.top, w: lw, h: lh }
      }
    }
    const kind = kindOf(header.depth === 1 ? 8 : header.depth)
    const grey = header.mode === 0 || header.mode === 1 || header.mode === 7 || header.mode === 8
    const c = grey ? 2 : 4
    const out = allocate(kind, n * c)
    for (let i = 0; i < n; i++) {
      const a = acc[i * 4 + 3]
      const d = i * c
      for (let k = 0; k < c - 1; k++) {
        const v = a > 0 ? acc[i * 4 + k] / a : 0
        out[d + k] = kind === 'f32' ? v : Math.round(clamp(v) * top)
      }
      out[d + c - 1] = kind === 'f32' ? a : Math.round(clamp(a) * top)
    }
    return raster(W, H, c, kind, out, { color: grey ? 'gray' : 'rgb', alpha: true, transfer: header.depth === 32 ? 'linear' : 'srgb', ...(partial ? { partial } : {}) })
  }

  // ------------------------------------------------ info

  const imageItems: InfoItem[] = [
    { key: 'dimensions', value: `${header.width} × ${header.height}` },
    { key: 'colorMode', value: MODE_NAMES[header.mode] ?? `Mode ${header.mode}` },
    { key: 'bitDepth', value: header.depth === 32 ? '32 (float)' : String(header.depth) },
    { key: 'channels', value: String(header.channels) }
  ]
  const extraChannels = header.channels - colourTotal - (transparencyAt >= 0 ? 1 : 0)
  if (extraChannels > 0) {
    const names = channelNames.filter((name, i) => name && colourTotal + i !== transparencyAt)
    imageItems.push({ key: 'alpha', value: names.length ? names.join(', ') : String(extraChannels) })
  }
  if (descs.length) {
    const groups = descs.filter((l) => l.kind === 'group').length
    const groupText = groups ? ` (${counted(groups, 'group')})` : ''
    imageItems.push({ key: 'layers', value: String(descs.length - groups) + groupText })
  }
  if (hasImageData) {
    const compression = (bytes[imageDataAt] << 8) | bytes[imageDataAt + 1]
    imageItems.push({ key: 'compression', value: ['Raw', 'RLE (PackBits)', 'ZIP', 'ZIP with prediction'][compression] ?? String(compression) })
  }
  imageItems.push({ key: 'composite', value: !hasImageData ? 'Missing, the file is cut off (composited from layers)' : noComposite ? 'Not saved (composited from layers)' : 'Yes' })
  if (resources.resolution) {
    const { h, v, unit } = resources.resolution
    const name = unit === 2 ? 'px/cm' : 'ppi'
    imageItems.push({ key: 'resolution', value: `${Math.round(h * 100) / 100}${Math.abs(v - h) > 0.01 ? ` × ${Math.round(v * 100) / 100}` : ''} ${name}` })
    if (h > 0 && v > 0) {
      const u = unit === 2 ? 'cm' : 'in'
      imageItems.push({ key: 'printSize', value: `${(header.width / h).toFixed(2)} × ${(header.height / v).toFixed(2)} ${u}` })
    }
  }
  if (resources.icc) imageItems.push(...iccItems(readIcc(resources.icc)))
  const fileItems: InfoItem[] = [{ key: 'version', value: psb ? 'PSB (large document)' : 'PSD' }]
  if (resources.writer) fileItems.push({ key: 'software', value: resources.writer })
  if (resources.guides) fileItems.push({ key: 'guides', value: String(resources.guides) })
  const sections: InfoSection[] = [{ title: 'image', items: imageItems }, { title: 'file', items: fileItems }]
  if (resources.exif) {
    const exif = exifFromBlock(resources.exif)
    if (exif) sections.push(...exif.sections)
  }
  if (resources.xmp) {
    const x = xmpSection(text(resources.xmp))
    if (x) sections.push(x)
  }
  for (const d of descs) {
    if (d.image >= 0) images[d.image].info = [{ key: 'blend', value: d.blend }, { key: 'opacity', value: `${Math.round(d.opacity * 100)}%` }, { key: 'bounds', value: `${d.width} × ${d.height} @ ${d.left}, ${d.top}` }]
  }

  const savedVisible = descs.map((d) => d.visible)
  return {
    desc: {
      format: psb ? 'PSB' : 'PSD',
      images,
      axes: [],
      primary: 0,
      layers: descs.length ? descs : undefined,
      info: sections,
      notices
    },
    async decode(id) {
      if (id === 0) {
        if (noComposite || !hasImageData) {
          if (!descs.length) throw damaged('PSD image data')
          return composite(savedVisible)
        }
        return decodeComposite()
      }
      const rec = layerImage.get(id)
      if (!rec) throw damaged('PSD layer')
      return decodeLayer(rec)
    },
    composite: descs.length ? (visible) => composite(visible) : undefined
  }
}
