// OpenEXR: single- and multi-part files, scanline and tiled images (with mip and rip levels), half,
// float and uint channels, layers named by prefix (`diffuse.R`), luminance/chroma images, and the
// NONE, RLE, ZIPS, ZIP, PIZ, PXR24, B44 and B44A compressions. Deep images and DWA are reported as
// unsupported. Values are scene-linear; the viewer applies exposure and a tone map.

import { b44Decode, type BlockChannel, exrRleDecode, exrUnpredict, pxr24Decode } from '../codecs/exr-misc'
import { lumaWeights, ycaToRgb } from '../codecs/exr-yca'
import { pizDecode } from '../codecs/exr-piz'
import { latin1, Reader } from '../core/bytes'
import { checkSize, damaged, ImageError, unsupportedCompression, unsupportedFeature } from '../core/errors'
import { halfTable } from '../core/half'
import type { Axis, Decoded, ImageDesc, InfoItem, InfoSection, Notice, Platform, Raster, SampleKind } from '../core/model'
import { allocate, raster } from '../core/model'
import { valueRange } from '../core/pixels'

export const EXR_COMPRESSION = ['None', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K256', 'HTJ2K32', 'LJ2K', 'ZSTD']
const LINES_PER_BLOCK = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256, 256]
const PIXEL_TYPE = ['uint', 'half', 'float']
const PIXEL_SIZE = [4, 2, 4]

export interface ExrChannel {
  name: string
  type: number
  pLinear: boolean
  xs: number
  ys: number
}

interface Tiles {
  w: number
  h: number
  mode: number
  roundUp: boolean
}

interface Part {
  index: number
  name: string
  kind: string
  channels: ExrChannel[]
  compression: number
  dataWindow: [number, number, number, number]
  displayWindow: [number, number, number, number] | null
  lineOrder: number
  tiles: Tiles | null
  chunkCount: number
  offsets: number[]
  attrs: InfoItem[]
  /** Red, green, blue and white x, y, when the header has them. */
  chromaticities: number[] | null
}

interface Level {
  lx: number
  ly: number
  width: number
  height: number
}

/** What one shown image takes from a part: up to 3 colour channels and alpha. */
interface View {
  label: string
  colour: (ExrChannel | null)[]
  alpha: ExrChannel | null
  /** Luminance (Y) with optional RY/BY chroma: converted to RGB. */
  yc: { y: ExrChannel; ry: ExrChannel | null; by: ExrChannel | null } | null
  data: boolean
}

function numSamples(s: number, a: number, b: number): number {
  const lo = Math.floor(a / s) * s === a ? a / s : Math.floor(a / s) + 1
  const hi = Math.floor(b / s)
  return Math.max(0, hi - lo + 1)
}

const mod = (a: number, b: number) => ((a % b) + b) % b

