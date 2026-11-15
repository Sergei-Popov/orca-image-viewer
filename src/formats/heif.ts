// HEIF and HEIC: the item structure (iinf, iloc, iref, iprp, idat) read here, the coded images
// (HEVC, and AV1 inside .heif) decoded by WebCodecs through the platform. Grids of tiles, identity
// and overlay derivations, clean aperture, rotation and mirroring, alpha planes, thumbnails,
// auxiliary images (depth, mattes, gain maps), EXIF, XMP and colour information.

import { fourcc, latin1, Reader, text } from '../core/bytes'
import { checkSize, damaged, ImageError } from '../core/errors'
import type { Decoded, ImageDesc, InfoItem, InfoSection, Notice, Platform, Raster, VideoColor } from '../core/model'
import { raster } from '../core/model'
import { orient } from '../core/pixels'
import { exifFromBlock } from '../meta/exif'
import { iccItems, readIcc } from '../meta/icc'
import { xmpSection } from '../meta/xmp'
import { type Box, readBoxes } from './isobmff'

export interface Extent {
  offset: number
  length: number
}

export interface Item {
  id: number
  type: string
  name: string
  hidden: boolean
  contentType: string
  method: number
  baseOffset: number
  extents: Extent[]
  /** Property boxes in association order. */
  props: Box[]
  /** References from this item, by type: `dimg` → tiles, `thmb` → master, `auxl` → master… */
  refs: Map<string, number[]>
}

export interface HeifFile {
  bytes: Uint8Array
  brands: string[]
  major: string
  primary: number
  items: Map<number, Item>
  idat: Box | null
}

function fullBox(bytes: Uint8Array, box: Box): { version: number; flags: number; r: Reader } {
  const r = new Reader(bytes.subarray(0, box.end), false, box.body)
  const v = r.u32()
  return { version: v >>> 24, flags: v & 0xffffff, r }
}

function readSized(r: Reader, size: number): number {
  if (size === 0) return 0
  if (size === 4) return r.u32()
  if (size === 8) return r.u64()
  if (size === 2) return r.u16()
  if (size === 1) return r.u8()
  throw damaged(`iloc field size ${size}`)
}

