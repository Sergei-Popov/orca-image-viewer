// TIFF and BigTIFF: every page and sub-image, strips or tiles, chunky or planar, 1- to 32-bit
// integers, 16-, 24-, 32- and 64-bit floats; grey, RGB, palette, CMYK, YCbCr and CIELAB; no
// compression, LZW, Deflate, PackBits, JPEG (with shared tables) and WebP, predictors 2 and 3.
// DNG previews and other TIFF-structured RAW images come through here too.

import { lzwDecode } from '../codecs/lzw'
import { packbitsDecode } from '../codecs/packbits'
import { undoFloatingPoint, undoHorizontal } from '../codecs/predictor'
import { text } from '../core/bytes'
import { checkSize, damaged, ImageError, unsupportedCompression, unsupportedFeature, unsupportedPixels } from '../core/errors'
import { float24ToFloat, halfTable } from '../core/half'
import type { Decoded, ImageDesc, InfoItem, InfoSection, Notice, Platform, Raster, SampleKind, Samples } from '../core/model'
import { allocate, bytesPerSample, raster } from '../core/model'
import { cmykToRgb, dropAlpha, labToRgb, orient, valueRange } from '../core/pixels'
import { count as counted } from '../core/plural'
import { exifDirs, exifDate, exifSummary, ORIENTATION_NAMES } from '../meta/exif'
import { iccItems, readIcc } from '../meta/icc'
import { type Ifd, T, Tiff } from '../meta/ifd'
import { xmpSection } from '../meta/xmp'
import { jpegInfo } from './jpeg'

export const COMPRESSION_NAMES: Record<number, string> = {
  1: 'None',
  2: 'CCITT modified Huffman RLE',
  3: 'CCITT Group 3 fax',
  4: 'CCITT Group 4 fax',
  5: 'LZW',
  6: 'JPEG (old-style)',
  7: 'JPEG',
  8: 'Deflate',
  32946: 'Deflate',
  32773: 'PackBits',
  32809: 'ThunderScan',
  32895: 'IT8 CT padding',
  32896: 'IT8 line work RLE',
  32897: 'IT8 monochrome',
  32898: 'IT8 binary line art',
  32908: 'Pixar film',
  32909: 'Pixar log',
  32947: 'Kodak DCS',
  34661: 'JBIG',
  34676: 'SGI LogLuv',
  34677: 'SGI LogLuv 24',
  34712: 'JPEG 2000',
  34887: 'LERC',
  34892: 'JPEG (lossy DNG)',
  34925: 'LZMA',
  50000: 'Zstandard',
  50001: 'WebP',
  50002: 'JPEG XL',
  52546: 'JPEG XL (DNG)'
}

export const PHOTOMETRIC_NAMES: Record<number, string> = {
  0: 'Grey (white is zero)',
  1: 'Grey',
  2: 'RGB',
  3: 'Palette',
  4: 'Transparency mask',
  5: 'Separated (CMYK)',
  6: 'YCbCr',
  8: 'CIE L*a*b*',
  9: 'ICC L*a*b*',
  10: 'ITU L*a*b*',
  32803: 'Colour filter array',
  32844: 'LogL',
  32845: 'LogLuv',
  34892: 'Linear raw'
}

const JPEG_COMPRESSIONS = new Set([7, 34892])

/** The layout of one image directory. */
export interface TiffImage {
  ifd: Ifd
  width: number
  height: number
  bps: number
  spp: number
  format: number
  compression: number
  photometric: number
  planar: number
  predictor: number
  extra: number[]
  fillOrder: number
  orientation: number
  tiled: boolean
  chunkWidth: number
  chunkHeight: number
  offsets: number[]
  counts: number[]
  subfile: number
}

export function isImageIfd(ifd: Ifd): boolean {
  const e = ifd.entries
  return e.has(T.ImageWidth) && e.has(T.ImageLength) && (e.has(T.StripOffsets) || e.has(T.TileOffsets))
}

export function readImage(tiff: Tiff, ifd: Ifd): TiffImage {
  const get = (tag: number) => ifd.entries.get(tag)
  const num = (tag: number, fallback: number) => (get(tag) ? tiff.value(get(tag), fallback) : fallback)
  const width = num(T.ImageWidth, 0)
  const height = num(T.ImageLength, 0)
  if (!width || !height) throw damaged('TIFF image size')
  const spp = num(T.SamplesPerPixel, 1)
  if (spp < 1 || spp > 1024) throw damaged('TIFF samples per pixel')
  const bpsList = tiff.values(get(T.BitsPerSample), spp)
  const bps = bpsList[0] ?? 1
  if (bpsList.some((b) => b !== bps)) throw unsupportedPixels(`mixed bit depths (${bpsList.join(', ')})`)
  if (bps < 1 || bps > 64) throw damaged('TIFF bits per sample')
  // As libtiff reads it: a tile size makes the image tiled, and old writers (SGI) keep the tile
  // offsets and byte counts in StripOffsets and StripByteCounts.
  const tiled = !!get(T.TileWidth) || !!get(T.TileOffsets)
  const chunkWidth = tiled ? num(T.TileWidth, 0) : width
  const rps = num(T.RowsPerStrip, height)
  const chunkHeight = tiled ? num(T.TileLength, 0) : Math.min(Math.max(1, rps), height)
  if (!chunkWidth || !chunkHeight) throw damaged('TIFF tile size')
  const offsets = tiff.values(get(tiled && get(T.TileOffsets) ? T.TileOffsets : T.StripOffsets))
  const counts = tiff.values(get(tiled && get(T.TileByteCounts) ? T.TileByteCounts : T.StripByteCounts))
  return {
    ifd,
    width,
    height,
    bps,
    spp,
    format: num(T.SampleFormat, 1),
    compression: num(T.Compression, 1),
    photometric: num(T.Photometric, spp >= 3 ? 2 : 1),
    planar: spp > 1 ? num(T.PlanarConfiguration, 1) : 1,
    predictor: num(T.Predictor, 1),
    extra: tiff.values(get(T.ExtraSamples), 64),
    fillOrder: num(T.FillOrder, 1),
    orientation: num(T.Orientation, 1),
    tiled,
    chunkWidth,
    chunkHeight,
    offsets,
    counts,
    subfile: num(T.NewSubfileType, 0)
  }
}

