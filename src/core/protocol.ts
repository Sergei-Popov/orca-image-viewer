// Messages between the editor and its decode worker, and the session both sides run: the worker
// runs it on its own thread; when a worker cannot start, the editor runs it in place.

import { ImageError } from './errors'
import type { Decoded, DocDesc, Platform, Raster } from './model'
import { openDocument } from './session'
import { initialTone, overview, renderRegion } from '../viewer/tone'

export type Request =
  | { id: number; type: 'open'; bytes: ArrayBuffer; fileType?: string }
  | { id: number; type: 'decode'; image: number }
  | { id: number; type: 'composite'; visible: boolean[] }
  | { id: number; type: 'thumbnail'; image: number; size: number }

export interface Thumbnail {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type Reply =
  | { id: number; ok: true; value: DocDesc | Raster | Thumbnail | null }
  | { id: number; ok: false; code: string; detail: string; message: string }

export interface SerializedError {
  code: string
  detail: string
  message: string
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof ImageError) return { code: error.code, detail: error.detail, message: error.message }
  if (error instanceof RangeError) return { code: 'too-large', detail: '', message: error.message }
  return { code: 'decode-failed', detail: '', message: error instanceof Error ? error.message : String(error) }
}

/** A small rendering of a raster with its default tone, for lists. */
export function thumbnailOf(r: Raster, size: number): Thumbnail {
  const { raster } = overview(r, size)
  const out = new Uint8ClampedArray(raster.width * raster.height * 4)
  renderRegion(raster, initialTone(r), 0, 0, raster.width, raster.height, out)
  return { width: raster.width, height: raster.height, data: out }
}

/** One open document and the requests on it. */
export class Session {
  private doc: Decoded | null = null

  constructor(private readonly platform: Platform) {}

  async handle(request: Request): Promise<DocDesc | Raster | Thumbnail | null> {
    switch (request.type) {
      case 'open':
        this.doc = await openDocument(new Uint8Array(request.bytes), request.fileType, this.platform)
        return this.doc.desc
      case 'decode':
        return this.require().decode(request.image)
      case 'composite': {
        const doc = this.require()
        if (!doc.composite) throw new ImageError('unsupported-feature', 'composite')
        return doc.composite(request.visible)
      }
      case 'thumbnail':
        return thumbnailOf(await this.require().decode(request.image), request.size)
    }
  }

  private require(): Decoded {
    if (!this.doc) throw new ImageError('decode-failed', '', 'no document')
    return this.doc
  }
}

export function transferOf(value: DocDesc | Raster | Thumbnail | null): ArrayBuffer[] {
  if (value && 'data' in value && value.data && ArrayBuffer.isView(value.data)) return [value.data.buffer as ArrayBuffer]
  return []
}
