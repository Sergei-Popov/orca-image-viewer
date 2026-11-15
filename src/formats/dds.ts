// DirectDraw Surface: legacy and DX10 headers; BC1–BC7 and common uncompressed formats; mip levels,
// cube faces, texture arrays and volume slices.

import { type BcFormat, bcChannels, bcDataSize, decodeBc } from '../codecs/bc'
import { fourcc } from '../core/bytes'
import { checkSize, damaged, unsupportedPixels } from '../core/errors'
import { halfTable } from '../core/half'
import type { Axis, Decoded, ImageDesc, InfoItem, Raster, SampleKind, Transfer } from '../core/model'
import { raster } from '../core/model'
import { valueRange } from '../core/pixels'

const DDSD_MIPMAPCOUNT = 0x20000
const DDSCAPS2_CUBEMAP = 0x200
const DDSCAPS2_VOLUME = 0x200000
const DDPF_ALPHAPIXELS = 0x1
const DDPF_ALPHA = 0x2
const DDPF_FOURCC = 0x4
const DDPF_RGB = 0x40
const DDPF_YUV = 0x200
const DDPF_LUMINANCE = 0x20000
const DDPF_BUMPDUDV = 0x80000
const FACE_NAMES = ['+X', '−X', '+Y', '−Y', '+Z', '−Z']
/** More surfaces than this (array layers × faces × mip levels and slices) is a damaged header. */
const MAX_IMAGES = 8192

/** How to read one surface. */
type Layout =
  | { kind: 'bc'; bc: BcFormat; name: string; srgb?: boolean }
  | { kind: 'dxgi'; dxgi: number; name: string; bits: number }
  | { kind: 'masks'; name: string; bits: number; masks: [number, number, number, number]; grey: boolean; alpha: boolean }

const DXGI_NAMES: Record<number, string> = {
  1: 'R32G32B32A32_TYPELESS',
  2: 'R32G32B32A32_FLOAT',
  6: 'R32G32B32_FLOAT',
  9: 'R16G16B16A16_TYPELESS',
  10: 'R16G16B16A16_FLOAT',
  11: 'R16G16B16A16_UNORM',
  16: 'R32G32_FLOAT',
  23: 'R10G10B10A2_TYPELESS',
  24: 'R10G10B10A2_UNORM',
  26: 'R11G11B10_FLOAT',
  27: 'R8G8B8A8_TYPELESS',
  28: 'R8G8B8A8_UNORM',
  29: 'R8G8B8A8_UNORM_SRGB',
  30: 'R8G8B8A8_UINT',
  31: 'R8G8B8A8_SNORM',
  34: 'R16G16_FLOAT',
  35: 'R16G16_UNORM',
  41: 'R32_FLOAT',
  49: 'R8G8_UNORM',
  54: 'R16_FLOAT',
  56: 'R16_UNORM',
  61: 'R8_UNORM',
  65: 'A8_UNORM',
  67: 'R9G9B9E5_SHAREDEXP',
  70: 'BC1_TYPELESS',
  71: 'BC1_UNORM',
  72: 'BC1_UNORM_SRGB',
  73: 'BC2_TYPELESS',
  74: 'BC2_UNORM',
  75: 'BC2_UNORM_SRGB',
  76: 'BC3_TYPELESS',
  77: 'BC3_UNORM',
  78: 'BC3_UNORM_SRGB',
  79: 'BC4_TYPELESS',
  80: 'BC4_UNORM',
  81: 'BC4_SNORM',
  82: 'BC5_TYPELESS',
  83: 'BC5_UNORM',
  84: 'BC5_SNORM',
  85: 'B5G6R5_UNORM',
  86: 'B5G5R5A1_UNORM',
  87: 'B8G8R8A8_UNORM',
  88: 'B8G8R8X8_UNORM',
  90: 'B8G8R8A8_TYPELESS',
  91: 'B8G8R8A8_UNORM_SRGB',
  92: 'B8G8R8X8_TYPELESS',
  93: 'B8G8R8X8_UNORM_SRGB',
  94: 'BC6H_TYPELESS',
  95: 'BC6H_UF16',
  96: 'BC6H_SF16',
  97: 'BC7_TYPELESS',
  98: 'BC7_UNORM',
  99: 'BC7_UNORM_SRGB',
  115: 'B4G4R4A4_UNORM'
}

