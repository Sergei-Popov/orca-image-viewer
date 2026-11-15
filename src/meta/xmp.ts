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

/** Deeper nesting than this ends the scan: XMP properties sit a few levels down. */
const MAX_DEPTH = 64

interface Frame {
  name: string
  /** Where the element's content starts. */
  start: number
  /** A `prefix:Name` element other than RDF and x: syntax. */
  property: boolean
  child: boolean
  /** Holds an rdf:Alt, rdf:Seq or rdf:Bag: its list items are the value. */
  array: boolean
  /** Inside an array: read as part of it, not on its own. */
  quiet: boolean
  items: string[]
}

/**
 * Properties of the packet as `prefix:Name` → value; arrays are joined with commas. One pass over
 * the tags with a stack of open elements, so the time grows with the packet's length.
 */
export function xmpProperties(packet: string): InfoItem[] {
  const items: InfoItem[] = []
  const seen = new Set<string>()
  const add = (key: string, value: string) => {
    if (items.length >= MAX_ITEMS || !value.trim() || seen.has(key)) return
    if (key.startsWith('xmlns') || SKIP.has(key)) return
    seen.add(key)
    items.push({ key, value: unescapeXml(value.trim()).slice(0, 1000) })
  }
  // Attributes on rdf:Description (<rdf:Description xmp:Rating="5" …>) come first, then elements:
  // <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Title</rdf:li></rdf:Alt></dc:title>.
  const attributes: [string, string][] = []
  const elements: [string, string][] = []
  const stack: Frame[] = []

  const close = (name: string, at: number) => {
    let k = stack.length - 1
    while (k >= 0 && stack[k].name !== name) k--
    if (k < 0) return
    const f = stack[k]
    stack.length = k
    const text = f.child ? '' : packet.slice(f.start, at)
    if (f.name === 'rdf:li' && !f.child && !text.includes('<')) {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (!stack[j].array) continue
        if (text.trim()) stack[j].items.push(text.trim())
        break
      }
    }
    if (!f.property || f.quiet) return
    if (f.array) {
      if (f.items.length) elements.push([f.name, f.items.join(', ')])
    } else if (!f.child && !text.includes('<')) {
      elements.push([f.name, text])
    }
    // Otherwise a structure: its fields were read as they closed.
  }

  let pos = 0
  while (pos < packet.length) {
    const lt = packet.indexOf('<', pos)
    if (lt < 0) break
    const next = packet[lt + 1]
    if (next === '!' || next === '?') {
      const endMark = packet.startsWith('<!--', lt) ? '-->' : packet.startsWith('<![CDATA[', lt) ? ']]>' : next === '?' ? '?>' : '>'
      const end = packet.indexOf(endMark, lt + 2)
      if (end < 0) break
      pos = end + endMark.length
      continue
    }
    const gt = packet.indexOf('>', lt + 1)
    if (gt < 0) break
    pos = gt + 1
    if (next === '/') {
      close(packet.slice(lt + 2, gt).trim(), lt)
      continue
    }
    const selfClosing = packet[gt - 1] === '/'
    const tag = packet.slice(lt + 1, selfClosing ? gt - 1 : gt)
    const nameEnd = nameLength(tag, 0)
    if (!nameEnd) continue
    const name = tag.slice(0, nameEnd)
    const parent = stack[stack.length - 1]
    if (parent) parent.child = true
    if (name === 'rdf:Description') readAttributes(tag, nameEnd, attributes)
    if (name === 'rdf:Alt' || name === 'rdf:Seq' || name === 'rdf:Bag') {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (!stack[j].property) continue
        stack[j].array = true
        break
      }
    }
    if (selfClosing) continue
    if (stack.length >= MAX_DEPTH) break
    stack.push({
      name,
      start: gt + 1,
      property: /^[\w-]+:[\w-]+$/.test(name) && !name.startsWith('rdf:') && !name.startsWith('x:'),
      child: false,
      array: false,
      quiet: !!parent && (parent.quiet || parent.array),
      items: []
    })
  }
  for (const [key, value] of attributes) add(key, value)
  for (const [key, value] of elements) add(key, value)
  return items
}

/** The length of the XML name at `from`: letters, digits, `_ - . :`. */
function nameLength(s: string, from: number): number {
  let i = from
  while (i < s.length && /[\w.:-]/.test(s[i])) i++
  return i - from
}

/** `prefix:name="value"` attributes of a tag, in one pass. */
function readAttributes(tag: string, from: number, out: [string, string][]): void {
  let i = from
  while (i < tag.length) {
    while (i < tag.length && /\s/.test(tag[i])) i++
    const n = nameLength(tag, i)
    if (!n) {
      i++
      continue
    }
    const name = tag.slice(i, i + n)
    i += n
    while (i < tag.length && /\s/.test(tag[i])) i++
    if (tag[i] !== '=') continue
    i++
    while (i < tag.length && /\s/.test(tag[i])) i++
    const quote = tag[i]
    if (quote !== '"' && quote !== "'") continue
    const end = tag.indexOf(quote, i + 1)
    if (end < 0) return
    if (/^[\w-]+:[\w-]+$/.test(name)) out.push([name, tag.slice(i + 1, end)])
    i = end + 1
  }
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