export function parseHeif(bytes: Uint8Array): HeifFile {
  const top = readBoxes(bytes, 0, bytes.length)
  const ftyp = top.find((b) => b.type === 'ftyp')
  const meta = top.find((b) => b.type === 'meta')
  if (!ftyp || !meta) throw damaged('HEIF meta box')
  const major = fourcc(bytes, ftyp.body)
  const brands: string[] = []
  for (let at = ftyp.body + 8; at + 4 <= ftyp.end; at += 4) brands.push(fourcc(bytes, at))
  const children = readBoxes(bytes, meta.body + 4, meta.end)
  const box = (type: string) => children.find((b) => b.type === type)
  const items = new Map<number, Item>()
  const item = (id: number): Item => {
    let it = items.get(id)
    if (!it) {
      it = { id, type: '', name: '', hidden: false, contentType: '', method: 0, baseOffset: 0, extents: [], props: [], refs: new Map() }
      items.set(id, it)
    }
    return it
  }

  let primary = 0
  const pitm = box('pitm')
  if (pitm) {
    const { version, r } = fullBox(bytes, pitm)
    primary = version === 0 ? r.u16() : r.u32()
  }

  const iinf = box('iinf')
  if (iinf) {
    const { version } = fullBox(bytes, iinf)
    const skip = version === 0 ? 2 : 4
    for (const infe of readBoxes(bytes, iinf.body + 4 + skip, iinf.end)) {
      if (infe.type !== 'infe') continue
      const { version: v, flags, r } = fullBox(bytes, infe)
      if (v < 2) continue
      const id = v === 2 ? r.u16() : r.u32()
      r.u16()
      const it = item(id)
      it.type = r.ascii(4)
      it.hidden = (flags & 1) !== 0
      try {
        it.name = r.cstring(1024)
        if (it.type === 'mime') it.contentType = r.cstring(1024)
      } catch {
        // Names are optional in practice.
      }
    }
  }

  const iloc = box('iloc')
  if (iloc) {
    const { version, r } = fullBox(bytes, iloc)
    const a = r.u8()
    const b = r.u8()
    const offsetSize = a >> 4
    const lengthSize = a & 15
    const baseSize = b >> 4
    const indexSize = version === 1 || version === 2 ? b & 15 : 0
    const count = version < 2 ? r.u16() : r.u32()
    for (let i = 0; i < count; i++) {
      const id = version < 2 ? r.u16() : r.u32()
      const it = item(id)
      if (version === 1 || version === 2) it.method = r.u16() & 15
      r.u16()
      it.baseOffset = readSized(r, baseSize)
      const extents = r.u16()
      for (let e = 0; e < extents; e++) {
        if (indexSize) readSized(r, indexSize)
        const offset = readSized(r, offsetSize)
        const length = readSized(r, lengthSize)
        it.extents.push({ offset, length })
      }
    }
  }

  const iref = box('iref')
  if (iref) {
    const { version } = fullBox(bytes, iref)
    for (const ref of readBoxes(bytes, iref.body + 4, iref.end)) {
      const r = new Reader(bytes.subarray(0, ref.end), false, ref.body)
      try {
        const from = version === 0 ? r.u16() : r.u32()
        const n = r.u16()
        const to: number[] = []
        for (let k = 0; k < n; k++) to.push(version === 0 ? r.u16() : r.u32())
        const it = item(from)
        it.refs.set(ref.type, [...(it.refs.get(ref.type) ?? []), ...to])
      } catch {
        // A short reference box: the others still count.
      }
    }
  }

  const iprp = box('iprp')
  if (iprp) {
    const parts = readBoxes(bytes, iprp.body, iprp.end)
    const ipco = parts.find((p) => p.type === 'ipco')
    const properties = ipco ? readBoxes(bytes, ipco.body, ipco.end) : []
    for (const ipma of parts.filter((p) => p.type === 'ipma')) {
      const { version, flags, r } = fullBox(bytes, ipma)
      const count = r.u32()
      for (let i = 0; i < count; i++) {
        const id = version < 1 ? r.u16() : r.u32()
        const n = r.u8()
        const it = item(id)
        for (let k = 0; k < n; k++) {
          const index = (flags & 1 ? r.u16() & 0x7fff : r.u8() & 0x7f) - 1
          if (index >= 0 && index < properties.length) it.props.push(properties[index])
        }
      }
    }
  }

  return { bytes, brands, major, primary, items, idat: box('idat') ?? null }
}

export function itemData(heif: HeifFile, it: Item): Uint8Array {
  const parts: Uint8Array[] = []
  let total = 0
  for (const e of it.extents) {
    let start: number
    let end: number
    if (it.method === 1) {
      if (!heif.idat) throw damaged('HEIF idat')
      start = heif.idat.body + it.baseOffset + e.offset
      end = e.length ? start + e.length : heif.idat.end
      if (end > heif.idat.end) throw damaged('HEIF item data')
    } else if (it.method === 0) {
      start = it.baseOffset + e.offset
      end = e.length ? start + e.length : heif.bytes.length
    } else {
      throw new ImageError('unsupported-feature', 'HEIF item-offset construction')
    }
    if (start < 0 || end > heif.bytes.length) throw damaged('HEIF item data past the end')
    parts.push(heif.bytes.subarray(start, end))
    total += end - start
  }
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function prop(heif: HeifFile, it: Item, type: string): Box | undefined {
  return it.props.find((p) => p.type === type)
}

export function itemSize(heif: HeifFile, it: Item): { width: number; height: number } {
  const ispe = prop(heif, it, 'ispe')
  if (!ispe) return { width: 0, height: 0 }
  const r = new Reader(heif.bytes.subarray(0, ispe.end), false, ispe.body + 4)
  return { width: r.u32(), height: r.u32() }
}

/** The size an item shows at, after clean aperture and rotation. */
export function displaySize(heif: HeifFile, it: Item): { width: number; height: number } {
  let { width, height } = itemSize(heif, it)
  for (const p of it.props) {
    if (p.type === 'clap') {
      const c = clap(heif, p, width, height)
      width = c.w
      height = c.h
    } else if (p.type === 'irot' && heif.bytes[p.body] & 1) {
      ;[width, height] = [height, width]
    }
  }
  return { width, height }
}

function clap(heif: HeifFile, p: Box, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const r = new Reader(heif.bytes.subarray(0, p.end), false, p.body)
  const frac = () => {
    const n = r.i32()
    const d = r.u32()
    return d ? n / d : 0
  }
  const w = Math.round(frac())
  const h = Math.round(frac())
  const ox = frac()
  const oy = frac()
  const x = Math.round((width - 1) / 2 + ox - (w - 1) / 2)
  const y = Math.round((height - 1) / 2 + oy - (h - 1) / 2)
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > width || y + h > height) return { x: 0, y: 0, w: width, h: height }
  return { x, y, w, h }
}