const DXGI_BC: Record<number, BcFormat> = {
  70: 'bc1',
  71: 'bc1',
  72: 'bc1',
  73: 'bc2',
  74: 'bc2',
  75: 'bc2',
  76: 'bc3',
  77: 'bc3',
  78: 'bc3',
  79: 'bc4',
  80: 'bc4',
  81: 'bc4s',
  82: 'bc5',
  83: 'bc5',
  84: 'bc5s',
  94: 'bc6h',
  95: 'bc6h',
  96: 'bc6hs',
  97: 'bc7',
  98: 'bc7',
  99: 'bc7'
}

/** Bits per pixel of the uncompressed DXGI formats read here. */
const DXGI_BITS: Record<number, number> = {
  1: 128,
  2: 128,
  6: 96,
  9: 64,
  10: 64,
  11: 64,
  16: 64,
  23: 32,
  24: 32,
  26: 32,
  27: 32,
  28: 32,
  29: 32,
  30: 32,
  31: 32,
  34: 32,
  35: 32,
  41: 32,
  49: 16,
  54: 16,
  56: 16,
  61: 8,
  65: 8,
  67: 32,
  85: 16,
  86: 16,
  87: 32,
  88: 32,
  90: 32,
  91: 32,
  92: 32,
  93: 32,
  115: 16
}

/** Legacy FourCC codes: block formats and the D3DFORMAT numbers of float and 16-bit formats. */
function legacyFourcc(code: string, value: number): Layout | null {
  const bc: Record<string, [BcFormat, string]> = {
    DXT1: ['bc1', 'DXT1 (BC1)'],
    DXT2: ['bc2', 'DXT2 (BC2, premultiplied)'],
    DXT3: ['bc2', 'DXT3 (BC2)'],
    DXT4: ['bc3', 'DXT4 (BC3, premultiplied)'],
    DXT5: ['bc3', 'DXT5 (BC3)'],
    ATI1: ['bc4', 'ATI1 (BC4)'],
    BC4U: ['bc4', 'BC4U'],
    BC4S: ['bc4s', 'BC4S'],
    ATI2: ['bc5', 'ATI2 (BC5)'],
    BC5U: ['bc5', 'BC5U'],
    BC5S: ['bc5s', 'BC5S']
  }
  const hit = bc[code]
  if (hit) return { kind: 'bc', bc: hit[0], name: hit[1] }
  const d3d: Record<number, number> = { 36: 11, 111: 54, 112: 34, 113: 10, 114: 41, 115: 16, 116: 2 }
  const dxgi = d3d[value]
  if (dxgi) return { kind: 'dxgi', dxgi, name: DXGI_NAMES[dxgi], bits: DXGI_BITS[dxgi] }
  return null
}

function maskName(bits: number, masks: number[], grey: boolean): string {
  const parts: string[] = []
  const names = grey ? ['L', '', '', 'A'] : ['R', 'G', 'B', 'A']
  const order = masks
    .map((m, i) => ({ m, i }))
    .filter((e) => e.m && names[e.i])
    .sort((a, b) => (b.m >>> 0) - (a.m >>> 0))
  for (const e of order) parts.push(`${names[e.i]}${popcount(e.m)}`)
  if (!parts.length) return `${bits}-bit`
  const used = order.reduce((s, e) => s + popcount(e.m), 0)
  return parts.join('') + (used < bits ? `X${bits - used}` : '')
}

function popcount(v: number): number {
  let n = 0
  for (let x = v >>> 0; x; x >>>= 1) n += x & 1
  return n
}

function shiftOf(mask: number): number {
  let s = 0
  while (s < 32 && !((mask >>> s) & 1)) s++
  return s
}

function rowBytes(layout: Layout, width: number): number {
  if (layout.kind === 'bc') return 0
  return Math.ceil((width * layout.bits) / 8)
}

function surfaceSize(layout: Layout, width: number, height: number, padRows: boolean): number {
  if (layout.kind === 'bc') return bcDataSize(layout.bc, width, height)
  const row = rowBytes(layout, width)
  return (padRows ? (row + 3) & ~3 : row) * height
}