/** Number of colour samples (before alpha and extra samples). */
function colourSamples(im: TiffImage): number {
  switch (im.photometric) {
    case 2:
    case 6:
    case 8:
    case 9:
    case 10:
    case 34892:
      return 3
    case 5:
      return Math.max(1, im.spp - im.extra.length)
    default:
      return 1
  }
}

/** Index of the alpha sample, or -1; and whether it is premultiplied. */
function alphaOf(im: TiffImage): { index: number; premultiplied: boolean } {
  const colour = colourSamples(im)
  for (let k = 0; k < im.extra.length; k++) {
    const index = im.spp - im.extra.length + k
    if (index < colour) continue
    if (im.extra[k] === 1 || im.extra[k] === 2) return { index, premultiplied: im.extra[k] === 1 }
  }
  // No ExtraSamples tag but one sample more than the colour needs: alpha, as most readers assume.
  if (!im.extra.length && im.spp === colour + 1 && im.photometric !== 5 && im.photometric !== 3) return { index: colour, premultiplied: false }
  return { index: -1, premultiplied: false }
}

function storeKindOf(im: TiffImage): SampleKind {
  if (im.format === 3) {
    if (im.bps === 16) return 'f16'
    if (im.bps === 24 || im.bps === 32 || im.bps === 64) return 'f32'
    throw unsupportedPixels(`${im.bps}-bit floating point`)
  }
  if (im.format === 2) return 'f32'
  if (im.format === 5 || im.format === 6) throw unsupportedPixels('complex samples')
  if (im.bps <= 8) return 'u8'
  if (im.bps <= 16) return 'u16'
  if (im.bps <= 32) return 'f32'
  throw unsupportedPixels(`${im.bps}-bit integers`)
}

interface Chunk {
  index: number
  plane: number
  x0: number
  y0: number
  rows: number
  data: Uint8Array
  partial: boolean
}

/** Every strip or tile with its place in the image; data past the end of the file is cut. */
function chunks(tiff: Tiff, im: TiffImage): { list: Chunk[]; partial: boolean } {
  const planes = im.planar === 2 ? im.spp : 1
  const across = Math.ceil(im.width / im.chunkWidth)
  const down = Math.ceil(im.height / im.chunkHeight)
  const perPlane = across * down
  const list: Chunk[] = []
  let partial = false
  const size = tiff.bytes.length
  // Missing byte counts: a chunk runs to the next chunk's offset or the end of the file, looked up
  // in a sorted copy (files with tens of thousands of strips).
  let sorted: number[] | null = null
  const nextOffset = (offset: number): number => {
    sorted ??= [...new Set(im.offsets)].sort((a, b) => a - b)
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] > offset) hi = mid
      else lo = mid + 1
    }
    return lo < sorted.length ? sorted[lo] : size
  }
  for (let p = 0; p < planes; p++) {
    for (let t = 0; t < perPlane; t++) {
      const index = p * perPlane + t
      const x0 = (t % across) * im.chunkWidth
      const y0 = Math.floor(t / across) * im.chunkHeight
      const rows = im.tiled ? im.chunkHeight : Math.min(im.chunkHeight, im.height - y0)
      const offset = im.offsets[index]
      if (offset === undefined || offset >= size || offset <= 0) {
        partial = true
        continue
      }
      let count = im.counts[index]
      if (count === undefined || count === 0) count = nextOffset(offset) - offset
      const end = Math.min(size, offset + count)
      list.push({ index, plane: p, x0, y0, rows, data: tiff.bytes.subarray(offset, end), partial: end < offset + count })
      if (end < offset + count) partial = true
    }
  }
  return { list, partial }
}

const REVERSED = (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    let v = i
    let r = 0
    for (let b = 0; b < 8; b++) {
      r = (r << 1) | (v & 1)
      v >>= 1
    }
    t[i] = r
  }
  return t
})()

async function decompress(
  im: TiffImage,
  raw: Uint8Array,
  expected: number,
  platform: Platform
): Promise<{ out: Uint8Array; complete: boolean }> {
  let src = raw
  if (im.fillOrder === 2) src = raw.map((b) => REVERSED[b])
  switch (im.compression) {
    case 1: {
      const out = new Uint8Array(expected)
      out.set(src.subarray(0, expected))
      return { out, complete: src.length >= expected }
    }
    case 5:
      return lzwDecode(src, expected)
    case 32773: {
      const { out, complete } = packbitsDecode(src, expected)
      return { out, complete }
    }
    case 8:
    case 32946:
      return { out: await platform.inflate(src, 'deflate', expected), complete: true }
    default:
      throw unsupportedCompression(COMPRESSION_NAMES[im.compression] ?? `code ${im.compression}`)
  }
}