/** `hvc1.1.6.L93.B0` from an hvcC record. */
export function hevcCodec(hvcc: Uint8Array): string {
  if (hvcc.length < 13) throw damaged('hvcC')
  const space = hvcc[1] >> 6
  const tier = (hvcc[1] >> 5) & 1
  const profile = hvcc[1] & 31
  let compat = ((hvcc[2] << 24) | (hvcc[3] << 16) | (hvcc[4] << 8) | hvcc[5]) >>> 0
  let reversed = 0
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (compat & 1)
    compat >>>= 1
  }
  const constraints = Array.from(hvcc.subarray(6, 12))
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop()
  const level = hvcc[12]
  let codec = `hvc1.${['', 'A', 'B', 'C'][space]}${profile}.${(reversed >>> 0).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}`
  if (constraints.length) codec += '.' + constraints.map((c) => c.toString(16).toUpperCase()).join('.')
  return codec
}

/** `av01.0.08M.08` from an av1C record. */
export function av1Codec(av1c: Uint8Array): string {
  if (av1c.length < 4) throw damaged('av1C')
  const profile = av1c[1] >> 5
  const level = av1c[1] & 31
  const tier = av1c[2] >> 7
  const high = (av1c[2] >> 6) & 1
  const twelve = (av1c[2] >> 5) & 1
  const depth = high ? (twelve ? 12 : 10) : 8
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`
}

function colourOf(heif: HeifFile, items: Item[]): { color: VideoColor; nclx: number[] | null; icc: Uint8Array | null } {
  let nclx: number[] | null = null
  let icc: Uint8Array | null = null
  for (const it of items) {
    for (const p of it.props) {
      if (p.type !== 'colr') continue
      const kind = fourcc(heif.bytes, p.body)
      if (kind === 'nclx' && !nclx && p.body + 11 <= p.end) {
        const r = new Reader(heif.bytes.subarray(0, p.end), false, p.body + 4)
        nclx = [r.u16(), r.u16(), r.u16(), r.u8() >> 7]
      } else if ((kind === 'prof' || kind === 'rICC') && !icc) {
        icc = heif.bytes.subarray(p.body + 4, p.end)
      }
    }
  }
  // Without nclx the frame's own tags decide; unspecified (2) means the same.
  const color: VideoColor = nclx ? { matrix: nclx[2] === 2 ? -1 : nclx[2], fullRange: nclx[3] === 1 } : { matrix: -1, fullRange: true }
  return { color, nclx, icc }
}

function auxType(heif: HeifFile, it: Item): string {
  const p = prop(heif, it, 'auxC')
  if (!p) return ''
  try {
    return new Reader(heif.bytes.subarray(0, p.end), false, p.body + 4).cstring(512)
  } catch {
    return ''
  }
}

function auxLabel(type: string): string {
  if (/auxid:1$|auxiliary:alpha$/.test(type)) return 'Alpha'
  if (/auxid:2$|depth/i.test(type)) return 'Depth'
  if (/portraiteffectsmatte/i.test(type)) return 'Portrait matte'
  if (/hdrgainmap/i.test(type)) return 'HDR gain map'
  if (/skin/i.test(type)) return 'Skin matte'
  if (/hair/i.test(type)) return 'Hair matte'
  if (/teeth/i.test(type)) return 'Teeth matte'
  if (/glasses/i.test(type)) return 'Glasses matte'
  if (/sky/i.test(type)) return 'Sky matte'
  return type.split(/[:/]/).pop() || 'Auxiliary'
}

const isAlpha = (type: string) => /auxid:1$|auxiliary:alpha$/.test(type)

interface Entry {
  item: Item
  label: string
  /** Decoded as a single grey plane (depth maps, mattes). */
  luma: boolean
}

export async function openHeif(bytes: Uint8Array, platform: Platform): Promise<Decoded> {
  const heif = parseHeif(bytes)
  const items = [...heif.items.values()]
  const isImage = (it: Item) => ['hvc1', 'grid', 'iden', 'iovl', 'av01', 'jpeg', 'hvt1', 'unci', 'j2k1', 'avc1'].includes(it.type)
  // Items other images are made of, or that annotate them.
  const tiles = new Set<number>()
  const thumbs = new Map<number, number>()
  const aux = new Map<number, number>()
  for (const it of items) {
    for (const id of it.refs.get('dimg') ?? []) tiles.add(id)
    const thmb = it.refs.get('thmb')
    if (thmb?.length) thumbs.set(it.id, thmb[0])
    const auxl = it.refs.get('auxl')
    if (auxl?.length) aux.set(it.id, auxl[0])
  }
  const primary = heif.items.get(heif.primary) ?? items.find((it) => isImage(it) && !it.hidden && !tiles.has(it.id))
  if (!primary || !isImage(primary)) throw damaged('HEIF primary image')

  const entries: Entry[] = [{ item: primary, label: 'Primary image', luma: false }]
  let n = 1
  for (const it of items) {
    if (it === primary || !isImage(it) || tiles.has(it.id) || thumbs.has(it.id) || aux.has(it.id) || it.hidden) continue
    entries.push({ item: it, label: `Image ${++n}`, luma: false })
  }
  for (const [id, master] of thumbs) {
    const it = heif.items.get(id)
    if (!it || !isImage(it)) continue
    const s = displaySize(heif, it)
    entries.push({ item: it, label: `Thumbnail${master !== primary.id ? ` of ${master}` : ''} ${s.width}×${s.height}`, luma: false })
  }
  for (const [id] of aux) {
    const it = heif.items.get(id)
    if (!it || !isImage(it)) continue
    const type = auxType(heif, it)
    if (isAlpha(type)) continue
    entries.push({ item: it, label: auxLabel(type), luma: true })
  }

  const alphaOf = (master: Item): Item | undefined => {
    for (const [id, to] of aux) {
      const it = heif.items.get(id)
      if (to === master.id && it && isAlpha(auxType(heif, it))) return it
    }
    return undefined
  }

  const codedOf = (it: Item): Item[] => (it.type === 'grid' || it.type === 'iovl' || it.type === 'iden' ? (it.refs.get('dimg') ?? []).map((id) => heif.items.get(id)).filter((x): x is Item => !!x) : [it])

  // Metadata items describe the primary image.
  const sections: InfoSection[] = []
  const notices: Notice[] = []
  for (const it of items) {
    const target = it.refs.get('cdsc')
    if (!target?.includes(primary.id) && !(it.type === 'Exif' && !target)) continue
    try {
      if (it.type === 'Exif') {
        const data = itemData(heif, it)
        const offset = data.length >= 4 ? new DataView(data.buffer, data.byteOffset).getUint32(0) : 0
        const exif = exifFromBlock(data.subarray(4 + offset))
        if (exif) sections.push(...exif.sections)
      } else if (it.type === 'mime' && /xmp|rdf\+xml/i.test(it.contentType)) {
        const x = xmpSection(text(itemData(heif, it)))
        if (x) sections.push(x)
      }
    } catch {
      // Damaged metadata does not stop the image.
    }
  }

  const coded = codedOf(primary)
  const first = coded[0] ?? primary
  const { nclx, icc } = colourOf(heif, [primary, first])
  const pixi = prop(heif, first, 'pixi') ?? prop(heif, primary, 'pixi')
  const bits = pixi ? Array.from(heif.bytes.subarray(pixi.body + 5, Math.min(pixi.end, pixi.body + 5 + heif.bytes[pixi.body + 4]))) : []
  const size = displaySize(heif, primary)
  const codecBox = prop(heif, first, 'hvcC') ?? prop(heif, first, 'av1C')
  let codec = first.type
  try {
    if (codecBox?.type === 'hvcC') codec = hevcCodec(heif.bytes.subarray(codecBox.body, codecBox.end))
    else if (codecBox?.type === 'av1C') codec = av1Codec(heif.bytes.subarray(codecBox.body, codecBox.end))
  } catch {
    // Keep the item type.
  }
  const transforms: string[] = []
  for (const p of primary.props) {
    if (p.type === 'irot') transforms.push(`${(heif.bytes[p.body] & 3) * 90}°`)
  }
  const mirrored = primary.props.some((p) => p.type === 'imir')
  const imageItems: InfoItem[] = [
    { key: 'dimensions', value: `${size.width} × ${size.height}` },
    { key: 'codec', value: codec, mono: true },
    { key: 'bitDepth', value: bits.length ? bits.join(', ') : '8' },
    { key: 'channels', value: bits.length === 1 ? 'Grey' : alphaOf(primary) ? 'YCbCr + alpha' : 'YCbCr' }
  ]
  if (primary.type === 'grid') {
    const g = gridOf(heif, primary)
    const tile = coded[0] ? itemSize(heif, coded[0]) : { width: 0, height: 0 }
    imageItems.push({ key: 'grid', value: `${g.columns} × ${g.rows} tiles of ${tile.width} × ${tile.height}` })
  }
  if (transforms.length) imageItems.push({ key: 'rotation', value: transforms.join(', ') + ' CCW' })
  if (mirrored) imageItems.push({ key: 'mirror', value: 'Yes' })
  if (nclx) imageItems.push({ key: 'colorSpace', value: nclxText(nclx) })
  imageItems.push(...iccItems(icc ? readIcc(icc) : null))
  const fileItems: InfoItem[] = [
    { key: 'brands', value: [heif.major, ...heif.brands.filter((b) => b !== heif.major)].join(', '), mono: true },
    { key: 'items', value: String(items.length) }
  ]
  const thumbCount = [...thumbs.keys()].length
  if (thumbCount) fileItems.push({ key: 'thumbnails', value: String(thumbCount) })
  const auxNames = [...aux.keys()].map((id) => heif.items.get(id)).filter((x): x is Item => !!x).map((it) => auxLabel(auxType(heif, it)))
  if (auxNames.length) fileItems.push({ key: 'auxiliary', value: auxNames.join(', ') })

  const decoder = platform.decodeVideo
  const images: ImageDesc[] = entries.map((e, i) => {
    const s = displaySize(heif, e.item)
    return { id: i, width: s.width, height: s.height, at: [i], label: e.label, info: [{ key: 'type', value: e.item.type }] }
  })

  async function decodeItem(it: Item, luma: boolean, depth = 0): Promise<Raster> {
    if (depth > 4) throw damaged('HEIF derivation depth')
    let r: Raster
    if (it.type === 'grid' || it.type === 'iovl') {
      const parts = codedOf(it)
      const { width, height } = itemSize(heif, it)
      const g = it.type === 'grid' ? gridOf(heif, it) : null
      const ow = g ? g.width : width
      const oh = g ? g.height : height
      checkSize(ow, oh, 4)
      const channels = luma ? 1 : 4
      const out = new Uint8Array(ow * oh * channels)
      if (it.type === 'iovl') {
        const o = overlayOf(heif, it, parts.length)
        if (!luma) for (let i = 0; i < ow * oh; i++) out.set(o.fill, i * 4)
        for (let k = 0; k < parts.length; k++) {
          const tile = await decodeItem(parts[k], luma, depth + 1)
          blit(tile, out, ow, oh, channels, o.offsets[k][0], o.offsets[k][1])
        }
      } else if (g) {
        if (parts.length < g.rows * g.columns) throw damaged('HEIF grid tiles')
        const decodedTiles = await decodeCoded(parts.slice(0, g.rows * g.columns), luma)
        const tw = decodedTiles[0].width
        const th = decodedTiles[0].height
        for (let k = 0; k < g.rows * g.columns; k++) {
          blit(decodedTiles[k], out, ow, oh, channels, (k % g.columns) * tw, Math.floor(k / g.columns) * th)
        }
      }
      r = raster(ow, oh, channels, 'u8', out, { alpha: false, color: luma ? 'gray' : 'rgb' })
    } else if (it.type === 'iden') {
      const src = codedOf(it)[0]
      if (!src) throw damaged('HEIF identity item')
      r = await decodeItem(src, luma, depth + 1)
    } else {
      r = (await decodeCoded([it], luma))[0]
    }
    return transform(heif, it, r)
  }

  async function decodeCoded(list: Item[], luma: boolean): Promise<Raster[]> {
    const kind = list[0].type
    if (kind === 'jpeg') {
      if (!platform.decodeImage) throw new ImageError('no-decoder', 'JPEG')
      const out: Raster[] = []
      for (const it of list) {
        const img = await platform.decodeImage(itemData(heif, it), 'image/jpeg')
        out.push(raster(img.width, img.height, 4, 'u8', img.data, { alpha: false }))
      }
      return luma ? out.map(toLuma) : out
    }
    if (kind !== 'hvc1' && kind !== 'av01') {
      throw new ImageError('unsupported-compression', { unci: 'uncompressed (unci)', j2k1: 'JPEG 2000', avc1: 'H.264', hvt1: 'HEVC tile tracks' }[kind] ?? kind)
    }
    const config = prop(heif, list[0], kind === 'hvc1' ? 'hvcC' : 'av1C')
    if (!config) throw damaged(`HEIF ${kind === 'hvc1' ? 'hvcC' : 'av1C'}`)
    const description = heif.bytes.subarray(config.body, config.end)
    const codecName = kind === 'hvc1' ? hevcCodec(description) : av1Codec(description)
    if (!decoder || !(await decoder.supported(codecName, description))) {
      throw new ImageError('no-decoder', `${kind === 'hvc1' ? 'HEVC' : 'AV1'} (${codecName})`)
    }
    const sizes = list.map((it) => itemSize(heif, it))
    const color = colourOf(heif, list).color
    const data = await decoder.decode(
      codecName,
      description,
      list.map((it, i) => ({ data: itemData(heif, it), width: sizes[i].width, height: sizes[i].height })),
      color,
      luma ? 'luma' : 'rgba'
    )
    return data.map((pixels, i) => {
      const { width, height } = sizes[i]
      const channels = luma ? 1 : 4
      const w = width || Math.round(Math.sqrt(pixels.length / channels))
      const h = height || Math.floor(pixels.length / channels / w)
      return raster(w, h, channels, 'u8', pixels.subarray(0, w * h * channels), { alpha: false, color: luma ? 'gray' : 'rgb' })
    })
  }

  return {
    desc: {
      format: heif.brands.includes('heic') || heif.major === 'heic' || heif.major === 'heix' ? 'HEIC' : 'HEIF',
      images,
      axes: images.length > 1 ? [{ key: 'image', labels: images.map((i) => i.label) }] : [],
      primary: 0,
      info: [{ title: 'image', items: imageItems }, { title: 'file', items: fileItems }, ...sections],
      notices
    },
    async decode(id) {
      const e = entries[id]
      if (!e) throw damaged('HEIF image')
      let r = await decodeItem(e.item, e.luma)
      if (!e.luma && r.channels === 4) {
        const alpha = alphaOf(e.item)
        if (alpha) {
          try {
            const a = await decodeItem(alpha, true)
            if (a.width === r.width && a.height === r.height) {
              const d = r.data as Uint8Array
              const ad = a.data as Uint8Array
              for (let i = 0; i < ad.length; i++) d[i * 4 + 3] = ad[i]
              r = { ...r, alpha: true, premultiplied: (e.item.refs.get('prem') ?? []).includes(alpha.id) }
            }
          } catch (error) {
            console.warn('[image-viewer] HEIF alpha', error)
            r = { ...r, notices: [{ code: 'heic-alpha-skipped' }] }
          }
        }
        if (!r.alpha) r = dropAlpha(r)
      }
      return r
    }
  }
}

function toLuma(r: Raster): Raster {
  const out = new Uint8Array(r.width * r.height)
  for (let i = 0; i < out.length; i++) out[i] = r.data[i * r.channels]
  return raster(r.width, r.height, 1, 'u8', out, { alpha: false, color: 'gray' })
}

function dropAlpha(r: Raster): Raster {
  const out = new Uint8Array(r.width * r.height * 3)
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    out[i] = r.data[j]
    out[i + 1] = r.data[j + 1]
    out[i + 2] = r.data[j + 2]
  }
  return { ...r, channels: 3, data: out, alpha: false, names: ['R', 'G', 'B'] }
}

function blit(src: Raster, out: Uint8Array, ow: number, oh: number, channels: number, x0: number, y0: number): void {
  const c = src.channels
  for (let y = 0; y < src.height; y++) {
    const oy = y0 + y
    if (oy < 0 || oy >= oh) continue
    for (let x = 0; x < src.width; x++) {
      const ox = x0 + x
      if (ox < 0 || ox >= ow) continue
      const s = (y * src.width + x) * c
      const d = (oy * ow + ox) * channels
      for (let k = 0; k < channels; k++) out[d + k] = k < c ? src.data[s + k] : 255
    }
  }
}

export function gridOf(heif: HeifFile, it: Item): { rows: number; columns: number; width: number; height: number } {
  const data = itemData(heif, it)
  const r = new Reader(data, false)
  r.u8()
  const flags = r.u8()
  const rows = r.u8() + 1
  const columns = r.u8() + 1
  const big = flags & 1
  const width = big ? r.u32() : r.u16()
  const height = big ? r.u32() : r.u16()
  return { rows, columns, width, height }
}

function overlayOf(heif: HeifFile, it: Item, count: number): { fill: number[]; offsets: [number, number][] } {
  const r = new Reader(itemData(heif, it), false)
  r.u8()
  const big = r.u8() & 1
  const fill = [r.u16() >> 8, r.u16() >> 8, r.u16() >> 8, r.u16() >> 8]
  if (big) r.skip(8)
  else r.skip(4)
  const offsets: [number, number][] = []
  for (let k = 0; k < count; k++) offsets.push(big ? [r.i32(), r.i32()] : [r.i16(), r.i16()])
  return { fill, offsets }
}

/** Clean aperture, rotation and mirroring, in the order the item lists them. */
function transform(heif: HeifFile, it: Item, r: Raster): Raster {
  for (const p of it.props) {
    if (p.type === 'clap') {
      const c = clap(heif, p, r.width, r.height)
      if (c.w !== r.width || c.h !== r.height) r = crop(r, c.x, c.y, c.w, c.h)
    } else if (p.type === 'irot') {
      const angle = heif.bytes[p.body] & 3
      // Anticlockwise quarter turns as EXIF orientations: 90° → 8, 180° → 3, 270° → 6.
      r = orient(r, [1, 8, 3, 6][angle])
    } else if (p.type === 'imir') {
      const axis = heif.bytes[p.body] & 1
      // Axis 0 is vertical: a left–right mirror; axis 1 is horizontal: top–bottom.
      r = orient(r, axis === 0 ? 2 : 4)
    }
  }
  return r
}

function crop(r: Raster, x0: number, y0: number, w: number, h: number): Raster {
  const c = r.channels
  const out = new Uint8Array(w * h * c)
  for (let y = 0; y < h; y++) {
    out.set((r.data as Uint8Array).subarray(((y0 + y) * r.width + x0) * c, ((y0 + y) * r.width + x0 + w) * c), y * w * c)
  }
  return { ...r, width: w, height: h, data: out }
}

const PRIMARIES: Record<number, string> = { 1: 'BT.709', 5: 'BT.601 PAL', 6: 'BT.601 NTSC', 9: 'BT.2020', 12: 'Display P3' }
const TRANSFERS: Record<number, string> = { 1: 'BT.709', 8: 'Linear', 13: 'sRGB', 16: 'PQ', 18: 'HLG' }
const MATRICES: Record<number, string> = { 0: 'RGB', 1: 'BT.709', 5: 'BT.601', 6: 'BT.601', 9: 'BT.2020' }

function nclxText(n: number[]): string {
  const [p, t, m, full] = n
  return `${PRIMARIES[p] ?? `primaries ${p}`}, ${TRANSFERS[t] ?? `transfer ${t}`}, ${MATRICES[m] ?? `matrix ${m}`}, ${full ? 'full' : 'video'} range`
}

export function isHeif(bytes: Uint8Array): boolean {
  return latin1(bytes.subarray(4, 8)) === 'ftyp'
}
