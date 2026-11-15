// ICC colour profiles: the description, colour space, class, version and copyright, from the
// header and the `desc`/`cprt` tags (v2 `desc`/`text` and v4 `mluc` types).

import { fourcc, latin1, Reader } from '../core/bytes'
import type { InfoItem } from '../core/model'

export interface IccInfo {
  description: string
  colorSpace: string
  profileClass: string
  version: string
  copyright: string
  size: number
}

const CLASSES: Record<string, string> = {
  mntr: 'Display',
  scnr: 'Input',
  prtr: 'Output',
  link: 'Device link',
  spac: 'Color space',
  abst: 'Abstract',
  nmcl: 'Named color'
}

function tagText(bytes: Uint8Array, at: number, size: number): string {
  const type = fourcc(bytes, at)
  const r = new Reader(bytes, false)
  try {
    if (type === 'desc') {
      r.seek(at + 8)
      const n = r.u32()
      return latin1(r.take(Math.min(n, size - 12))).replace(/\0+$/, '').trim()
    }
    if (type === 'text') {
      return latin1(bytes.subarray(at + 8, at + size)).replace(/\0+$/, '').trim()
    }
    if (type === 'mluc') {
      r.seek(at + 8)
      const count = r.u32()
      const recordSize = r.u32()
      let best = ''
      for (let i = 0; i < Math.min(count, 64); i++) {
        r.seek(at + 16 + i * recordSize)
        const lang = latin1(r.take(2))
        r.skip(2)
        const length = r.u32()
        const offset = r.u32()
        const s = new TextDecoder('utf-16be').decode(bytes.subarray(at + offset, at + offset + length)).replace(/\0+$/, '').trim()
        if (!best || lang === 'en') best = s
        if (lang === 'en') break
      }
      return best
    }
  } catch {
    return ''
  }
  return ''
}

export function readIcc(bytes: Uint8Array): IccInfo | null {
  if (bytes.length < 132 || fourcc(bytes, 36) !== 'acsp') return null
  const r = new Reader(bytes, false)
  const info: IccInfo = {
    description: '',
    colorSpace: fourcc(bytes, 16).trim(),
    profileClass: CLASSES[fourcc(bytes, 12)] ?? fourcc(bytes, 12),
    version: `${bytes[8]}.${bytes[9] >> 4}`,
    copyright: '',
    size: bytes.length
  }
  try {
    r.seek(128)
    const count = Math.min(r.u32(), 256)
    for (let i = 0; i < count; i++) {
      const sig = r.ascii(4)
      const offset = r.u32()
      const size = r.u32()
      if (offset + size > bytes.length) continue
      if (sig === 'desc') info.description = tagText(bytes, offset, size)
      else if (sig === 'cprt') info.copyright = tagText(bytes, offset, size)
    }
  } catch {
    // A short tag table: keep the header fields.
  }
  return info
}

export function iccItems(icc: IccInfo | null): InfoItem[] {
  if (!icc) return []
  const items: InfoItem[] = [{ key: 'iccProfile', value: icc.description || '—' }]
  items.push({ key: 'iccDetails', value: `${icc.colorSpace} · ${icc.profileClass} · v${icc.version}` })
  if (icc.copyright) items.push({ key: 'copyright', value: icc.copyright })
  return items
}