function attrValue(r: Reader, type: string, size: number, start: number): { text: string; value: unknown } {
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000))
  switch (type) {
    case 'int':
      return { text: String(r.i32()), value: null }
    case 'float': {
      const v = r.f32()
      return { text: fmt(v), value: v }
    }
    case 'double':
      return { text: fmt(r.f64()), value: null }
    case 'string': {
      const v = new TextDecoder().decode(r.take(size))
      return { text: v, value: v }
    }
    case 'box2i': {
      const v = [r.i32(), r.i32(), r.i32(), r.i32()]
      return { text: `(${v[0]}, ${v[1]}) – (${v[2]}, ${v[3]}), ${v[2] - v[0] + 1} × ${v[3] - v[1] + 1}`, value: v }
    }
    case 'box2f': {
      const v = [r.f32(), r.f32(), r.f32(), r.f32()]
      return { text: `(${fmt(v[0])}, ${fmt(v[1])}) – (${fmt(v[2])}, ${fmt(v[3])})`, value: v }
    }
    case 'v2i':
      return { text: `${r.i32()}, ${r.i32()}`, value: null }
    case 'v2f':
      return { text: `${fmt(r.f32())}, ${fmt(r.f32())}`, value: null }
    case 'v3i':
      return { text: `${r.i32()}, ${r.i32()}, ${r.i32()}`, value: null }
    case 'v3f':
      return { text: `${fmt(r.f32())}, ${fmt(r.f32())}, ${fmt(r.f32())}`, value: null }
    case 'compression': {
      const v = r.u8()
      return { text: EXR_COMPRESSION[v] ?? `code ${v}`, value: v }
    }
    case 'lineOrder': {
      const v = r.u8()
      return { text: ['Increasing Y', 'Decreasing Y', 'Random Y'][v] ?? String(v), value: v }
    }
    case 'envmap': {
      const v = r.u8()
      return { text: ['Latitude-longitude', 'Cube'][v] ?? String(v), value: v }
    }
    case 'tiledesc': {
      const w = r.u32()
      const h = r.u32()
      const mode = r.u8()
      const tiles: Tiles = { w, h, mode: mode & 15, roundUp: (mode & 16) !== 0 }
      const levels = ['one level', 'mipmap', 'ripmap'][tiles.mode] ?? `mode ${tiles.mode}`
      return { text: `${w} × ${h}, ${levels}${tiles.mode ? `, rounding ${tiles.roundUp ? 'up' : 'down'}` : ''}`, value: tiles }
    }
    case 'chromaticities': {
      const v = Array.from({ length: 8 }, () => r.f32())
      return { text: `R ${fmt(v[0])}, ${fmt(v[1])} · G ${fmt(v[2])}, ${fmt(v[3])} · B ${fmt(v[4])}, ${fmt(v[5])} · W ${fmt(v[6])}, ${fmt(v[7])}`, value: v }
    }
    case 'rational': {
      const n = r.i32()
      const d = r.u32()
      return { text: d ? `${n}/${d}` : String(n), value: null }
    }
    case 'stringvector': {
      const items: string[] = []
      while (r.pos < start + size) {
        const n = r.i32()
        items.push(new TextDecoder().decode(r.take(n)))
      }
      return { text: items.join(', '), value: items }
    }
    case 'chlist': {
      const channels: ExrChannel[] = []
      while (r.pos < start + size) {
        const name = r.cstring(256)
        if (!name) break
        const type = r.i32()
        const pLinear = r.u8() !== 0
        r.skip(3)
        const xs = r.i32()
        const ys = r.i32()
        if (type < 0 || type > 2 || xs < 1 || ys < 1) throw damaged('EXR channel list')
        channels.push({ name, type, pLinear, xs, ys })
      }
      const text = channels.map((c) => `${c.name} (${PIXEL_TYPE[c.type]}${c.xs > 1 || c.ys > 1 ? `, ${c.xs}×${c.ys} sampling` : ''})`).join(', ')
      return { text, value: channels }
    }
    case 'preview': {
      const w = r.u32()
      const h = r.u32()
      return { text: `${w} × ${h}`, value: null }
    }
    case 'm33f':
    case 'm44f':
      return { text: `${type === 'm33f' ? '3' : '4'}×${type === 'm33f' ? '3' : '4'} matrix`, value: null }
    case 'timecode':
      return { text: `0x${r.u32().toString(16).padStart(8, '0')}`, value: null }
    default:
      return { text: `${type}, ${size} bytes`, value: null }
  }
}

function levelCount(size: number, roundUp: boolean): number {
  let n = 1
  let s = size
  while (s > 1) {
    s = roundUp ? Math.ceil(s / 2) : Math.floor(s / 2)
    n++
  }
  return n
}

function levelSize(size: number, l: number, roundUp: boolean): number {
  const v = roundUp ? Math.ceil(size / 2 ** l) : Math.floor(size / 2 ** l)
  return Math.max(1, v)
}

