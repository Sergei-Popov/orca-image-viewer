// Picks the decoder by the file's bytes (the file type only breaks ties: TGA has no signature, and
// RAW files are TIFFs) and opens the document.

import { isRadiance, openRadiance } from '../formats/hdr'
import { openHeif } from '../formats/heif'
import { isJpegXl, nativeType, openNative } from '../formats/native'
import { isQoi, openQoi } from '../formats/qoi'
import { looksLikeTga, openTga } from '../formats/tga'
import { openTiff } from '../formats/tiff'
import { latin1, startsWith } from './bytes'
import { ImageError } from './errors'
import type { Decoded, Platform } from './model'

export type FormatKey = 'tiff' | 'raw' | 'psd' | 'exr' | 'hdr' | 'tga' | 'dds' | 'qoi' | 'icns' | 'heif' | 'native'

const RAW_TYPES = new Set(['dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'rw2', 'orf', 'pef', 'srw'])

export function isRawType(fileType: string | undefined): boolean {
  return RAW_TYPES.has((fileType ?? '').toLowerCase().replace(/^\./, ''))
}

function isText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 1024)
  if (n === 0) return false
  let printable = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2) printable++
    else if (b === 0) return false
  }
  return printable / n > 0.97
}

export function detect(bytes: Uint8Array, fileType?: string): FormatKey | null {
  const type = (fileType ?? '').toLowerCase().replace(/^\./, '')
  const head = latin1(bytes.subarray(0, 16))
  if (head.startsWith('II') || head.startsWith('MM')) {
    const m = bytes.length > 4 ? (head.startsWith('II') ? bytes[2] | (bytes[3] << 8) : (bytes[2] << 8) | bytes[3]) : 0
    if (m === 42 || m === 43) return isRawType(type) ? 'raw' : 'tiff'
    if (m === 0x4f52 || m === 0x5352 || m === 0x55 || head.startsWith('MMOR')) return 'raw'
  }
  if (head.startsWith('FUJIFILMCCD-RAW')) return 'raw'
  if (head.startsWith('8BPS')) return 'psd'
  if (startsWith(bytes, [0x76, 0x2f, 0x31, 0x01])) return 'exr'
  if (head.startsWith('DDS ')) return 'dds'
  if (head.startsWith('icns')) return 'icns'
  if (isQoi(bytes)) return 'qoi'
  if (head.startsWith('#?') && isRadiance(bytes)) return 'hdr'
  if (head.slice(4, 8) === 'ftyp') {
    const brands = latin1(bytes.subarray(8, Math.min(bytes.length, 64)))
    if (/crx /.test(brands)) return 'raw'
    if (/he[ivx][cxms]|hevc|hevx|mif1|msf1|heim|heis/.test(brands) && !/^avi[fs]/.test(brands)) return 'heif'
  }
  if (nativeType(bytes)) return 'native'
  if ((type === 'tga' || type === 'icb' || type === 'vda' || type === 'vst') && looksLikeTga(bytes)) return 'tga'
  return null
}

export async function openDocument(bytes: Uint8Array, fileType: string | undefined, platform: Platform): Promise<Decoded> {
  if (bytes.length === 0) throw new ImageError('empty')
  const format = detect(bytes, fileType)
  switch (format) {
    case 'qoi':
      return openQoi(bytes)
    case 'tga':
      return openTga(bytes)
    case 'hdr':
      return openRadiance(bytes)
    case 'heif':
      return openHeif(bytes, platform)
    case 'tiff':
      return openTiff(bytes, platform)
    case 'native': {
      const n = nativeType(bytes)
      if (n) return openNative(bytes, n.mime, n.name, platform)
      break
    }
  }
  if (isJpegXl(bytes)) throw new ImageError('unsupported-feature', 'JPEG XL')
  if (isText(bytes)) throw new ImageError('text-file')
  throw new ImageError('unknown-format', (fileType ?? '').toUpperCase())
}
