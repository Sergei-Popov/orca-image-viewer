// Images the browser decodes itself (JPEG, PNG, GIF, WebP, BMP, AVIF) that arrive under one of
// this plugin's file types — a JPEG saved as .tif, say. Shown as they are, with JPEG metadata.

import { latin1, startsWith } from '../core/bytes'
import { ImageError } from '../core/errors'
import type { Decoded, InfoItem, InfoSection, Platform } from '../core/model'
import { raster } from '../core/model'
import { exifFromBlock } from '../meta/exif'
import { iccItems, readIcc } from '../meta/icc'
import { xmpSection } from '../meta/xmp'
import { jpegInfo, SOF_NAMES } from './jpeg'

export function nativeType(bytes: Uint8Array): { mime: string; name: string } | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', name: 'JPEG' }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', name: 'PNG' }
  if (startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a')) return { mime: 'image/gif', name: 'GIF' }
  if (startsWith(bytes, 'RIFF') && latin1(bytes.subarray(8, 12)) === 'WEBP') return { mime: 'image/webp', name: 'WebP' }
  if (startsWith(bytes, 'BM') && bytes.length > 26) return { mime: 'image/bmp', name: 'BMP' }
  if (latin1(bytes.subarray(4, 8)) === 'ftyp' && /avi[fs]/.test(latin1(bytes.subarray(8, 32)))) return { mime: 'image/avif', name: 'AVIF' }
  return null
}

export function isJpegXl(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0x0a]) || startsWith(bytes, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
}

/** Metadata sections of a JPEG stream (EXIF, ICC, XMP) and its frame details. */
export function jpegSections(bytes: Uint8Array): { items: InfoItem[]; sections: InfoSection[]; orientation: number } {
  const info = jpegInfo(bytes, 0, false)
  const items: InfoItem[] = []
  const sections: InfoSection[] = []
  let orientation = 1
  if (!info) return { items, sections, orientation }
  items.push({ key: 'compression', value: `JPEG, ${SOF_NAMES[info.sof] ?? `SOF${info.sof}`}` })
  items.push({ key: 'bitDepth', value: String(info.precision) })
  items.push({ key: 'channels', value: info.components === 1 ? 'Grey' : info.components === 4 ? 'CMYK' : 'YCbCr' })
  if (info.icc) items.push(...iccItems(readIcc(info.icc)))
  if (info.exif) {
    const exif = exifFromBlock(info.exif)
    if (exif) {
      sections.push(...exif.sections)
      orientation = exif.orientation
    }
  }
  if (info.xmp) {
    const x = xmpSection(info.xmp)
    if (x) sections.push(x)
  }
  return { items, sections, orientation }
}

export async function openNative(bytes: Uint8Array, mime: string, name: string, platform: Platform): Promise<Decoded> {
  if (!platform.decodeImage) throw new ImageError('no-decoder', name)
  const img = await platform.decodeImage(bytes, mime)
  const r = raster(img.width, img.height, 4, 'u8', img.data)
  const meta = mime === 'image/jpeg' ? jpegSections(bytes) : { items: [], sections: [], orientation: 1 }
  return {
    desc: {
      format: name,
      images: [{ id: 0, width: img.width, height: img.height, at: [], label: `${img.width}×${img.height}`, info: [] }],
      axes: [],
      primary: 0,
      info: [
        { title: 'image', items: [{ key: 'dimensions', value: `${img.width} × ${img.height}` }, ...meta.items] },
        ...meta.sections
      ],
      notices: []
    },
    decode: async () => r
  }
}
