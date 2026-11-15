// Errors the decoders throw. Each carries a code the view turns into a message in Orca's language;
// `name` is a technical name (a compression, a pixel format) that needs no translation.

export type ErrorCode =
  | 'empty'
  | 'unknown-format'
  | 'truncated'
  | 'damaged'
  | 'unsupported-compression'
  | 'unsupported-pixels'
  | 'unsupported-feature'
  | 'too-large'
  | 'no-decoder'
  /** WebCodecs has no decoder for the codec family in `detail` (HEVC, AV1) on this system. */
  | 'no-video-decoder'
  | 'decode-failed'
  | 'text-file'

export class ImageError extends Error {
  constructor(
    readonly code: ErrorCode,
    /** A technical name shown as is: `CCITT T.6`, `BC6H`, `DWAA`. */
    readonly detail = '',
    message?: string
  ) {
    super(message ?? (detail ? `${code}: ${detail}` : code))
  }
}

export const truncated = (what = '') => new ImageError('truncated', what)
export const damaged = (what = '') => new ImageError('damaged', what)
export const unsupportedCompression = (name: string) => new ImageError('unsupported-compression', name)
export const unsupportedPixels = (name: string) => new ImageError('unsupported-pixels', name)
export const unsupportedFeature = (name: string) => new ImageError('unsupported-feature', name)

/** Decoded images stay in memory while the tab is open; these bound one image. */
export const MAX_PIXELS = 120_000_000
export const MAX_RASTER_BYTES = 768 * 1024 * 1024
export const MAX_SIDE = 1 << 20
/**
 * More images than this in one file (parts, layers, faces, slices × levels) comes from a damaged
 * header: the counts are checked before any image is described.
 */
export const MAX_IMAGES = 8192

export function checkSize(width: number, height: number, bytesPerPixel: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw damaged(`size ${width}×${height}`)
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS || width * height * bytesPerPixel > MAX_RASTER_BYTES) {
    throw new ImageError('too-large', `${width}×${height}`)
  }
}