/** Small float formats (R11G11B10, R9G9B9E5). */
function smallFloat(v: number, mantissaBits: number): number {
  const m = v & ((1 << mantissaBits) - 1)
  const e = v >>> mantissaBits
  if (e === 0) return (m / (1 << mantissaBits)) * 2 ** -14
  if (e === 31) return m ? NaN : Infinity
  return (1 + m / (1 << mantissaBits)) * 2 ** (e - 15)
}

function decodeUncompressed(layout: Exclude<Layout, { kind: 'bc' }>, src: Uint8Array, at: number, w: number, h: number, padRows: boolean): Raster {
  const row = rowBytes(layout, w)
  const stride = padRows ? (row + 3) & ~3 : row
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const px = (x: number, y: number) => at + y * stride + (x * layout.bits) / 8

  if (layout.kind === 'masks') {
    const [rm, gm, bm, am] = layout.masks
    const wide = [rm, gm, bm, am].some((m) => popcount(m) > 8)
    const colour = layout.grey ? [rm] : [rm, gm, bm]
    const masks = layout.alpha && am ? [...colour, am] : colour
    const c = masks.length
    const kind: SampleKind = wide ? 'u16' : 'u8'
    const top = wide ? 65535 : 255
    checkSize(w, h, c * (wide ? 2 : 1))
    const out = wide ? new Uint16Array(w * h * c) : new Uint8Array(w * h * c)
    const shifts = masks.map(shiftOf)
    const maxes = masks.map((m, k) => (m >>> shifts[k]) || 1)
    const bytes = layout.bits / 8
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = at + y * stride + x * bytes
        let v = 0
        for (let k = bytes - 1; k >= 0; k--) v = v * 256 + src[p + k]
        for (let k = 0; k < c; k++) {
          const m = masks[k]
          const value = m ? ((v >>> shifts[k]) & (m >>> shifts[k])) : 0
          out[(y * w + x) * c + k] = Math.round((value * top) / maxes[k])
        }
      }
    }
    return raster(w, h, c, kind, out, {
      color: layout.grey ? 'gray' : 'rgb',
      alpha: layout.alpha && !!am,
      names: [...(layout.grey ? ['L'] : ['R', 'G', 'B']), ...(layout.alpha && am ? ['A'] : [])]
    })
  }

  const d = layout.dxgi
  const n = w * h
  const f32 = (c: number, transfer: Transfer, alpha: boolean, names: string[], read: (x: number, y: number, out: Float32Array, o: number) => void): Raster => {
    checkSize(w, h, c * 4)
    const out = new Float32Array(n * c)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) read(x, y, out, (y * w + x) * c)
    const r = raster(w, h, c, 'f32', out, { color: c >= 3 ? 'rgb' : 'gray', alpha, transfer, names })
    if (transfer === 'data') r.range = valueRange(r)
    return r
  }
  const ints = (kind: 'u8' | 'u16', c: number, alpha: boolean, names: string[], read: (x: number, y: number, out: Uint8Array | Uint16Array, o: number) => void, bits?: number): Raster => {
    checkSize(w, h, c * (kind === 'u16' ? 2 : 1))
    const out = kind === 'u16' ? new Uint16Array(n * c) : new Uint8Array(n * c)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) read(x, y, out, (y * w + x) * c)
    return raster(w, h, c, kind, out, { color: c >= 3 ? 'rgb' : 'gray', alpha, names, bits })
  }
  const half = halfTable()
  const h16 = (p: number) => half[view.getUint16(p, true)]
  switch (d) {
    case 1:
    case 2:
      return f32(4, 'linear', true, ['R', 'G', 'B', 'A'], (x, y, o, i) => {
        for (let k = 0; k < 4; k++) o[i + k] = view.getFloat32(px(x, y) + 4 * k, true)
      })
    case 6:
      return f32(3, 'linear', false, ['R', 'G', 'B'], (x, y, o, i) => {
        for (let k = 0; k < 3; k++) o[i + k] = view.getFloat32(px(x, y) + 4 * k, true)
      })
    case 9:
    case 10: {
      checkSize(w, h, 8)
      const out = new Uint16Array(n * 4)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = view.getUint16(px(x, y) + 2 * k, true)
      return raster(w, h, 4, 'f16', out, { color: 'rgb', alpha: true, transfer: 'linear', names: ['R', 'G', 'B', 'A'] })
    }
    case 11:
      return ints('u16', 4, true, ['R', 'G', 'B', 'A'], (x, y, o, i) => {
        for (let k = 0; k < 4; k++) o[i + k] = view.getUint16(px(x, y) + 2 * k, true)
      })
    case 16:
      return f32(3, 'linear', false, ['R', 'G', '–'], (x, y, o, i) => {
        o[i] = view.getFloat32(px(x, y), true)
        o[i + 1] = view.getFloat32(px(x, y) + 4, true)
      })
    case 23:
    case 24:
      return ints(
        'u16',
        4,
        true,
        ['R', 'G', 'B', 'A'],
        (x, y, o, i) => {
          const v = view.getUint32(px(x, y), true)
          o[i] = Math.round(((v & 1023) * 65535) / 1023)
          o[i + 1] = Math.round((((v >>> 10) & 1023) * 65535) / 1023)
          o[i + 2] = Math.round((((v >>> 20) & 1023) * 65535) / 1023)
          o[i + 3] = (v >>> 30) * 21845
        },
        10
      )
    case 26:
      return f32(3, 'linear', false, ['R', 'G', 'B'], (x, y, o, i) => {
        const v = view.getUint32(px(x, y), true)
        o[i] = smallFloat(v & 2047, 6)
        o[i + 1] = smallFloat((v >>> 11) & 2047, 6)
        o[i + 2] = smallFloat(v >>> 22, 5)
      })
    case 27:
    case 28:
    case 29:
    case 30:
      return ints('u8', 4, true, ['R', 'G', 'B', 'A'], (x, y, o, i) => {
        const p = px(x, y)
        for (let k = 0; k < 4; k++) o[i + k] = src[p + k]
      })
    case 31:
      return ints('u8', 4, true, ['R', 'G', 'B', 'A'], (x, y, o, i) => {
        const p = px(x, y)
        for (let k = 0; k < 4; k++) o[i + k] = (src[p + k] + 128) & 255
      })
    case 34:
      return f32(3, 'linear', false, ['R', 'G', '–'], (x, y, o, i) => {
        o[i] = h16(px(x, y))
        o[i + 1] = h16(px(x, y) + 2)
      })
    case 35:
      return ints('u16', 3, false, ['R', 'G', '–'], (x, y, o, i) => {
        o[i] = view.getUint16(px(x, y), true)
        o[i + 1] = view.getUint16(px(x, y) + 2, true)
      })
    case 41:
      return f32(1, 'data', false, ['R'], (x, y, o, i) => {
        o[i] = view.getFloat32(px(x, y), true)
      })
    case 49:
      return ints('u8', 3, false, ['R', 'G', '–'], (x, y, o, i) => {
        o[i] = src[px(x, y)]
        o[i + 1] = src[px(x, y) + 1]
      })
    case 54:
      return f32(1, 'data', false, ['R'], (x, y, o, i) => {
        o[i] = h16(px(x, y))
      })
    case 56:
      return ints('u16', 1, false, ['R'], (x, y, o, i) => {
        o[i] = view.getUint16(px(x, y), true)
      })
    case 61:
    case 65:
      return ints('u8', 1, false, [d === 65 ? 'A' : 'R'], (x, y, o, i) => {
        o[i] = src[px(x, y)]
      })
    case 67:
      return f32(3, 'linear', false, ['R', 'G', 'B'], (x, y, o, i) => {
        const v = view.getUint32(px(x, y), true)
        const scale = 2 ** ((v >>> 27) - 15 - 9)
        o[i] = (v & 511) * scale
        o[i + 1] = ((v >>> 9) & 511) * scale
        o[i + 2] = ((v >>> 18) & 511) * scale
      })
    case 85:
      return ints('u8', 3, false, ['R', 'G', 'B'], (x, y, o, i) => {
        const v = view.getUint16(px(x, y), true)
        o[i] = Math.round(((v >>> 11) * 255) / 31)
        o[i + 1] = Math.round((((v >>> 5) & 63) * 255) / 63)
        o[i + 2] = Math.round(((v & 31) * 255) / 31)
      })
    case 86:
      return ints('u8', 4, true, ['R', 'G', 'B', 'A'], (x, y, o, i) => {
        const v = view.getUint16(px(x, y), true)
        o[i] = Math.round((((v >>> 10) & 31) * 255) / 31)
        o[i + 1] = Math.round((((v >>> 5) & 31) * 255) / 31)
        o[i + 2] = Math.round(((v & 31) * 255) / 31)
        o[i + 3] = v >>> 15 ? 255 : 0
      })
    case 87:
    case 90:
    case 91:
      return ints('u8', 4, true, ['R', 'G', 'B', 'A'], (x, y, o, i) => {
        const p = px(x, y)
        o[i] = src[p + 2]
        o[i + 1] = src[p + 1]
        o[i + 2] = src[p]
        o[i + 3] = src[p + 3]
      })
    case 88:
    case 92:
    case 93:
      return ints('u8', 3, false, ['R', 'G', 'B'], (x, y, o, i) => {
        const p = px(x, y)
        o[i] = src[p + 2]
        o[i + 1] = src[p + 1]
        o[i + 2] = src[p]
      })
    case 115:
      return ints('u8', 4, true, ['R', 'G', 'B', 'A'], (x, y, o, i) => {
        const v = view.getUint16(px(x, y), true)
        o[i] = ((v >>> 8) & 15) * 17
        o[i + 1] = ((v >>> 4) & 15) * 17
        o[i + 2] = (v & 15) * 17
        o[i + 3] = (v >>> 12) * 17
      })
  }
  throw unsupportedPixels(DXGI_NAMES[d] ?? `DXGI format ${d}`)
}