/** Reads `n` samples of a row into `dst[di + k * step]`. */
function readSamples(
  buf: Uint8Array,
  view: DataView,
  off: number,
  n: number,
  bps: number,
  format: number,
  little: boolean,
  dst: Samples,
  di: number,
  step: number
): void {
  const end = buf.length
  if (format === 3) {
    const bytes = bps / 8
    for (let k = 0; k < n; k++) {
      const at = off + k * bytes
      if (at + bytes > end) return
      let v: number
      if (bps === 16) v = view.getUint16(at, little)
      else if (bps === 32) v = view.getFloat32(at, little)
      else if (bps === 64) v = view.getFloat64(at, little)
      else {
        const b0 = buf[at], b1 = buf[at + 1], b2 = buf[at + 2]
        v = float24ToFloat(little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2)
      }
      dst[di + k * step] = v
    }
    return
  }
  const signed = format === 2
  if (bps === 8) {
    for (let k = 0; k < n && off + k < end; k++) {
      const v = buf[off + k]
      dst[di + k * step] = signed && v > 127 ? v - 256 : v
    }
    return
  }
  if (bps === 16) {
    for (let k = 0; k < n; k++) {
      const at = off + k * 2
      if (at + 2 > end) return
      dst[di + k * step] = signed ? view.getInt16(at, little) : view.getUint16(at, little)
    }
    return
  }
  if (bps === 32) {
    for (let k = 0; k < n; k++) {
      const at = off + k * 4
      if (at + 4 > end) return
      dst[di + k * step] = signed ? view.getInt32(at, little) : view.getUint32(at, little)
    }
    return
  }
  if (bps === 24) {
    for (let k = 0; k < n; k++) {
      const at = off + k * 3
      if (at + 3 > end) return
      const b0 = buf[at], b1 = buf[at + 1], b2 = buf[at + 2]
      let v = little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2
      if (signed && v & 0x800000) v -= 0x1000000
      dst[di + k * step] = v
    }
    return
  }
  if (bps < 8 && 8 % bps === 0) {
    const per = 8 / bps
    const mask = (1 << bps) - 1
    for (let k = 0; k < n; k++) {
      const at = off + Math.floor(k / per)
      if (at >= end) return
      const shift = 8 - bps * ((k % per) + 1)
      dst[di + k * step] = (buf[at] >> shift) & mask
    }
    return
  }
  // Other widths (10, 12, 14…) are packed most significant bit first, whatever the byte order.
  let bit = off * 8
  const limit = end * 8
  for (let k = 0; k < n; k++, bit += bps) {
    if (bit + bps > limit) return
    let v = 0
    for (let b = 0; b < bps; b++) {
      const p = bit + b
      v = v * 2 + ((buf[p >> 3] >> (7 - (p & 7))) & 1)
    }
    if (signed && v >= 2 ** (bps - 1)) v -= 2 ** bps
    dst[di + k * step] = v
  }
}

async function forChunks<T>(list: readonly T[], run: (c: T) => Promise<void>, batch = 12): Promise<void> {
  for (let i = 0; i < list.length; i += batch) await Promise.all(list.slice(i, i + batch).map(run))
}

/** Decodes the samples of a non-JPEG image as stored: `spp` interleaved samples per pixel. */
async function decodeSamples(tiff: Tiff, im: TiffImage, platform: Platform): Promise<{ store: Samples; kind: SampleKind; partial: boolean }> {
  const kind = storeKindOf(im)
  checkSize(im.width, im.height, im.spp * bytesPerSample(kind))
  const store = allocate(kind, im.width * im.height * im.spp)
  const sppChunk = im.planar === 2 ? 1 : im.spp
  const rowBytes = Math.ceil((im.chunkWidth * sppChunk * im.bps) / 8)
  const little = im.predictor === 3 ? false : tiff.little
  const { list, partial: cut } = chunks(tiff, im)
  if (!list.length) throw damaged('TIFF strip offsets')
  let partial = cut
  let failures = 0
  let firstError: unknown = null
  await forChunks(list, async (c) => {
    const expected = c.rows * rowBytes
    let out: Uint8Array
    try {
      const result = await decompress(im, c.data, expected, platform)
      out = result.out
      if (!result.complete || c.partial) partial = true
    } catch (error) {
      if (error instanceof ImageError && error.code === 'unsupported-compression') throw error
      failures++
      firstError ??= error
      partial = true
      return
    }
    if (im.predictor === 2) undoHorizontal(out, c.rows, rowBytes, im.chunkWidth, sppChunk, im.bps, little)
    else if (im.predictor === 3) {
      if (im.format !== 3) throw unsupportedFeature('floating-point predictor on integers')
      undoFloatingPoint(out, c.rows, rowBytes, im.chunkWidth, sppChunk, im.bps)
    }
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    const cw = Math.min(im.chunkWidth, im.width - c.x0)
    const rows = Math.min(c.rows, im.height - c.y0)
    for (let r = 0; r < rows; r++) {
      const y = c.y0 + r
      const base = (y * im.width + c.x0) * im.spp
      if (im.planar === 2) readSamples(out, view, r * rowBytes, cw, im.bps, im.format, little, store, base + c.plane, im.spp)
      else readSamples(out, view, r * rowBytes, cw * im.spp, im.bps, im.format, little, store, base, 1)
    }
  })
  if (failures === list.length) throw firstError instanceof ImageError ? firstError : damaged('TIFF image data')
  return { store, kind, partial }
}