function levelsOf(part: Part): Level[] {
  const [x0, y0, x1, y1] = part.dataWindow
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const t = part.tiles
  if (!t || t.mode === 0) return [{ lx: 0, ly: 0, width: w, height: h }]
  if (t.mode === 1) {
    const n = levelCount(Math.max(w, h), t.roundUp)
    return Array.from({ length: n }, (_, l) => ({ lx: l, ly: l, width: levelSize(w, l, t.roundUp), height: levelSize(h, l, t.roundUp) }))
  }
  const nx = levelCount(w, t.roundUp)
  const ny = levelCount(h, t.roundUp)
  const out: Level[] = []
  for (let ly = 0; ly < ny; ly++) for (let lx = 0; lx < nx; lx++) out.push({ lx, ly, width: levelSize(w, lx, t.roundUp), height: levelSize(h, ly, t.roundUp) })
  return out
}

function chunkCountOf(part: Part): number {
  const [, y0, , y1] = part.dataWindow
  const t = part.tiles
  if (!t) return Math.ceil((y1 - y0 + 1) / (LINES_PER_BLOCK[part.compression] ?? 1))
  let n = 0
  for (const l of levelsOf(part)) n += Math.ceil(l.width / t.w) * Math.ceil(l.height / t.h)
  return n
}

/** The chunks of one level in the offset table: levels in order, tiles row by row. */
function levelChunks(part: Part, level: Level): [number, number] {
  const t = part.tiles
  if (!t) return [0, part.offsets.length]
  let start = 0
  for (const l of levelsOf(part)) {
    const n = Math.ceil(l.width / t.w) * Math.ceil(l.height / t.h)
    if (l.lx === level.lx && l.ly === level.ly) return [start, n]
    start += n
  }
  return [0, 0]
}

/** Groups channels into shown images: `RGBA`, `diffuse`, `Z`… */
export function viewsOf(channels: readonly ExrChannel[]): View[] {
  const groups = new Map<string, ExrChannel[]>()
  for (const c of channels) {
    const dot = c.name.lastIndexOf('.')
    const prefix = dot >= 0 ? c.name.slice(0, dot) : ''
    const list = groups.get(prefix) ?? []
    list.push(c)
    groups.set(prefix, list)
  }
  const views: View[] = []
  for (const [prefix, list] of groups) {
    const used = new Set<ExrChannel>()
    const find = (...names: string[]) => list.find((c) => names.includes(c.name.slice(c.name.lastIndexOf('.') + 1)) && !used.has(c)) ?? null
    const take = (c: ExrChannel | null) => {
      if (c) used.add(c)
      return c
    }
    const name = (fallback: string) => (prefix ? prefix : fallback)
    const r = find('R', 'r', 'red')
    const g = find('G', 'g', 'green')
    const b = find('B', 'b', 'blue')
    if (r || g || b) {
      const colour = [take(r), take(g), take(b)]
      const alpha = take(find('A', 'a', 'alpha'))
      views.push({ label: name(colour.map((c) => (c ? c.name : '')).join('') + (alpha ? 'A' : '')), colour, alpha, yc: null, data: false })
    }
    const y = find('Y')
    if (y && !(find('X') && find('Z'))) {
      const ry = take(find('RY'))
      const by = take(find('BY'))
      take(y)
      const alpha = used.has(find('A') as ExrChannel) ? null : take(find('A', 'a', 'alpha'))
      views.push({ label: name(ry || by ? 'Y RY BY' : 'Y'), colour: [y], alpha, yc: ry && by ? { y, ry, by } : null, data: false })
    }
    const x = find('X', 'x', 'U', 'u')
    const yy = find('Y', 'y', 'V', 'v')
    const z = find('Z', 'z', 'W', 'w')
    if (x && yy && z) {
      views.push({ label: name('XYZ'), colour: [take(x), take(yy), take(z)], alpha: null, yc: null, data: true })
    }
    for (const c of list) {
      if (used.has(c)) continue
      used.add(c)
      views.push({ label: c.name, colour: [c], alpha: null, yc: null, data: true })
    }
  }
  return views
}

