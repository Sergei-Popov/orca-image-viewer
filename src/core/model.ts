// What a decoder hands the viewer: a description of the file (images, pickers, layers, info) that
// crosses from the decode worker as plain data, and rasters decoded one at a time on request.

/** How samples are stored: 8- or 16-bit integers, half floats (raw bits) or 32-bit floats. */
export type SampleKind = 'u8' | 'u16' | 'f16' | 'f32'

/**
 * How values turn into screen colour.
 * - `srgb`: integers (or 0–1 floats) already encoded for display, like PNG.
 * - `linear`: scene-referred light, as in OpenEXR and Radiance: exposure, tone map, then sRGB.
 * - `data`: measurements (elevations, depths): stretched between black and white levels as grey.
 */
export type Transfer = 'srgb' | 'linear' | 'data'

export type Samples = Uint8Array | Uint16Array | Float32Array

export interface Raster {
  width: number
  height: number
  /** Samples per pixel, interleaved, rows top to bottom. */
  channels: number
  kind: SampleKind
  data: Samples
  /** The first 1 (grey) or 3 (RGB) channels are colour. */
  color: 'gray' | 'rgb'
  /** The last channel is alpha. */
  alpha: boolean
  /** Colour is premultiplied by alpha (OpenEXR, TIFF associated alpha). */
  premultiplied: boolean
  transfer: Transfer
  /** Significant bits per sample in the file (12 for 12-bit data in 16-bit samples). */
  bits: number
  /** Channel names in data order, shown by the pixel inspector. */
  names: string[]
  /** Smallest and largest finite values, for `data` rasters. */
  range?: [number, number]
  /** The file ended or broke before every pixel was read; the rest is blank. */
  partial?: boolean
  /** Things worth saying about this image only (its alpha could not be decoded…). */
  notices?: Notice[]
}

export type InfoValue = string

/** One line of the info pane. `key` is translated when the strings know it, shown as is otherwise. */
export interface InfoItem {
  key: string
  value: InfoValue
  mono?: boolean
  /**
   * In a raw section (EXIF, EXR attributes), the value is the reader's own wording, such as a named
   * value or a byte count, and is translated like other details; other raw values show as stored.
   */
  term?: boolean
}

export interface InfoSection {
  /** Translated section title key: `image`, `file`, `exif`, `gps`, `camera`, `xmp`… */
  title: string
  items: InfoItem[]
  /** Show item keys untranslated (EXIF tag names). */
  raw?: boolean
  /** Long text shown in a scrolling block (an XMP packet). */
  text?: string
}

/** A dimension the toolbar picks along: pages, mip levels, cube faces, sizes, parts. */
export interface Axis {
  key: 'page' | 'mip' | 'face' | 'layer' | 'slice' | 'size' | 'part' | 'image' | 'frame'
  labels: string[]
  /** For each label, which of its ` · ` segments are text from the file (see ImageDesc). */
  fileText?: number[][]
}

export interface ImageDesc {
  id: number
  width: number
  height: number
  /** Position along each of the document's axes. */
  at: number[]
  /** Short text for lists and file names: `Page 2`, `512×512 · ic09`. */
  label: string
  /**
   * The indexes of the label's ` · ` segments that are text from the file (EXR part and channel
   * names, TIFF page names, PSD layer names): shown as they are, never translated.
   */
  fileText?: number[]
  /** Why it cannot be shown (a JPEG 2000 icon); undefined when it can. */
  unsupported?: string
  info: InfoItem[]
}

export interface LayerDesc {
  id: number
  name: string
  /** Visible in the saved file. */
  visible: boolean
  opacity: number
  blend: string
  kind: 'pixel' | 'group' | 'text' | 'adjustment' | 'smart' | 'fill' | 'empty'
  depth: number
  left: number
  top: number
  width: number
  height: number
  clipping: boolean
  /** Image id of the layer's pixels; -1 for groups and empty layers. */
  image: number
}

export type NoticeCode =
  | 'raw-preview'
  | 'psd-no-composite'
  | 'psd-composite-simple'
  | 'damaged-partial'
  | 'heic-alpha-skipped'
  | 'cmyk-converted'
  | 'lab-converted'
  | 'ycc-converted'
  | 'exr-multipart'
  | 'unsupported-images'

export interface Notice {
  code: NoticeCode
  detail?: string
}