/** YCbCr with chroma subsampling (no JPEG): data units of h×v luma samples plus Cb and Cr. */
async function decodeSubsampled(tiff: Tiff, im: TiffImage, platform: Platform): Promise<{ rgb: Uint8Array; partial: boolean }> {
  if (im.bps !== 8 || im.planar !== 1) throw unsupportedPixels('subsampled YCbCr other than 8-bit chunky')
  const [h, v] = tiff.values(im.ifd.entries.get(T.YCbCrSubSampling), 2)
  if (![1, 2, 4].includes(h) || ![1, 2, 4].includes(v)) throw damaged('YCbCr subsampling')
  const { kr, kb, ref } = yccParams(tiff, im.ifd)
  checkSize(im.width, im.height, 3)
  const rgb = new Uint8Array(im.width * im.height * 3)
  const unitsAcross = Math.ceil(im.chunkWidth / h)
  const unitBytes = h * v + 2
  const { list, partial: cut } = chunks(tiff, im)
  let partial = cut
  const px = [0, 0, 0]
  await forChunks(list, async (c) => {
    const unitsDown = Math.ceil(c.rows / v)
    const expected = unitsAcross * unitsDown * unitBytes
    const { out, complete } = await decompress(im, c.data, expected, platform)
    if (!complete) partial = true
    for (let uy = 0; uy < unitsDown; uy++) {
      for (let ux = 0; ux < unitsAcross; ux++) {
        const at = (uy * unitsAcross + ux) * unitBytes
        const cb = (out[at + h * v] - ref[2]) * (127 / (ref[3] - ref[2])) + 128
        const cr = (out[at + h * v + 1] - ref[4]) * (127 / (ref[5] - ref[4])) + 128
        for (let dy = 0; dy < v; dy++) {
          const y = c.y0 + uy * v + dy
          if (y >= im.height || uy * v + dy >= c.rows) continue
          for (let dx = 0; dx < h; dx++) {
            const x = c.x0 + ux * h + dx
            if (x >= im.width || ux * h + dx >= im.chunkWidth) continue
            const Y = ((out[at + dy * h + dx] - ref[0]) * 255) / (ref[1] - ref[0])
            yccPixel(Y, cb, cr, kr, kb, px)
            const d = (y * im.width + x) * 3
            rgb[d] = px[0]
            rgb[d + 1] = px[1]
            rgb[d + 2] = px[2]
          }
        }
      }
    }
  })
  return { rgb, partial }
}

function yccParams(tiff: Tiff, ifd: Ifd): { kr: number; kb: number; ref: number[] } {
  const coeff = tiff.values(ifd.entries.get(T.YCbCrCoefficients), 3)
  const kr = coeff.length === 3 && coeff[0] > 0 ? coeff[0] : 0.299
  const kb = coeff.length === 3 && coeff[2] > 0 ? coeff[2] : 0.114
  let ref = tiff.values(ifd.entries.get(T.ReferenceBlackWhite), 6)
  if (ref.length !== 6 || ref[1] === ref[0] || ref[3] === ref[2] || ref[5] === ref[4]) ref = [0, 255, 128, 255, 128, 255]
  return { kr, kb, ref }
}

function yccPixel(Y: number, Cb: number, Cr: number, kr: number, kb: number, out: number[]): void {
  const kg = 1 - kr - kb
  const cb = Cb - 128
  const cr = Cr - 128
  const r = Y + 2 * (1 - kr) * cr
  const b = Y + 2 * (1 - kb) * cb
  const g = (Y - kr * r - kb * b) / kg
  out[0] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r)
  out[1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g)
  out[2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b)
}