export async function openExr(bytes: Uint8Array, platform: Platform): Promise<Decoded> {
  const r = new Reader(bytes, true)
  if (r.u32() !== 0x01312f76) throw damaged('EXR signature')
  const version = r.u32()
  if ((version & 0xff) !== 2) throw unsupportedFeature(`OpenEXR version ${version & 0xff}`)
  const singleTiled = (version & 0x200) !== 0
  const deepFlag = (version & 0x800) !== 0
  const multipart = (version & 0x1000) !== 0

  const parts: Part[] = []
  for (;;) {
    if (multipart && bytes[r.pos] === 0) {
      r.skip(1)
      break
    }
    const attrs: InfoItem[] = []
    const values = new Map<string, unknown>()
    for (;;) {
      const name = r.cstring(256)
      if (!name) break
      const type = r.cstring(256)
      const size = r.i32()
      if (size < 0 || size > r.left) throw damaged(`EXR attribute ${name}`)
      const start = r.pos
      try {
        const { text, value } = attrValue(new Reader(bytes.subarray(0, start + size), true, start), type, size, start)
        if (value !== null) values.set(name, value)
        if (type === 'int') values.set(name, new DataView(bytes.buffer, bytes.byteOffset + start, 4).getInt32(0, true))
        // String attributes are the file's text; the others are written by the reader.
        const term = type !== 'string' && type !== 'stringvector'
        if (name !== 'channels') attrs.push({ key: name, value: text.slice(0, 600), term })
        else attrs.unshift({ key: name, value: text, term })
      } catch (error) {
        if (name === 'channels' || name === 'dataWindow') throw error
        attrs.push({ key: name, value: `${type} (unreadable)`, term: true })
      }
      r.seek(start + size)
    }
    const channels = (values.get('channels') as ExrChannel[] | undefined) ?? []
    const dw = values.get('dataWindow') as [number, number, number, number] | undefined
    if (!dw) throw damaged('EXR data window')
    if (dw[2] < dw[0] || dw[3] < dw[1]) throw damaged('EXR data window')
    const type = (values.get('type') as string | undefined) ?? (singleTiled ? 'tiledimage' : deepFlag ? 'deepscanline' : 'scanlineimage')
    const tiles = (values.get('tiles') as Tiles | undefined) ?? null
    parts.push({
      index: parts.length,
      name: (values.get('name') as string | undefined) ?? '',
      kind: type,
      channels,
      compression: (values.get('compression') as number | undefined) ?? 0,
      dataWindow: dw,
      displayWindow: (values.get('displayWindow') as [number, number, number, number] | undefined) ?? null,
      lineOrder: (values.get('lineOrder') as number | undefined) ?? 0,
      tiles: type.includes('tile') ? tiles : null,
      chunkCount: (values.get('chunkCount') as number | undefined) ?? 0,
      offsets: [],
      attrs,
      chromaticities: (values.get('chromaticities') as number[] | undefined) ?? null
    })
    if (!multipart) break
    if (parts.length > 1000) throw damaged('EXR part count')
  }
  if (!parts.length) throw damaged('EXR header')

  // Offset tables, one per part, all before the first chunk: their total length must fit in the
  // file (chunkCount comes from the header, and a damaged one must not allocate millions of zeros).
  const counts = parts.map((part) => part.chunkCount || chunkCountOf(part))
  const total = counts.reduce((a, n) => a + n, 0)
  if (counts.some((n) => n > 1 << 24) || total * 8 > r.left) throw damaged('EXR chunk count')
  parts.forEach((part, k) => {
    for (let i = 0; i < counts[k]; i++) part.offsets.push(r.u64())
  })
  const tableEnd = r.pos
  // A damaged table: find the chunks by walking them from the end of the tables.
  if (parts.some((p) => p.offsets.some((o) => o < tableEnd || o >= bytes.length))) rebuildOffsets(bytes, parts, tableEnd, multipart)

  const notices: Notice[] = []
  if (parts.length > 1) notices.push({ code: 'exr-multipart', detail: String(parts.length) })

  // Shown images: every view of every part, at every level.
  interface Entry {
    part: Part
    view: View | null
    level: Level
    unsupported?: string
  }
  const combos: { part: Part; view: View | null; label: string; unsupported?: string }[] = []
  for (const part of parts) {
    const partLabel = part.name || (parts.length > 1 ? `Part ${part.index + 1}` : '')
    if (part.kind.startsWith('deep')) {
      combos.push({ part, view: null, label: partLabel || 'Deep image', unsupported: 'deep data' })
      continue
    }
    const views = viewsOf(part.channels)
    if (!views.length) combos.push({ part, view: null, label: partLabel || 'Empty', unsupported: 'no channels' })
    for (const view of views) combos.push({ part, view, label: partLabel ? `${partLabel} · ${view.label}` : view.label })
  }
  const entries: Entry[] = []
  const images: ImageDesc[] = []
  let maxLevels = 1
  const levelLists = combos.map((c) => (c.part.kind.startsWith('deep') ? [{ lx: 0, ly: 0, width: c.part.dataWindow[2] - c.part.dataWindow[0] + 1, height: c.part.dataWindow[3] - c.part.dataWindow[1] + 1 }] : levelsOf(c.part)))
  for (const l of levelLists) maxLevels = Math.max(maxLevels, l.length)
  const axes: Axis[] = []
  if (combos.length > 1) axes.push({ key: parts.length > 1 ? 'part' : 'layer', labels: combos.map((c) => c.label) })
  if (maxLevels > 1) {
    const ripmap = parts.some((p) => p.tiles?.mode === 2)
    axes.push({ key: 'mip', labels: Array.from({ length: maxLevels }, (_, i) => (ripmap ? `${i}` : `${i}`)) })
  }
  combos.forEach((c, ci) => {
    levelLists[ci].forEach((level, li) => {
      const at: number[] = []
      if (combos.length > 1) at.push(ci)
      if (maxLevels > 1) at.push(li)
      const id = entries.length
      const unsupported = c.unsupported ?? (c.part.compression >= 8 ? `${EXR_COMPRESSION[c.part.compression] ?? c.part.compression} compression` : undefined)
      entries.push({ part: c.part, view: c.view, level, unsupported })
      const levelText = levelLists[ci].length > 1 ? ` · ${level.lx === level.ly ? `level ${level.lx}` : `level ${level.lx}, ${level.ly}`}` : ''
      images.push({
        id,
        width: level.width,
        height: level.height,
        at,
        label: `${c.label || 'Image'}${levelText}`,
        unsupported,
        info: [{ key: 'dimensions', value: `${level.width} × ${level.height}` }]
      })
    })
  })
  // Mip labels with the first combo's sizes.
  const mipAxis = axes.find((a) => a.key === 'mip')
  if (mipAxis) {
    const longest = levelLists.reduce((a, b) => (b.length > a.length ? b : a))
    mipAxis.labels = longest.map((l, i) => `${i} · ${l.width}×${l.height}`)
  }

  // ------------------------------------------------ info

  const first = parts[0]
  const [x0, y0, x1, y1] = first.dataWindow
  const imageItems: InfoItem[] = [
    { key: 'dimensions', value: `${x1 - x0 + 1} × ${y1 - y0 + 1}` },
    { key: 'channels', value: first.channels.map((c) => c.name).join(', ') || '—' },
    { key: 'bitDepth', value: [...new Set(first.channels.map((c) => PIXEL_TYPE[c.type]))].join(', ') },
    { key: 'compression', value: EXR_COMPRESSION[first.compression] ?? String(first.compression) }
  ]
  if (first.tiles) imageItems.push({ key: 'tiles', value: `${first.tiles.w} × ${first.tiles.h}` })
  if (parts.length > 1) imageItems.push({ key: 'parts', value: String(parts.length) })
  if (first.displayWindow) {
    const d = first.displayWindow
    if (d[0] !== x0 || d[1] !== y0 || d[2] !== x1 || d[3] !== y1) imageItems.push({ key: 'displayWindow', value: `${d[2] - d[0] + 1} × ${d[3] - d[1] + 1}` })
  }
  const sections: InfoSection[] = [{ title: 'image', items: imageItems }]
  for (const part of parts) {
    sections.push({ title: parts.length > 1 ? `${part.name || `Part ${part.index + 1}`}` : 'attributes', items: part.attrs, raw: true })
  }

  // ------------------------------------------------ decoding

  async function decodeEntry(e: Entry): Promise<Raster> {
    if (e.unsupported || !e.view) {
      if (e.part.compression >= 8) throw unsupportedCompression(`${EXR_COMPRESSION[e.part.compression]} (OpenEXR)`)
      throw unsupportedFeature(e.unsupported ?? 'EXR image')
    }
    const { part, view, level } = e
    const W = level.width
    const H = level.height
    const allHalf = [...view.colour, view.alpha].every((c) => !c || c.type === 1)
    const kind: SampleKind = view.yc || view.data || !allHalf ? 'f32' : 'f16'
    const colourCount = view.yc ? 3 : view.colour.length === 1 ? 1 : 3
    const c = colourCount + (view.alpha ? 1 : 0)
    checkSize(W, H, c * (kind === 'f32' ? 4 : 2))
    const out = allocate(kind, W * H * c)
    const half = kind === 'f32' ? halfTable() : null
    // Output slot of each file channel (several when chroma is converted later).
    const slots = new Map<ExrChannel, number>()
    if (view.yc) {
      slots.set(view.yc.y, 0)
      if (view.yc.ry) slots.set(view.yc.ry, 1)
      if (view.yc.by) slots.set(view.yc.by, 2)
    } else {
      view.colour.forEach((ch, k) => ch && slots.set(ch, k))
    }
    if (view.alpha) slots.set(view.alpha, colourCount)
    // A missing alpha means opaque; half 1.0 is 0x3c00.
    if (view.alpha === null && false) out.fill(0)

    const [dx0, dy0] = part.dataWindow
    let partial = false
    const tiles = part.tiles
    const lines = LINES_PER_BLOCK[part.compression] ?? 1
    let found = 0
    let failures = 0
    let firstError: unknown = null

    const [first, count] = levelChunks(part, level)
    const work = part.offsets.slice(first, first + count).map((offset) => ({ offset }))
    const batch = 8
    for (let i = 0; i < work.length; i += batch) {
      await Promise.all(
        work.slice(i, i + batch).map(async ({ offset }) => {
          if (!offset || offset >= bytes.length) {
            partial = true
            return
          }
          try {
            const cr = new Reader(bytes, true, offset)
            if (multipart) {
              const p = cr.i32()
              if (p !== part.index) return
            }
            let bx: number, by: number, bw: number, bh: number
            if (tiles) {
              const tx = cr.i32()
              const ty = cr.i32()
              const lx = cr.i32()
              const ly = cr.i32()
              if (lx !== level.lx || ly !== level.ly) return
              bx = tx * tiles.w
              by = ty * tiles.h
              if (bx >= W || by >= H || tx < 0 || ty < 0) return
              bw = Math.min(tiles.w, W - bx)
              bh = Math.min(tiles.h, H - by)
            } else {
              const y = cr.i32()
              bx = 0
              by = y - dy0
              bw = W
              bh = Math.min(lines, H - by)
              if (by < 0 || by >= H) return
            }
            const size = cr.u32()
            const end = cr.pos + size
            if (end > bytes.length) partial = true
            const data = bytes.subarray(cr.pos, Math.min(end, bytes.length))
            found++
            // Absolute coordinates of the block, for channel subsampling.
            const ax0 = dx0 + bx
            const ay0 = dy0 + by
            const block = await decompressBlock(part, data, ax0, ay0, bw, bh, platform)
            scatter(block, part, ax0, ay0, bw, bh, bx, by)
          } catch (error) {
            if (error instanceof ImageError && (error.code === 'unsupported-compression' || error.code === 'too-large')) throw error
            failures++
            firstError ??= error
            partial = true
          }
        })
      )
    }
    if (!found || (failures && failures === found)) throw firstError instanceof ImageError ? firstError : damaged('EXR image data')

    function scatter(block: Uint8Array, p: Part, ax0: number, ay0: number, bw: number, bh: number, bx: number, by: number): void {
      const view8 = new DataView(block.buffer, block.byteOffset, block.byteLength)
      let at = 0
      for (let y = 0; y < bh; y++) {
        const ay = ay0 + y
        for (const ch of p.channels) {
          if (mod(ay, ch.ys) !== 0) continue
          const n = numSamples(ch.xs, ax0, ax0 + bw - 1)
          const size = PIXEL_SIZE[ch.type]
          const slot = slots.get(ch)
          if (slot !== undefined && at + n * size <= block.length) {
            const firstX = Math.ceil(ax0 / ch.xs) * ch.xs - ax0
            for (let k = 0; k < n; k++) {
              const pos = at + k * size
              let v: number
              if (ch.type === 1) {
                const bits = view8.getUint16(pos, true)
                v = half ? half[bits] : bits
              } else if (ch.type === 2) {
                v = view8.getFloat32(pos, true)
              } else {
                v = view8.getUint32(pos, true)
              }
              if (kind === 'f16' && ch.type !== 1) continue
              const px = bx + firstX + k * ch.xs
              for (let yy = 0; yy < ch.ys && by + y + yy < H; yy++) {
                const row = (by + y + yy) * W
                for (let xx = 0; xx < ch.xs && px + xx < W; xx++) out[(row + px + xx) * c + slot] = v
              }
            }
          }
          at += n * size
        }
      }
    }

    // Luminance and chroma to RGB as OpenEXR's RGBA interface does it, with the luminance weights
    // of the file's primaries (Rec. 709 without a chromaticities attribute).
    if (view.yc) {
      const chroma = view.yc.ry ?? view.yc.by
      ycaToRgb(out as Float32Array, W, H, c, chroma?.xs ?? 1, chroma?.ys ?? 1, dx0, dy0, lumaWeights(part.chromaticities))
    } else if (view.colour.length === 1 && !view.data && view.colour[0]?.name.endsWith('Y')) {
      // Luminance only: grey, no conversion.
    }
    // A colour view with a missing channel (only R and G): the missing one stays zero.
    const result = raster(W, H, c, kind, out, {
      color: colourCount === 3 ? 'rgb' : 'gray',
      alpha: !!view.alpha,
      premultiplied: !!view.alpha,
      transfer: view.data ? 'data' : 'linear',
      names: [...(view.yc ? ['R', 'G', 'B'] : view.colour.map((ch) => (ch ? ch.name.slice(ch.name.lastIndexOf('.') + 1) : '–'))), ...(view.alpha ? [view.alpha.name.slice(view.alpha.name.lastIndexOf('.') + 1)] : [])]
    })
    if (result.transfer === 'data') result.range = valueRange(result)
    if (partial) result.partial = true
    return result
  }

  return {
    desc: {
      format: 'OpenEXR',
      images,
      axes,
      primary: Math.max(0, images.findIndex((i) => !i.unsupported)),
      // Parts or layers with thumbnails in the side pane (at the chosen level), else the levels.
      list: axes[0]?.key,
      info: sections,
      notices
    },
    decode(id) {
      const e = entries[id]
      if (!e) return Promise.reject(damaged('EXR image'))
      return decodeEntry(e)
    }
  }
}

