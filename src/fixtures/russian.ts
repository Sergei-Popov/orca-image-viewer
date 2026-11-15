// The Russian details of a document, checked for English words the readers wrote and the tables
// missed. Codes, format names and text from the file are allowed.

import type { DocDesc, InfoItem } from '../core/model'
import { infoValue, isFileText, stringsFor } from '../i18n'

/** Names that stay as they are in Russian: formats, codecs, colour models, units. */
const NAMES = new Set(['YCbCr', 'sRGB', 'BigTIFF', 'PackBits', 'Deflate', 'Zstandard', 'WebP', 'Lab', 'Bump', 'px', 'ppi', 'dpi'])

/** `key: value` for each Russian detail value that still holds an English word. */
export function englishLeft(desc: DocDesc, allowed: string[] = []): string[] {
  const ru = stringsFor('ru')
  const items: InfoItem[] = []
  for (const s of desc.info) for (const i of s.items) if (!s.raw || i.term) items.push(i)
  for (const im of desc.images) items.push(...im.info)
  const out: string[] = []
  for (const i of items) {
    if (isFileText(i.key) || i.mono) continue
    const value = infoValue(ru, i.key, i.value)
    const words = (value.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []).filter(
      // Codes: capitals and digits (RGB, LZW, BC7_UNORM, II, v2).
      (w) => !/^[A-Z0-9_]+$/.test(w) && !/^v\d/.test(w) && !NAMES.has(w) && !allowed.includes(w)
    )
    if (words.length) out.push(`${i.key}: ${value}`)
  }
  return out
}