/** JPEG (or WebP) strips and tiles, each a stream the browser decodes, with shared JPEG tables. */
async function decodeCodedChunks(tiff: Tiff, im: TiffImage, platform: Platform, mime: string): Promise<{ r: Raster; partial: boolean }> {
  if (!platform.decodeImage) throw new ImageError('no-decoder', mime === 'image/webp' ? 'WebP' : 'JPEG')
  if (im.planar === 2) throw unsupportedFeature('planar JPEG')
  const tables = mime === 'image/jpeg' ? tiff.raw(im.ifd.entries.get(T.JPEGTables)) : new Uint8Array(0)
  const grey = colourSamples(im) === 1 && im.photometric !== 5
  const withAlpha = mime === 'image/webp' && im.spp === 4
  const channels = grey ? 1 : withAlpha ? 4 : 3
  checkSize(im.width, im.height, channels)
  const out = new Uint8Array(im.width * im.height * channels)
  const { list, partial: cut } = chunks(tiff, im)
  if (!list.length) throw damaged('TIFF strip offsets')
  let partial = cut
  let failures = 0
  let firstError: unknown = null
  await forChunks(list, async (c) => {
    let stream = c.data
    if (tables.length > 4 && stream[0] === 0xff && stream[1] === 0xd8) {
      // Tables (SOI … EOI) then the chunk without its SOI.
      const merged = new Uint8Array(tables.length - 2 + stream.length - 2)
      merged.set(tables.subarray(0, tables.length - 2))
      merged.set(stream.subarray(2), tables.length - 2)
      stream = merged
    }
    let img: { width: number; height: number; data: Uint8Array }
    try {
      img = await (platform.decodeImage as NonNullable<Platform['decodeImage']>)(stream, mime)
    } catch (error) {
      failures++
      firstError ??= error
      partial = true
      return
    }
    const cw = Math.min(img.width, im.width - c.x0, im.chunkWidth)
    const rows = Math.min(img.height, im.height - c.y0, c.rows)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cw; x++) {
        const s = (y * img.width + x) * 4
        const d = ((c.y0 + y) * im.width + c.x0 + x) * channels
        out[d] = img.data[s]
        if (channels > 1) {
          out[d + 1] = img.data[s + 1]
          out[d + 2] = img.data[s + 2]
          if (channels === 4) out[d + 3] = img.data[s + 3]
        }
      }
    }
  })
  if (failures === list.length) {
    const info = list[0] ? jpegInfo(list[0].data, 0, false) : null
    if (info && info.precision !== 8) throw unsupportedPixels(`${info.precision}-bit JPEG`)
    if (info && info.sof === 3) throw unsupportedCompression('lossless JPEG')
    throw firstError instanceof ImageError ? firstError : damaged('JPEG data')
  }
  return { r: raster(im.width, im.height, channels, 'u8', out, { alpha: withAlpha }), partial }
}