/** Decompresses one block into OpenEXR's uncompressed layout: lines, then channels, LE samples. */
async function decompressBlock(part: Part, data: Uint8Array, ax0: number, ay0: number, bw: number, bh: number, platform: Platform): Promise<Uint8Array> {
  const chans: BlockChannel[] = part.channels.map((ch) => ({
    nx: numSamples(ch.xs, ax0, ax0 + bw - 1),
    ny: numSamples(ch.ys, ay0, ay0 + bh - 1),
    type: ch.type,
    pLinear: ch.pLinear
  }))
  const expected = chans.reduce((s, ch) => s + ch.nx * ch.ny * PIXEL_SIZE[ch.type], 0)
  if (data.length >= expected || part.compression === 0) {
    const out = new Uint8Array(expected)
    out.set(data.subarray(0, expected))
    return out
  }
  switch (part.compression) {
    case 1:
      return exrUnpredict(exrRleDecode(data, expected))
    case 2:
    case 3:
      return exrUnpredict(await platform.inflate(data, 'deflate', expected))
    case 4: {
      const words = pizDecode(data, chans.map((ch) => ({ nx: ch.nx, ny: ch.ny, size: PIXEL_SIZE[ch.type] / 2 })))
      const planes: Uint8Array[] = []
      let at = 0
      for (const ch of chans) {
        const n = ch.nx * ch.ny * (PIXEL_SIZE[ch.type] / 2)
        const plane = new Uint8Array(n * 2)
        const view = new DataView(plane.buffer)
        for (let i = 0; i < n; i++) view.setUint16(i * 2, words[at + i], true)
        planes.push(plane)
        at += n
      }
      return planesToLayout(planes, part, chans, ay0, bh, expected)
    }
    case 5: {
      const size = chans.reduce((s, ch) => s + ch.nx * ch.ny * (ch.type === 1 ? 2 : ch.type === 2 ? 3 : 4), 0)
      const raw = await platform.inflate(data, 'deflate', size)
      return pxr24Decode(raw, chans, bh, part.channels.map((c) => c.ys), ay0)
    }
    case 6:
    case 7:
      return planesToLayout(b44Decode(data, chans), part, chans, ay0, bh, expected)
    default:
      throw unsupportedCompression(`${EXR_COMPRESSION[part.compression] ?? `code ${part.compression}`} (OpenEXR)`)
  }
}

