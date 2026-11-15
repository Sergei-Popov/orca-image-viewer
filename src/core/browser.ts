// Platform services in a browser (the editor frame or its worker): DEFLATE by DecompressionStream,
// JPEG and PNG by createImageBitmap, HEVC by WebCodecs.

import { ImageError } from './errors'
import { inflate } from './inflate'
import type { Platform } from './model'
import { webCodecsDecoder } from './video'

async function decodeImage(data: Uint8Array, mime: string): Promise<{ width: number; height: number; data: Uint8Array }> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') throw new ImageError('no-decoder', mime)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }), { premultiplyAlpha: 'none' })
  } catch {
    throw new ImageError('decode-failed', mime.replace('image/', '').toUpperCase())
  }
  const { width, height } = bitmap
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new ImageError('no-decoder', 'canvas')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const pixels = ctx.getImageData(0, 0, width, height)
  return { width, height, data: new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength) }
}

export function browserPlatform(): Platform {
  return { inflate, decodeImage, decodeVideo: webCodecsDecoder() }
}