/** Turns stored samples into a displayable raster (colour model, alpha, value type). */
function toRaster(tiff: Tiff, im: TiffImage, store: Samples, kind: SampleKind): { r: Raster; notices: Notice[] } {
  const { width: W, height: H, spp, bps, photometric } = im
  const n = W * H
  const notices: Notice[] = []
  const { index: alphaIndex, premultiplied } = alphaOf(im)
  const alpha = alphaIndex >= 0
  const intMax = 2 ** bps - 1
  const isFloat = im.format === 3
  const isData = im.format === 2 || (!isFloat && bps > 16)

  // Picks colour channels (by index) and alpha into a new interleaved array of `kind`.
  const pick = (indices: number[], outKind: SampleKind, map?: (v: number, k: number) => number): Samples => {
    const c = indices.length + (alpha ? 1 : 0)
    const out = allocate(outKind, n * c)
    for (let i = 0, s = 0, d = 0; i < n; i++, s += spp, d += c) {
      for (let k = 0; k < indices.length; k++) out[d + k] = map ? map(store[s + indices[k]], k) : store[s + indices[k]]
      if (alpha) out[d + indices.length] = store[s + alphaIndex]
    }
    return out
  }

  const finish = (data: Samples, outKind: SampleKind, color: 'gray' | 'rgb', options: { bits?: number; transfer?: 'srgb' | 'linear' | 'data' } = {}): Raster => {
    const channels = (color === 'rgb' ? 3 : 1) + (alpha ? 1 : 0)
    const r = raster(W, H, channels, outKind, data, {
      color,
      alpha,
      premultiplied: alpha && premultiplied,
      bits: options.bits,
      transfer: options.transfer ?? 'srgb'
    })
    if (r.transfer === 'data') r.range = valueRange(r)
    return r
  }

  // Floats and wide or signed integers: f32, linear light for RGB, measured data for grey.
  const floatLike = (indices: number[], color: 'gray' | 'rgb'): Raster => {
    if (kind === 'f16' && color === 'rgb') {
      const data = indices.length === spp && !alpha ? store : pick(indices, 'f16')
      return finish(data, 'f16', color, { transfer: 'linear' })
    }
    if (kind === 'f16') {
      const table = halfTable()
      const data = pick(indices, 'f32', (v) => table[v])
      return finish(data, 'f32', color, { transfer: color === 'rgb' ? 'linear' : 'data' })
    }
    const data = indices.length === spp && !alpha ? store : pick(indices, 'f32')
    return finish(data, 'f32', color, { transfer: isFloat && color === 'rgb' ? 'linear' : 'data' })
  }

  switch (photometric) {
    case 0:
    case 1:
    case 4: {
      if (isFloat || isData) return { r: floatLike([0], 'gray'), notices }
      const invert = photometric === 0
      if (kind === 'u8' && bps < 8) {
        const data = pick([0], 'u8', (v) => Math.round(((invert ? intMax - v : v) * 255) / intMax))
        return { r: finish(data, 'u8', 'gray'), notices }
      }
      const data = !invert && spp === (alpha ? 2 : 1) ? store : pick([0], kind, invert ? (v) => intMax - v : undefined)
      return { r: finish(data, kind, 'gray', { bits: bps }), notices }
    }
    case 2:
    case 34892: {
      if (spp < 3) throw damaged('RGB with fewer than 3 samples')
      if (isFloat || isData) return { r: floatLike([0, 1, 2], 'rgb'), notices }
      if (kind === 'u8' && bps < 8) {
        const data = pick([0, 1, 2], 'u8', (v) => Math.round((v * 255) / intMax))
        return { r: finish(data, 'u8', 'rgb'), notices }
      }
      const data = spp === (alpha ? 4 : 3) ? store : pick([0, 1, 2], kind)
      return { r: finish(data, kind, 'rgb', { bits: bps, transfer: photometric === 34892 ? 'linear' : 'srgb' }), notices }
    }
    case 3: {
      if (isFloat || bps > 16) throw unsupportedPixels(`${bps}-bit palette`)
      const map = tiff.values(im.ifd.entries.get(T.ColorMap))
      const size = 1 << bps
      if (map.length < size * 3) throw damaged('TIFF colour map')
      // 16-bit entries as the standard says (v × 257 or v × 256 for 8-bit colours); some writers
      // store plain 8-bit values instead.
      const small = map.every((v) => v < 256)
      const eight = small || map.every((v) => v % 257 === 0 || (v & 255) === 0)
      const outKind: SampleKind = eight ? 'u8' : 'u16'
      const data = pick([0, 0, 0], outKind, (v, k) => {
        const e = map[k * size + (v < size ? v : 0)]
        return small || !eight ? e : e >> 8
      })
      return { r: finish(data, outKind, 'rgb'), notices }
    }
    case 5: {
      const inks = colourSamples(im)
      const inkSet = tiff.value(im.ifd.entries.get(T.InkSet), 1)
      if (isFloat || isData) throw unsupportedPixels('floating-point CMYK')
      if (inks === 1) {
        const data = pick([0], kind, (v) => intMax - v)
        return { r: finish(data, kind, 'gray', { bits: bps }), notices }
      }
      if (inks < 4 || inkSet === 2) throw unsupportedPixels(`${inks}-ink separation`)
      if (kind !== 'u8' && kind !== 'u16') throw unsupportedPixels(`${bps}-bit CMYK`)
      let src = store
      let channels = spp
      if (bps !== 8 && bps !== 16) {
        src = pick([0, 1, 2, 3], kind, (v) => Math.round((v * (kind === 'u8' ? 255 : 65535)) / intMax))
        channels = 4 + (alpha ? 1 : 0)
      } else if (spp !== 4 + (alpha ? 1 : 0)) {
        src = pick([0, 1, 2, 3], kind)
        channels = 4 + (alpha ? 1 : 0)
      }
      const data = cmykToRgb(src, kind, n, channels)
      notices.push({ code: 'cmyk-converted' })
      return { r: finish(data, kind, 'rgb'), notices }
    }
    case 6: {
      if (bps !== 8 || kind !== 'u8') throw unsupportedPixels(`${bps}-bit YCbCr`)
      const { kr, kb, ref } = yccParams(tiff, im.ifd)
      const c = 3 + (alpha ? 1 : 0)
      const out = new Uint8Array(n * c)
      const px = [0, 0, 0]
      for (let i = 0, s = 0, d = 0; i < n; i++, s += spp, d += c) {
        const Y = ((store[s] - ref[0]) * 255) / (ref[1] - ref[0])
        const cb = (store[s + 1] - ref[2]) * (127 / (ref[3] - ref[2])) + 128
        const cr = (store[s + 2] - ref[4]) * (127 / (ref[5] - ref[4])) + 128
        yccPixel(Y, cb, cr, kr, kb, px)
        out[d] = px[0]
        out[d + 1] = px[1]
        out[d + 2] = px[2]
        if (alpha) out[d + 3] = store[s + alphaIndex]
      }
      notices.push({ code: 'ycc-converted' })
      return { r: finish(out, 'u8', 'rgb'), notices }
    }
    case 8:
    case 9: {
      if (bps !== 8 && bps !== 16) throw unsupportedPixels(`${bps}-bit L*a*b*`)
      const icc = photometric === 9
      const outKind: SampleKind = bps === 8 ? 'u8' : 'u16'
      const top = bps === 8 ? 255 : 65535
      const c = 3 + (alpha ? 1 : 0)
      const out = allocate(outKind, n * c)
      const px = [0, 0, 0]
      for (let i = 0, s = 0, d = 0; i < n; i++, s += spp, d += c) {
        const L = (store[s] * 100) / top
        let a: number
        let b: number
        if (bps === 8) {
          a = icc ? store[s + 1] - 128 : store[s + 1] > 127 ? store[s + 1] - 256 : store[s + 1]
          b = icc ? store[s + 2] - 128 : store[s + 2] > 127 ? store[s + 2] - 256 : store[s + 2]
        } else {
          a = icc ? store[s + 1] / 257 - 128 : (store[s + 1] > 32767 ? store[s + 1] - 65536 : store[s + 1]) / 256
          b = icc ? store[s + 2] / 257 - 128 : (store[s + 2] > 32767 ? store[s + 2] - 65536 : store[s + 2]) / 256
        }
        labToRgb(L, a, b, px)
        out[d] = Math.round(px[0] * top)
        out[d + 1] = Math.round(px[1] * top)
        out[d + 2] = Math.round(px[2] * top)
        if (alpha) out[d + 3] = store[s + alphaIndex]
      }
      notices.push({ code: 'lab-converted' })
      return { r: finish(out, outKind, 'rgb'), notices }
    }
    case 32803:
      throw unsupportedPixels('colour filter array (sensor data)')
    case 32844:
    case 32845:
      throw unsupportedPixels('SGI LogLuv')
    default:
      throw unsupportedPixels(PHOTOMETRIC_NAMES[photometric] ?? `photometric ${photometric}`)
  }
}

