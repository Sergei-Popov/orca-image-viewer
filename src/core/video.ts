// Decodes the coded images of a HEIF file (HEVC tiles) with WebCodecs' VideoDecoder, which Orca's
// Chromium hands to the system decoder. Frames are converted to RGBA here with the file's matrix.
// The range comes from the frame: macOS hands back video-range NV12 even for full-range files, and
// the frame's colour space says so.

import { ImageError } from './errors'
import type { CodedImage, VideoColor, VideoImageDecoder } from './model'

const KR_KB: Record<number, [number, number]> = {
  1: [0.2126, 0.0722],
  4: [0.3, 0.11],
  5: [0.299, 0.114],
  6: [0.299, 0.114],
  7: [0.212, 0.087],
  9: [0.2627, 0.0593],
  10: [0.2627, 0.0593]
}

const PLANAR = new Set(['I420', 'I420A', 'I422', 'I444', 'I420P10', 'I420AP10', 'I422P10', 'I444P10', 'I420P12', 'I422P12', 'I444P12', 'NV12'])

/** YUV planes (8 to 12 bits) to RGBA bytes, or to the Y plane alone. */
export function yuvToRgba(
  format: string,
  width: number,
  height: number,
  buffer: Uint8Array,
  layout: { offset: number; stride: number }[],
  color: VideoColor,
  plane: 'rgba' | 'luma'
): Uint8Array {
  const high = /P1[02]$/.test(format)
  const bits = format.endsWith('P12') ? 12 : high ? 10 : 8
  const view16 = high ? new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >> 1) : null
  const sample = (p: number, x: number, y: number): number => {
    const { offset, stride } = layout[p]
    if (view16) return view16[(offset + y * stride) / 2 + x]
    return buffer[offset + y * stride + x]
  }
  const max = (1 << bits) - 1
  const half = 1 << (bits - 1)
  const scale = 1 << (bits - 8)
  // To 8-bit scale: full range spans 0–max, video range 16–235 (luma) and 16–240 (chroma).
  const yOffset = color.fullRange ? 0 : 16 * scale
  const yGain = color.fullRange ? 255 / max : 255 / (219 * scale)
  const cGain = color.fullRange ? 255 / max : 255 / (224 * scale)
  if (plane === 'luma') {
    const out = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (sample(0, x, y) - yOffset) * yGain
        out[y * width + x] = v < 0 ? 0 : v > 255 ? 255 : v + 0.5
      }
    }
    return out
  }
  const [kr, kb] = KR_KB[color.matrix] ?? KR_KB[6]
  const kg = 1 - kr - kb
  const nv12 = format === 'NV12'
  const sx = format.startsWith('I444') ? 0 : 1
  const sy = format.startsWith('I420') || nv12 ? 1 : 0
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const cy = y >> sy
    for (let x = 0; x < width; x++) {
      const cx = x >> sx
      const Y = (sample(0, x, y) - yOffset) * yGain
      let U: number, V: number
      if (nv12) {
        U = sample(1, cx * 2, cy)
        V = sample(1, cx * 2 + 1, cy)
      } else {
        U = sample(1, cx, cy)
        V = sample(2, cx, cy)
      }
      const cb = (U - half) * cGain
      const cr = (V - half) * cGain
      let r: number, g: number, b: number
      if (color.matrix === 0) {
        // Identity matrix: the planes hold G, B and R.
        g = Y
        b = cb + 128
        r = cr + 128
      } else {
        r = Y + 2 * (1 - kr) * cr
        b = Y + 2 * (1 - kb) * cb
        g = (Y - kr * r - kb * b) / kg
      }
      const d = (y * width + x) * 4
      out[d] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5
      out[d + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5
      out[d + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5
      out[d + 3] = 255
    }
  }
  return out
}

const FRAME_MATRICES: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 }

/** The colour of a frame's samples: its own range tag wins, the file's matrix wins. */
export function frameColor(frame: { colorSpace?: { fullRange?: boolean | null; matrix?: string | null } | null }, file: VideoColor): VideoColor {
  const space = frame.colorSpace
  const tagged = space?.matrix ? FRAME_MATRICES[space.matrix] : undefined
  return {
    matrix: file.matrix >= 0 ? file.matrix : (tagged ?? 6),
    fullRange: typeof space?.fullRange === 'boolean' ? space.fullRange : file.fullRange
  }
}

async function frameToBytes(frame: VideoFrame, color: VideoColor, plane: 'rgba' | 'luma'): Promise<Uint8Array> {
  const rect = frame.visibleRect
  const width = rect?.width ?? frame.displayWidth
  const height = rect?.height ?? frame.displayHeight
  const format = frame.format
  if (format && PLANAR.has(format)) {
    const buffer = new Uint8Array(frame.allocationSize())
    const layout = await frame.copyTo(buffer)
    return yuvToRgba(format, width, height, buffer, layout, frameColor(frame, color), plane)
  }
  // Formats without a plain plane layout (some hardware frames): let the canvas convert.
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new ImageError('no-decoder', 'canvas')
  ctx.drawImage(frame, 0, 0, width, height)
  const rgba = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)
  if (plane === 'rgba') return rgba
  const luma = new Uint8Array(width * height)
  for (let i = 0; i < luma.length; i++) luma[i] = rgba[i * 4]
  return luma
}

export function webCodecsDecoder(): VideoImageDecoder | undefined {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return undefined
  return {
    async supported(codec, description) {
      try {
        const result = await VideoDecoder.isConfigSupported({ codec, description: description as Uint8Array<ArrayBuffer> })
        return !!result.supported
      } catch {
        return false
      }
    },
    async decode(codec, description, images: readonly CodedImage[], color, plane) {
      const out: Uint8Array[] = new Array(images.length)
      // Small batches: hardware decoders hold only a few frames until they are closed.
      const batch = 6
      for (let start = 0; start < images.length; start += batch) {
        const pending: Promise<void>[] = []
        let failure: unknown = null
        const decoder = new VideoDecoder({
          output: (frame) => {
            const index = Math.round(frame.timestamp)
            pending.push(
              frameToBytes(frame, color, plane)
                .then((bytes) => {
                  out[index] = bytes
                })
                .catch((e) => {
                  failure = e
                })
                .finally(() => frame.close())
            )
          },
          error: (e) => {
            failure = e
          }
        })
        decoder.configure({ codec, description: description as Uint8Array<ArrayBuffer>, optimizeForLatency: true })
        for (let i = start; i < Math.min(images.length, start + batch); i++) {
          decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data: images[i].data as Uint8Array<ArrayBuffer> }))
        }
        try {
          await decoder.flush()
        } catch (e) {
          failure ??= e
        }
        await Promise.all(pending)
        if (decoder.state !== 'closed') decoder.close()
        if (failure) throw new ImageError('decode-failed', `HEVC: ${failure instanceof Error ? failure.message : String(failure)}`)
      }
      for (let i = 0; i < out.length; i++) if (!out[i]) throw new ImageError('decode-failed', `HEVC tile ${i + 1}`)
      return out
    }
  }
}