/** Per-channel planes to the line-interleaved layout. */
function planesToLayout(planes: Uint8Array[], part: Part, chans: BlockChannel[], ay0: number, bh: number, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  const rows = planes.map(() => 0)
  let o = 0
  for (let y = 0; y < bh; y++) {
    for (let k = 0; k < chans.length; k++) {
      if (mod(ay0 + y, part.channels[k].ys) !== 0) continue
      const n = chans[k].nx * PIXEL_SIZE[chans[k].type]
      out.set(planes[k].subarray(rows[k] * n, rows[k] * n + n), o)
      rows[k]++
      o += n
    }
  }
  return out
}

/** Walks chunks from the end of the offset tables when the tables are damaged. */
function rebuildOffsets(bytes: Uint8Array, parts: Part[], start: number, multipart: boolean): void {
  const r = new Reader(bytes, true, start)
  const counters = parts.map(() => 0)
  for (const p of parts) p.offsets = p.offsets.map(() => 0)
  while (r.left >= 8) {
    const at = r.pos
    try {
      const index = multipart ? r.i32() : 0
      const part = parts[index]
      if (!part) break
      r.skip(part.tiles ? 16 : 4)
      const size = r.u32()
      if (size > r.left) break
      r.skip(size)
      if (counters[index] < part.offsets.length) part.offsets[counters[index]++] = at
    } catch {
      break
    }
  }
}

export function isExr(bytes: Uint8Array): boolean {
  return latin1(bytes.subarray(0, 4)) === 'v/1\u0001'
}