/** Decodes one image directory to a raster, oriented as its Orientation tag says. */
export async function decodeIfd(tiff: Tiff, ifd: Ifd, platform: Platform, options: { orient?: boolean } = {}): Promise<Raster> {
  const im = readImage(tiff, ifd)
  if (im.photometric === 32803) throw unsupportedPixels('colour filter array (sensor data)')
  let r: Raster
  let partial = false
  let notices: Notice[] = []
  if (JPEG_COMPRESSIONS.has(im.compression) || im.compression === 50001) {
    const result = await decodeCodedChunks(tiff, im, platform, im.compression === 50001 ? 'image/webp' : 'image/jpeg')
    r = result.r
    partial = result.partial
  } else if (im.compression === 6) {
    const at = tiff.value(ifd.entries.get(T.JPEGInterchangeFormat))
    const length = tiff.value(ifd.entries.get(T.JPEGInterchangeFormatLength))
    if (!at || !platform.decodeImage) throw unsupportedCompression('JPEG (old-style)')
    const img = await platform.decodeImage(tiff.bytes.subarray(at, length ? at + length : tiff.bytes.length), 'image/jpeg')
    r = dropAlpha(raster(img.width, img.height, 4, 'u8', img.data))
  } else if (im.photometric === 6 && tiff.values(ifd.entries.get(T.YCbCrSubSampling), 2).some((v) => v > 1)) {
    const result = await decodeSubsampled(tiff, im, platform)
    r = raster(im.width, im.height, 3, 'u8', result.rgb)
    partial = result.partial
    notices.push({ code: 'ycc-converted' })
  } else {
    const result = await decodeSamples(tiff, im, platform)
    const done = toRaster(tiff, im, result.store, result.kind)
    r = done.r
    notices = done.notices
    partial = result.partial
  }
  if (partial) r.partial = true
  if (notices.length) r.notices = notices
  if (options.orient !== false && im.orientation > 1) r = orient(r, im.orientation)
  return r
}

// ---------------------------------------------------------------- document

function resolution(tiff: Tiff, ifd: Ifd): string {
  const x = tiff.value(ifd.entries.get(T.XResolution))
  const y = tiff.value(ifd.entries.get(T.YResolution))
  if (!x) return ''
  const unit = tiff.value(ifd.entries.get(T.ResolutionUnit), 2)
  // Without a unit the values only give the pixel aspect, which 1:1 makes moot.
  if (unit === 1 && (!y || Math.abs(y - x) < 0.01)) return ''
  const name = unit === 3 ? 'px/cm' : unit === 1 ? '' : 'dpi'
  const fmt = (v: number) => String(Math.round(v * 100) / 100)
  return `${fmt(x)}${y && Math.abs(y - x) > 0.01 ? ` × ${fmt(y)}` : ''} ${name}`.trim()
}

/** Details of one image directory for the info pane. */
export function imageItems(tiff: Tiff, im: TiffImage): InfoItem[] {
  const ifd = im.ifd
  const items: InfoItem[] = [{ key: 'dimensions', value: `${im.width} × ${im.height}` }]
  const formatName = im.format === 3 ? ' float' : im.format === 2 ? ' signed' : ''
  items.push({ key: 'bitDepth', value: `${im.bps}${formatName} × ${im.spp}` })
  items.push({ key: 'photometric', value: PHOTOMETRIC_NAMES[im.photometric] ?? String(im.photometric) })
  if (im.extra.length) {
    const names = im.extra.map((e) => (e === 1 ? 'premultiplied alpha' : e === 2 ? 'alpha' : 'unspecified'))
    items.push({ key: 'extraSamples', value: names.join(', ') })
  }
  if (im.photometric === 3) items.push({ key: 'paletteSize', value: String(1 << im.bps) })
  items.push({ key: 'compression', value: COMPRESSION_NAMES[im.compression] ?? `code ${im.compression}` })
  if (im.predictor > 1) items.push({ key: 'predictor', value: im.predictor === 2 ? 'Horizontal differencing' : im.predictor === 3 ? 'Floating point' : String(im.predictor) })
  if (im.spp > 1) items.push({ key: 'planar', value: im.planar === 2 ? 'Separate planes' : 'Chunky (interleaved)' })
  const count = im.offsets.length
  items.push({
    key: 'layout',
    value: im.tiled ? `${counted(count, 'tile')} of ${im.chunkWidth} × ${im.chunkHeight}` : `${counted(count, 'strip')} of ${counted(im.chunkHeight, 'row')}`
  })
  if (im.orientation > 1) items.push({ key: 'orientation', value: ORIENTATION_NAMES[im.orientation] ?? String(im.orientation) })
  const res = resolution(tiff, ifd)
  if (res) items.push({ key: 'resolution', value: res })
  const pageName = tiff.string(ifd.entries.get(T.PageName))
  if (pageName) items.push({ key: 'pageName', value: pageName })
  if (im.subfile) {
    const kinds = [im.subfile & 1 ? 'reduced resolution' : '', im.subfile & 2 ? 'page of a multi-page image' : '', im.subfile & 4 ? 'transparency mask' : ''].filter(Boolean)
    items.push({ key: 'subfile', value: kinds.join(', ') || String(im.subfile) })
  }
  const icc = ifd.entries.get(T.ICC)
  if (icc) items.push(...iccItems(readIcc(tiff.raw(icc))))
  const nodata = tiff.string(ifd.entries.get(T.GDALNoData))
  if (nodata) items.push({ key: 'noData', value: nodata })
  return items
}