function decodeSurface(layout: Layout, src: Uint8Array, at: number, w: number, h: number, padRows: boolean): Raster {
  if (layout.kind !== 'bc') return decodeUncompressed(layout, src, at, w, h, padRows)
  const c = bcChannels(layout.bc)
  const hdr = layout.bc === 'bc6h' || layout.bc === 'bc6hs'
  checkSize(w, h, c * (hdr ? 2 : 1))
  const data = decodeBc(layout.bc, src, at, w, h)
  const names = c === 1 ? ['R'] : c === 3 ? (hdr ? ['R', 'G', 'B'] : ['R', 'G', '–']) : ['R', 'G', 'B', 'A']
  return raster(w, h, c, hdr ? 'f16' : 'u8', data, {
    color: c === 1 ? 'gray' : 'rgb',
    alpha: c === 4,
    transfer: hdr ? 'linear' : 'srgb',
    names
  })
}

export function openDds(bytes: Uint8Array): Decoded {
  if (bytes.length < 128 || fourcc(bytes, 0) !== 'DDS ') throw damaged('DDS header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (at: number) => view.getUint32(at, true)
  const flags = u32(8)
  let height = u32(12)
  const width = u32(16)
  const depthField = u32(24)
  const mipField = u32(28)
  const pfFlags = u32(80)
  const code = fourcc(bytes, 84)
  const codeValue = u32(84)
  const bitCount = u32(88)
  const masks: [number, number, number, number] = [u32(92), u32(96), u32(100), u32(104)]
  const caps2 = u32(112)
  let dataStart = 128

  let layout: Layout | null = null
  let formatName = ''
  let arraySize = 1
  let cube = false
  let volume = (caps2 & DDSCAPS2_VOLUME) !== 0 && depthField > 1
  let faces = [0]
  let alphaMode = ''
  if (pfFlags & DDPF_FOURCC && code === 'DX10') {
    if (bytes.length < 148) throw damaged('DDS DX10 header')
    const dxgi = u32(128)
    const dimension = u32(132)
    const misc = u32(136)
    arraySize = Math.max(1, u32(140))
    alphaMode = ['', 'Straight', 'Premultiplied', 'Opaque', 'Custom'][u32(144) & 7] ?? ''
    dataStart = 148
    formatName = DXGI_NAMES[dxgi] ?? `DXGI format ${dxgi}`
    if (dimension === 2) height = 1
    volume = dimension === 4
    cube = (misc & 4) !== 0
    if (cube) faces = [0, 1, 2, 3, 4, 5]
    const bc = DXGI_BC[dxgi]
    if (bc) layout = { kind: 'bc', bc, name: formatName, srgb: /SRGB/.test(formatName) }
    else if (DXGI_BITS[dxgi]) layout = { kind: 'dxgi', dxgi, name: formatName, bits: DXGI_BITS[dxgi] }
  } else if (pfFlags & DDPF_FOURCC) {
    layout = legacyFourcc(code, codeValue)
    formatName = layout?.name ?? (/^[\x20-\x7e]{4}$/.test(code) ? code : `D3DFORMAT ${codeValue}`)
  } else if (pfFlags & (DDPF_RGB | DDPF_LUMINANCE | DDPF_ALPHA | DDPF_YUV | DDPF_BUMPDUDV)) {
    const grey = (pfFlags & DDPF_LUMINANCE) !== 0
    const alphaOnly = (pfFlags & DDPF_ALPHA) !== 0 && !(pfFlags & (DDPF_RGB | DDPF_LUMINANCE))
    formatName = alphaOnly ? `A${bitCount}` : maskName(bitCount, masks, grey)
    if (pfFlags & (DDPF_YUV | DDPF_BUMPDUDV)) formatName = `${pfFlags & DDPF_YUV ? 'YUV' : 'Bump map'} ${bitCount}-bit`
    else if ([8, 16, 24, 32].includes(bitCount)) {
      // Some writers put masks outside the pixel (0xff000000 in an 8-bit one): use the usual layout.
      const limit = bitCount === 32 ? 0xffffffff : 2 ** bitCount - 1
      const fixed = masks.map((m) => (m >>> 0 <= limit ? m : 0)) as [number, number, number, number]
      const alpha = (pfFlags & DDPF_ALPHAPIXELS) !== 0
      if (grey && !fixed[0]) fixed[0] = bitCount === 16 && alpha ? 0xff : limit
      if (alpha && !fixed[3] && bitCount === 16 && grey) fixed[3] = 0xff00
      if (alphaOnly && !fixed[3]) fixed[3] = limit
      layout = alphaOnly
        ? { kind: 'masks', name: formatName, bits: bitCount, masks: [fixed[3], 0, 0, 0], grey: true, alpha: false }
        : { kind: 'masks', name: formatName, bits: bitCount, masks: fixed, grey, alpha }
    }
  }
  if (!layout) formatName ||= 'unknown'
  if (!(pfFlags & DDPF_FOURCC && code === 'DX10') && caps2 & DDSCAPS2_CUBEMAP) {
    cube = true
    faces = [0, 1, 2, 3, 4, 5].filter((f) => caps2 & (0x400 << f))
    if (!faces.length) faces = [0, 1, 2, 3, 4, 5]
  }
  if (!width || !height) throw damaged('DDS size')
  checkSize(width, height, 1)

  let mips = mipField > 0 && (flags & DDSD_MIPMAPCOUNT || mipField > 1) ? mipField : 1
  const maxMips = Math.floor(Math.log2(Math.max(width, height, volume ? depthField : 1))) + 1
  mips = Math.min(mips, maxMips)
  const depth = volume ? Math.max(1, depthField) : 1
  const sizeAt = (l: number) => ({ w: Math.max(1, width >> l), h: Math.max(1, height >> l), d: Math.max(1, depth >> l) })

  // The array size and depth come straight from the header: count the surfaces before building
  // anything for them. Each takes at least one byte (a block for BC) of what follows the header.
  if (bytes.length <= dataStart) throw damaged('DDS data')
  let slices = 0
  for (let l = 0; l < mips; l++) slices += sizeAt(l).d
  const surfaceCount = arraySize * faces.length * slices
  const minBytes = layout?.kind === 'bc' ? 8 : 1
  if (surfaceCount > MAX_IMAGES || surfaceCount * minBytes > bytes.length - dataStart) throw damaged('DDS image count')

  // Surfaces in file order: per array element and face, every mip (and slice) in turn.
  const total = (pad: boolean) => {
    if (!layout) return 0
    let n = 0
    for (let l = 0; l < mips; l++) {
      const s = sizeAt(l)
      n += surfaceSize(layout, s.w, s.h, pad) * s.d
    }
    return n * faces.length * arraySize
  }
  // Old writers pad rows of uncompressed data to 4 bytes; pick that only when the size says so.
  const padRows = !!layout && layout.kind !== 'bc' && dataStart + total(false) > bytes.length && dataStart + total(true) <= bytes.length

  interface Surface {
    offset: number
    w: number
    h: number
  }
  const surfaces: Surface[] = []
  const images: ImageDesc[] = []
  const axes: Axis[] = []
  if (arraySize > 1) axes.push({ key: 'layer', labels: Array.from({ length: arraySize }, (_, i) => `${i}`) })
  if (cube) axes.push({ key: 'face', labels: faces.map((f) => FACE_NAMES[f]) })
  if (mips > 1) axes.push({ key: 'mip', labels: Array.from({ length: mips }, (_, l) => `${l} · ${sizeAt(l).w}×${sizeAt(l).h}`) })
  if (volume) axes.push({ key: 'slice', labels: Array.from({ length: depth }, (_, z) => `${z}`) })
  let offset = dataStart
  for (let a = 0; a < arraySize; a++) {
    for (const [fi, face] of faces.entries()) {
      for (let l = 0; l < mips; l++) {
        const s = sizeAt(l)
        const size = layout ? surfaceSize(layout, s.w, s.h, padRows) : 0
        for (let z = 0; z < s.d; z++) {
          const at: number[] = []
          if (arraySize > 1) at.push(a)
          if (cube) at.push(fi)
          if (mips > 1) at.push(l)
          if (volume) at.push(z)
          const parts: string[] = []
          if (arraySize > 1) parts.push(`Layer ${a}`)
          if (cube) parts.push(FACE_NAMES[face])
          if (mips > 1) parts.push(`Mip ${l}`)
          if (volume) parts.push(`Slice ${z}`)
          parts.push(`${s.w}×${s.h}`)
          const id = images.length
          surfaces.push({ offset, w: s.w, h: s.h })
          images.push({
            id,
            width: s.w,
            height: s.h,
            at,
            label: parts.join(' · '),
            unsupported: layout ? undefined : formatName,
            info: [{ key: 'dimensions', value: `${s.w} × ${s.h}` }]
          })
          offset += size
        }
      }
    }
  }
  if (bytes.length <= dataStart) throw damaged('DDS data')

  const imageItems: InfoItem[] = [
    { key: 'dimensions', value: `${width} × ${height}${volume ? ` × ${depth}` : ''}` },
    { key: 'format', value: formatName },
    { key: 'mipmaps', value: String(mips) }
  ]
  if (cube) imageItems.push({ key: 'faces', value: faces.map((f) => FACE_NAMES[f]).join(' ') })
  if (arraySize > 1) imageItems.push({ key: 'arraySize', value: String(arraySize) })
  if (volume) imageItems.push({ key: 'depth', value: String(depth) })
  if (alphaMode) imageItems.push({ key: 'alphaMode', value: alphaMode })
  if (layout?.kind === 'bc' && layout.srgb) imageItems.push({ key: 'colorSpace', value: 'sRGB' })
  const fileItems: InfoItem[] = [{ key: 'header', value: dataStart === 148 ? 'DX10' : 'Legacy' }]
  if (padRows) fileItems.push({ key: 'rowAlignment', value: '4' })

  return {
    desc: {
      format: 'DDS',
      images,
      axes,
      primary: 0,
      // Faces or array layers in the side pane (at the chosen mip level), else the mip levels.
      list: cube ? 'face' : arraySize > 1 ? 'layer' : mips > 1 ? 'mip' : undefined,
      info: [
        { title: 'image', items: imageItems },
        { title: 'file', items: fileItems }
      ],
      notices: []
    },
    async decode(id) {
      const s = surfaces[id]
      if (!s) throw damaged('DDS image')
      if (!layout) throw unsupportedPixels(formatName)
      const need = surfaceSize(layout, s.w, s.h, padRows)
      if (s.offset + need > bytes.length) {
        // Cut off: decode what is there; blocks and rows past the end stay blank.
        if (s.offset >= bytes.length) throw damaged('DDS data')
        const padded = new Uint8Array(need)
        padded.set(bytes.subarray(s.offset))
        const r = decodeSurface(layout, padded, 0, s.w, s.h, padRows)
        r.partial = true
        return r
      }
      return decodeSurface(layout, bytes, s.offset, s.w, s.h, padRows)
    }
  }
}