export interface DocDesc {
  /** Format name shown in the badge: `TIFF`, `OpenEXR`, `Canon CR3`. */
  format: string
  images: ImageDesc[]
  axes: Axis[]
  /** Image shown first. */
  primary: number
  /** Thumbnails list in the side pane for this axis (ICNS sizes, TIFF pages). */
  list?: Axis['key']
  layers?: LayerDesc[]
  info: InfoSection[]
  notices: Notice[]
}

/** A decoder's result inside the worker: the description plus decoding on request. */
export interface Decoded {
  desc: DocDesc
  decode(id: number): Promise<Raster>
  /** PSD: a simple composite of the layers marked visible. */
  composite?(visible: readonly boolean[]): Promise<Raster>
}

/** Platform services the decoders call; the worker gives browser ones, tests give stand-ins. */
export interface Platform {
  /** zlib (`deflate`) or raw DEFLATE (`deflate-raw`) data to bytes; `expected` sizes the output. */
  inflate(data: Uint8Array, format: 'deflate' | 'deflate-raw', expected?: number): Promise<Uint8Array>
  /** A JPEG, PNG or other browser-decodable image to 8-bit RGBA. */
  decodeImage?(data: Uint8Array, mime: string): Promise<{ width: number; height: number; data: Uint8Array }>
  /** HEVC (or AV1) coded images to 8-bit RGBA, for HEIF. */
  decodeVideo?: VideoImageDecoder
}

export interface CodedImage {
  data: Uint8Array
  width: number
  height: number
}

export interface VideoImageDecoder {
  /** Whether this codec string with this configuration decodes here. */
  supported(codec: string, description: Uint8Array): Promise<boolean>
  /** Decodes independent coded images (tiles) to RGBA (or a single luma plane for alpha). */
  decode(
    codec: string,
    description: Uint8Array,
    images: readonly CodedImage[],
    color: VideoColor,
    plane: 'rgba' | 'luma'
  ): Promise<Uint8Array[]>
}

export interface VideoColor {
  /** ISO/IEC 23091-2 matrix coefficients; -1 when the file does not say (the frame's tag is used). */
  matrix: number
  /** The file's range; the decoder's frames say how their samples are actually stored. */
  fullRange: boolean
}

export function bytesPerSample(kind: SampleKind): number {
  return kind === 'u8' ? 1 : kind === 'f32' ? 4 : 2
}

export function allocate(kind: SampleKind, length: number): Samples {
  if (kind === 'u8') return new Uint8Array(length)
  if (kind === 'f32') return new Float32Array(length)
  return new Uint16Array(length)
}

/**
 * A label joined from pieces with ` · `, and the indexes of its segments that came from the file
 * (a piece may itself hold ` · `).
 */
export function joinLabel(pieces: readonly { text: string; file?: boolean }[]): { label: string; fileText: number[] } {
  const fileText: number[] = []
  let n = 0
  for (const piece of pieces) {
    const count = piece.text.split(' · ').length
    if (piece.file) for (let i = 0; i < count; i++) fileText.push(n + i)
    n += count
  }
  return { label: pieces.map((p) => p.text).join(' · '), fileText }
}

/** A raster with defaults for the common case: sRGB colour, no alpha. */
export function raster(
  width: number,
  height: number,
  channels: number,
  kind: SampleKind,
  data: Samples,
  options: Partial<Omit<Raster, 'width' | 'height' | 'channels' | 'kind' | 'data'>> = {}
): Raster {
  const color = options.color ?? (channels >= 3 ? 'rgb' : 'gray')
  const alpha = options.alpha ?? (channels === 2 || channels === 4)
  const names =
    options.names ??
    (color === 'rgb' ? ['R', 'G', 'B', 'A', 'E1', 'E2', 'E3'] : ['Y', 'A', 'E1', 'E2']).slice(0, channels)
  return {
    width,
    height,
    channels,
    kind,
    data,
    color,
    alpha,
    premultiplied: options.premultiplied ?? false,
    transfer: options.transfer ?? 'srgb',
    bits: options.bits ?? (kind === 'u8' ? 8 : kind === 'u16' || kind === 'f16' ? 16 : 32),
    names,
    range: options.range,
    partial: options.partial
  }
}

/** The transferable buffers of a raster, for postMessage. */
export function transferables(r: Raster): ArrayBuffer[] {
  return [r.data.buffer as ArrayBuffer]
}