export interface TiffEntry {
  ifd: Ifd
  label: string
  page: number
}

/** Pages along the IFD chain, each followed by its sub-images (SubIFDs). */
export function tiffEntries(tiff: Tiff, max = 2000): TiffEntry[] {
  const out: TiffEntry[] = []
  const chain = tiff.chain()
  let page = 0
  const seen = new Set<number>()
  for (const ifd of chain) {
    if (out.length >= max) break
    seen.add(ifd.offset)
    if (isImageIfd(ifd)) {
      page++
      const reduced = tiff.value(ifd.entries.get(T.NewSubfileType)) & 1
      let name = ''
      try {
        name = tiff.string(ifd.entries.get(T.PageName)).trim().slice(0, 80)
      } catch {
        // No page name.
      }
      const base = reduced && page > 1 ? `Page ${page} (reduced)` : `Page ${page}`
      out.push({ ifd, label: name ? `${base} · ${name}` : base, page })
    }
    const subs = tiff.values(ifd.entries.get(T.SubIFDs), 64)
    let k = 0
    for (const at of subs) {
      if (seen.has(at) || out.length >= max) continue
      seen.add(at)
      try {
        const sub = tiff.readIfd(at)
        if (!isImageIfd(sub)) continue
        k++
        out.push({ ifd: sub, label: `Page ${Math.max(page, 1)} · sub-image ${k}`, page: Math.max(page, 1) })
      } catch {
        // A damaged sub-image does not hide the others.
      }
    }
  }
  return out
}

export async function openTiff(bytes: Uint8Array, platform: Platform): Promise<Decoded> {
  const tiff = new Tiff(bytes)
  const entries = tiffEntries(tiff)
  if (!entries.length) throw damaged('TIFF has no images')
  const first = entries[0].ifd
  const images: ImageDesc[] = []
  const layouts: (TiffImage | null)[] = []
  for (const [i, e] of entries.entries()) {
    let im: TiffImage | null = null
    let unsupported: string | undefined
    try {
      im = readImage(tiff, e.ifd)
    } catch (error) {
      unsupported = error instanceof ImageError ? error.detail || error.code : 'damaged'
    }
    layouts.push(im)
    const swap = im && im.orientation >= 5
    images.push({
      id: i,
      width: im ? (swap ? im.height : im.width) : 0,
      height: im ? (swap ? im.width : im.height) : 0,
      at: [i],
      label: e.label,
      unsupported,
      info: im ? imageItems(tiff, im) : []
    })
  }

  const fileItems: InfoItem[] = [
    { key: 'byteOrder', value: tiff.little ? 'Little-endian (II)' : 'Big-endian (MM)' },
    { key: 'variant', value: tiff.big ? 'BigTIFF' : 'Classic TIFF' }
  ]
  const pages = new Set(entries.map((e) => e.page)).size
  if (entries.length > 1) fileItems.push({ key: 'pages', value: entries.length === pages ? String(pages) : `${pages} (${counted(entries.length, 'image')})` })
  const str = (tag: number) => {
    try {
      return tiff.string(first.entries.get(tag))
    } catch {
      return ''
    }
  }
  const software = str(T.Software)
  if (software) fileItems.push({ key: 'software', value: software })
  const date = str(T.DateTime)
  if (date) fileItems.push({ key: 'modified', value: exifDate(date) })
  const artist = str(T.Artist)
  if (artist) fileItems.push({ key: 'artist', value: artist })
  const copyright = str(T.Copyright)
  if (copyright) fileItems.push({ key: 'copyright', value: copyright })
  const description = str(T.ImageDescription)
  if (description) fileItems.push({ key: 'description', value: description.length > 600 ? `${description.slice(0, 600)}…` : description })
  if (first.entries.has(37724)) fileItems.push({ key: 'layers', value: 'Layer data present (shown flattened)' })

  const sections: InfoSection[] = []
  try {
    const exif = exifSummary(tiff, exifDirs(tiff, first), { imageTags: false })
    // The camera section repeats software, artist and copyright from IFD0: keep those in File.
    sections.push(...exif.sections.map((s) => (s.title === 'camera' ? { ...s, items: s.items.filter((i) => !['software', 'artist', 'copyright', 'description'].includes(i.key)) } : s)).filter((s) => s.items.length))
  } catch {
    // Damaged EXIF does not stop the image.
  }
  const xmp = first.entries.get(T.XMP)
  if (xmp) {
    const x = xmpSection(text(tiff.raw(xmp)))
    if (x) sections.push(x)
  }

  const single = entries.length === 1
  const imageSection: InfoSection = single
    ? { title: 'image', items: images[0].info }
    : { title: 'image', items: [{ key: 'pages', value: String(pages) }, ...(images[0].info.filter((i) => i.key === 'iccProfile'))] }

  return {
    desc: {
      format: tiff.big ? 'BigTIFF' : 'TIFF',
      images,
      axes: single ? [] : [{ key: 'page', labels: images.map((i) => i.label) }],
      primary: Math.max(0, images.findIndex((i) => !i.unsupported)),
      list: single ? undefined : 'page',
      info: [imageSection, { title: 'file', items: fileItems }, ...sections],
      notices: []
    },
    async decode(id) {
      const entry = entries[id]
      if (!entry) throw damaged('TIFF page')
      return decodeIfd(tiff, entry.ifd, platform)
    }
  }
}

