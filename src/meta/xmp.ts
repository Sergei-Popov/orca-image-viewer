// XMP packets: a list of the simple properties (title, creator, dates, rating, tool…) read with
// plain string matching, because the decode worker has no DOMParser, and the packet as text.

import type { InfoItem, InfoSection } from '../core/model'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[name] ?? m
  })
}

const SKIP = new Set(['rdf:about', 'xmlns', 'x:xmptk', 'rdf:parseType'])
const MAX_ITEMS = 120

/** Properties of the packet as `prefix:Name` → value; arrays are joined with commas. */
export function xmpProperties(packet: string): InfoItem[] {
  const items: InfoItem[] = []
  const seen = new Set<string>()
  const add = (key: string, value: string) => {
    if (items.length >= MAX_ITEMS || !value.trim() || seen.has(key)) return
    if (key.startsWith('xmlns') || SKIP.has(key)) return
    seen.add(key)
    items.push({ key, value: unescapeXml(value.trim()).slice(0, 1000) })
  }
  // Attributes on rdf:Description: <rdf:Description xmp:Rating="5" …>
  for (const desc of packet.matchAll(/<rdf:Description\b([^>]*)>/g)) {
    for (const attr of desc[1].matchAll(/([\w-]+:[\w-]+)\s*=\s*"([^"]*)"/g)) add(attr[1], attr[2])
  }
  // Elements: <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Title</rdf:li></rdf:Alt></dc:title>.
  // Opening tags are scanned one by one, so properties nested in x:xmpmeta, rdf:RDF and
  // structures are reached; a property read as a whole is skipped past.
  const open = /<([\w-]+:[\w-]+)((?:\s[^>]*?)?)(\/?)>/g
  for (let m = open.exec(packet); m; m = open.exec(packet)) {
    const [, name, , selfClosing] = m
    if (selfClosing || name.startsWith('rdf:') || name.startsWith('x:')) continue
    const close = packet.indexOf(`</${name}>`, open.lastIndex)
    if (close < 0) continue
    const body = packet.slice(open.lastIndex, close)
    if (/<rdf:(Alt|Seq|Bag)\b/.test(body)) {
      const values = Array.from(body.matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/g), (li) => li[1].trim()).filter(
        (v) => v && !v.includes('<')
      )
      if (values.length) add(name, values.join(', '))
      open.lastIndex = close + name.length + 3
    } else if (!body.includes('<')) {
      add(name, body)
      open.lastIndex = close + name.length + 3
    }
    // Otherwise a structure: its fields are read as the scan goes on.
  }
  return items
}

export function xmpSection(packet: string): InfoSection | null {
  const start = packet.indexOf('<x:xmpmeta')
  const clean = (start >= 0 ? packet.slice(start) : packet).replace(/<\?xpacket[^>]*\?>/g, '').trim()
  if (!clean) return null
  const end = clean.lastIndexOf('</x:xmpmeta>')
  const body = end >= 0 ? clean.slice(0, end + 12) : clean
  return { title: 'xmp', items: xmpProperties(body), raw: true, text: body.slice(0, 64 * 1024) }
}

/** The first XMP packet inside arbitrary bytes (RAW and PSD files embed it as plain text). */
export function findXmp(bytes: Uint8Array, from = 0, to = bytes.length): string | null {
  const needle = [0x3c, 0x78, 0x3a, 0x78, 0x6d, 0x70, 0x6d, 0x65, 0x74, 0x61] // <x:xmpmeta
  const end = Math.min(to, bytes.length) - needle.length
  outer: for (let i = from; i < end; i++) {
    if (bytes[i] !== 0x3c) continue
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer
    const close = '</x:xmpmeta>'
    const limit = Math.min(bytes.length, i + 4 * 1024 * 1024)
    const chunk = new TextDecoder().decode(bytes.subarray(i, limit))
    const stop = chunk.indexOf(close)
    return stop >= 0 ? chunk.slice(0, stop + close.length) : null
  }
  return null
}
