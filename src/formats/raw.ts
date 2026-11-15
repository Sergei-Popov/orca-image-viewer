// Camera RAW files: the previews the camera embedded (the largest first) and the camera's details.
// The sensor data itself is not developed. TIFF-structured RAWs (DNG, CR2, NEF, NRW, ARW, SRF, SR2,
// PEF, SRW, ORF, RW2), Canon CR3 (ISO base media) and Fujifilm RAF are read; previews are found
// through the file's own pointers and by scanning for JPEG streams, so unknown variants still work.

import { hex, latin1, startsWith } from '../core/bytes'
import { ImageError, unsupportedFeature } from '../core/errors'
import type { Decoded, ImageDesc, InfoItem, InfoSection, Platform, Raster } from '../core/model'
import { raster } from '../core/model'
import { dropAlpha, orient } from '../core/pixels'
import { exifDirs, exifFromBlock, exifSummary, type ExifSummary, genericValue } from '../meta/exif'
import { type Ifd, T, Tiff } from '../meta/ifd'
import { xmpSection } from '../meta/xmp'
import { readBoxes } from './isobmff'
import { browserDecodable, findJpegs, type JpegInfo, jpegInfo } from './jpeg'
import { COMPRESSION_NAMES, decodeIfd, isImageIfd, readImage } from './tiff'

const FORMAT_NAMES: Record<string, string> = {
  dng: 'DNG',
  cr2: 'Canon CR2',
  cr3: 'Canon CR3',
  nef: 'Nikon NEF',
  nrw: 'Nikon NRW',
  arw: 'Sony ARW',
  srf: 'Sony SRF',
  sr2: 'Sony SR2',
  raf: 'Fujifilm RAF',
  rw2: 'Panasonic RW2',
  orf: 'Olympus ORF',
  pef: 'Pentax PEF',
  srw: 'Samsung SRW'
}

const CANON_UUID = '85c0b687820f11e08111f4ce462b6a48'

/** A preview: a JPEG stream, or a small uncompressed TIFF image (NEF and DNG thumbnails). */
type Preview = { kind: 'jpeg'; info: JpegInfo; source: string; rotate: number } | { kind: 'ifd'; tiff: Tiff; ifd: Ifd; width: number; height: number; source: string; rotate: number }

const sizeOf = (p: Preview) => (p.kind === 'jpeg' ? { w: p.info.width, h: p.info.height } : { w: p.width, h: p.height })

// ---------------------------------------------------------------- maker notes

/** A few readable tags per vendor; any other text tag is listed by number. */
const MAKER_TAGS: Record<string, Record<number, string>> = {
  Canon: { 0x6: 'Image type', 0x7: 'Firmware version', 0x9: 'Owner name', 0xc: 'Serial number', 0x10: 'Model ID', 0x95: 'Lens model', 0x96: 'Internal serial number' },
  Nikon: {
    0x1: 'Maker note version',
    0x2: 'ISO',
    0x4: 'Quality',
    0x5: 'White balance',
    0x6: 'Sharpening',
    0x7: 'Focus mode',
    0x8: 'Flash setting',
    0x9: 'Flash type',
    0x1d: 'Serial number',
    0x84: 'Lens',
    0x95: 'Noise reduction',
    0xa7: 'Shutter count',
    0xab: 'Variant program'
  },
  Sony: { 0xb001: 'Model ID', 0xb020: 'Creative style' },
  Fujifilm: { 0x10: 'Internal serial number', 0x1000: 'Quality', 0x1431: 'Rating' },
  Olympus: { 0x0: 'Maker note version', 0x207: 'Camera type', 0x209: 'Camera ID' },
  // Olympus equipment directory (tag 0x2010).
  'Olympus.2010': { 0x100: 'Camera type', 0x101: 'Serial number', 0x102: 'Internal serial number', 0x202: 'Lens serial number', 0x203: 'Lens model' },
  Panasonic: { 0x2: 'Firmware version', 0x3: 'White balance', 0x25: 'Internal serial number', 0x51: 'Lens type', 0x52: 'Lens serial number' },
  Pentax: { 0x5: 'Pentax model ID', 0x8: 'Quality', 0x229: 'Serial number' },
  Samsung: { 0x2: 'Device type', 0x3: 'Model ID', 0xa001: 'Firmware name', 0xa002: 'Serial number', 0xa003: 'Lens type' }
}

/** A TIFF view of a maker note whose offsets count from the note's own start. */
function relativeTiff(note: Uint8Array, little: boolean, ifdAt: number): Tiff {
  const copy = note.slice()
  const v = new DataView(copy.buffer)
  copy[0] = copy[1] = little ? 0x49 : 0x4d
  v.setUint16(2, 42, little)
  v.setUint32(4, ifdAt, little)
  return new Tiff(copy)
}

interface MakerNote {
  vendor: string
  tiff: Tiff
  ifd: Ifd
  /** Where the note's TIFF bytes start, as an offset into the file's TIFF bytes. */
  base: number
}

function readMakerNote(tiff: Tiff, note: Uint8Array, at: number, make: string): MakerNote | null {
  const head = latin1(note.subarray(0, 16))
  const m = make.toLowerCase()
  try {
    if (head.startsWith('Nikon\0')) {
      const sub = new Tiff(note.subarray(10))
      return { vendor: 'Nikon', tiff: sub, ifd: sub.readIfd(sub.first), base: at + 10 }
    }
    if (head.startsWith('OLYMPUS\0') || head.startsWith('OM SYSTEM\0')) {
      const order = head.startsWith('OM') ? 12 : 8
      const sub = relativeTiff(note, note[order] === 0x49, order + 4)
      return { vendor: 'Olympus', tiff: sub, ifd: sub.readIfd(sub.first), base: at }
    }
    if (head.startsWith('OLYMP\0') || head.startsWith('EPSON\0')) return { vendor: 'Olympus', tiff, ifd: tiff.readIfd(at + 8), base: 0 }
    if (head.startsWith('FUJIFILM')) {
      const offset = note[8] | (note[9] << 8) | (note[10] << 16) | (note[11] << 24)
      const sub = relativeTiff(note, true, offset)
      return { vendor: 'Fujifilm', tiff: sub, ifd: sub.readIfd(sub.first), base: at }
    }
    if (head.startsWith('Panasonic\0')) return { vendor: 'Panasonic', tiff, ifd: tiff.readIfd(at + 12), base: 0 }
    if (head.startsWith('AOC\0')) {
      const sub = relativeTiff(note, note[4] === 0x49, 6)
      return { vendor: 'Pentax', tiff: sub, ifd: sub.readIfd(sub.first), base: at }
    }
    if (head.startsWith('SONY')) return { vendor: 'Sony', tiff, ifd: tiff.readIfd(at + 12), base: 0 }
    if (m.startsWith('canon')) return { vendor: 'Canon', tiff, ifd: tiff.readIfd(at), base: 0 }
    if (m.startsWith('sony')) return { vendor: 'Sony', tiff, ifd: tiff.readIfd(at), base: 0 }
    if (m.startsWith('samsung')) {
      const sub = relativeTiff(note, tiff.little, 0)
      return { vendor: 'Samsung', tiff: sub, ifd: sub.readIfd(0), base: at }
    }
    if (m.startsWith('pentax') || m.startsWith('ricoh')) return { vendor: 'Pentax', tiff, ifd: tiff.readIfd(at), base: 0 }
  } catch {
    return null
  }
  return null
}

const printable = (s: string) => s.length > 0 && s.length <= 200 && /^[\x20-\x7e -ɏ]+$/.test(s)

function makerItems(note: MakerNote): InfoItem[] {
  const items: InfoItem[] = [{ key: 'Maker', value: note.vendor }]
  const visit = (ifd: Ifd, names: Record<number, string>, depth: number) => {
    for (const e of ifd.entries.values()) {
      if (items.length >= 60) return
      const name = names[e.tag]
      try {
        // Olympus keeps its lens and body details in an equipment directory.
        if (depth === 0 && note.vendor === 'Olympus' && e.tag === 0x2010) {
          visit(note.tiff.readIfd(note.tiff.value(e)), MAKER_TAGS['Olympus.2010'], depth + 1)
          continue
        }
        if (e.type === 13 || (e.type === 7 && e.count > 8)) continue
        if (e.type === 2) {
          const s = note.tiff.string(e)
          if (printable(s) && !/^0+$/.test(s)) items.push({ key: name ?? `Tag ${hex(e.tag)}`, value: s })
          continue
        }
        if (!name) continue
        if (note.vendor === 'Nikon' && e.tag === 0x84) {
          const [a, b, c, d] = note.tiff.rationals(e, 4).map(([n, q]) => (q ? n / q : 0))
          const focal = a === b ? `${a} mm` : `${a}–${b} mm`
          items.push({ key: name, value: `${focal} f/${Math.round(c * 10) / 10}${c !== d ? `–${Math.round(d * 10) / 10}` : ''}` })
          continue
        }
        if (note.vendor === 'Nikon' && e.tag === 0x2) {
          items.push({ key: name, value: String(note.tiff.values(e, 2)[1] ?? note.tiff.value(e)) })
          continue
        }
        if (e.type === 7) {
          // Short opaque values: shown only when they are text (Nikon's "0211").
          const s = latin1(note.tiff.raw(e, 8)).replace(/\0+$/, '')
          if (printable(s)) items.push({ key: name, value: s })
          continue
        }
        const value = genericValue(note.tiff, e)
        if (!value || value.length > 120 || /bytes$/.test(value)) continue
        items.push({ key: name, value: e.tag === 0x10 && note.vendor === 'Canon' ? `0x${Number(value).toString(16)}` : value })
      } catch {
        // An unreadable tag does not hide the others.
      }
    }
  }
  visit(note.ifd, MAKER_TAGS[note.vendor] ?? {}, 0)
  return items
}

/** EXIF and maker details from an `Exif\0\0` block (Fujifilm's JPEG, Panasonic's embedded JPEG). */
function exifBlockWithMaker(block: Uint8Array): { summary: ExifSummary; maker: InfoItem[] } | null {
  const start = startsWith(block, 'Exif') ? 6 : 0
  if (!Tiff.is(block, start)) return null
  try {
    const tiff = new Tiff(block.subarray(start))
    const summary = exifSummary(tiff, exifDirs(tiff, tiff.readIfd(tiff.first)), { imageTags: false })
    const note = summary.makerNote ? readMakerNote(tiff, summary.makerNote, summary.makerNoteAt, summary.make) : null
    return { summary, maker: note ? makerItems(note) : [] }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- the document

export async function openRaw(bytes: Uint8Array, fileType: string | undefined, platform: Platform): Promise<Decoded> {
  const type = (fileType ?? '').toLowerCase().replace(/^\./, '')
  const previews = new Map<number, Preview>()
  const sections: InfoSection[] = []
  const imageItems: InfoItem[] = []
  let summary: ExifSummary | null = null
  let maker: InfoItem[] = []
  let orientation = 1
  let formatName = FORMAT_NAMES[type] ?? 'Camera RAW'
  let xmp: string | null = null

  const addJpeg = (start: number, length: number, source: string) => {
    if (start <= 0 || start >= bytes.length || previews.has(start)) return
    const limit = length > 0 ? Math.min(bytes.length, start + length + 1024) : bytes.length
    const info = jpegInfo(bytes, start, true, limit) ?? jpegInfo(bytes, start, true)
    if (!info || !browserDecodable(info) || info.width < 16 || info.height < 16) return
    previews.set(start, { kind: 'jpeg', info, source, rotate: 1 })
  }

  if (startsWith(bytes, 'FUJIFILMCCD-RAW')) {
    // Fujifilm: a header with the offset of a JPEG that carries the EXIF.
    formatName = 'Fujifilm RAF'
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length >= 92) addJpeg(view.getUint32(84), view.getUint32(88), 'JPEG')
    const model = latin1(bytes.subarray(28, 60)).replace(/\0.*$/s, '').trim()
    if (model) imageItems.push({ key: 'model', value: model })
    const first = [...previews.values()][0]
    const meta = first?.kind === 'jpeg' && first.info.exif ? exifBlockWithMaker(first.info.exif) : null
    if (meta) {
      summary = meta.summary
      maker = meta.maker
    }
  } else if (latin1(bytes.subarray(4, 8)) === 'ftyp') {
    // Canon CR3: EXIF in the CMT boxes of Canon's uuid box in moov.
    formatName = 'Canon CR3'
    const top = readBoxes(bytes, 0, bytes.length)
    const moov = top.find((b) => b.type === 'moov')
    const canon = moov ? readBoxes(bytes, moov.body, moov.end).find((b) => b.uuid === CANON_UUID) : undefined
    if (canon) {
      const cmt = new Map(readBoxes(bytes, canon.body, canon.end).map((b) => [b.type, bytes.subarray(b.body, b.end)]))
      const parts: ExifSummary[] = []
      const read = (key: string, as: 'ifd0' | 'exif' | 'gps') => {
        const block = cmt.get(key)
        if (!block || !Tiff.is(block)) return null
        try {
          const t = new Tiff(block)
          const ifd = t.readIfd(t.first)
          const dirs = { ifd0: null, exif: null, gps: null, interop: null, [as]: ifd }
          const s = exifSummary(t, dirs, { imageTags: false })
          parts.push(s)
          return { t, ifd, s }
        } catch {
          return null
        }
      }
      const ifd0 = read('CMT1', 'ifd0')
      read('CMT2', 'exif')
      read('CMT4', 'gps')
      if (ifd0) {
        orientation = ifd0.s.orientation
        summary = mergeSummaries(parts)
      }
      const note = cmt.get('CMT3')
      if (note && Tiff.is(note)) {
        try {
          const t = new Tiff(note)
          maker = makerItems({ vendor: 'Canon', tiff: t, ifd: t.readIfd(t.first), base: 0 })
        } catch {
          // The camera details stay without the maker's.
        }
      }
    }
  } else if (Tiff.is(bytes)) {
    const tiff = new Tiff(bytes)
    const seen = new Set<number>()
    let sensor: Ifd | null = null
    let ifd0: Ifd | null = null
    const visit = (at: number, depth: number, label: string) => {
      for (const ifd of tiff.chain(at, 64)) {
        if (seen.has(ifd.offset)) continue
        seen.add(ifd.offset)
        ifd0 ??= ifd
        const get = (tag: number) => ifd.entries.get(tag)
        const value = (tag: number) => tiff.value(get(tag))
        const photometric = value(T.Photometric)
        if (photometric === 32803 || photometric === 34892) {
          if (!sensor || value(T.ImageWidth) > tiff.value(sensor.entries.get(T.ImageWidth))) sensor = ifd
        }
        if (get(T.JPEGInterchangeFormat)) addJpeg(value(T.JPEGInterchangeFormat), value(T.JPEGInterchangeFormatLength), label)
        const compression = value(T.Compression)
        const strips = tiff.values(get(T.StripOffsets), 2)
        if (strips.length === 1 && (compression === 6 || compression === 7) && bytes[strips[0]] === 0xff && bytes[strips[0] + 1] === 0xd8) {
          addJpeg(strips[0], tiff.value(get(T.StripByteCounts)), label)
        }
        // Panasonic keeps a JPEG in IFD0 tag 0x2e.
        const jpg = get(0x2e)
        if (jpg && jpg.count > 100) addJpeg(jpg.at, jpg.count, label)
        // Small uncompressed RGB thumbnails (NEF, DNG).
        if (isImageIfd(ifd) && (photometric === 2 || photometric === 6) && (compression === 1 || compression === 8)) {
          try {
            const im = readImage(tiff, ifd)
            if (im.width >= 32 && im.height >= 32 && im.width * im.height <= 4_000_000) {
              previews.set(-ifd.offset - 1, { kind: 'ifd', tiff, ifd, width: im.width, height: im.height, source: label, rotate: 1 })
            }
          } catch {
            // Not a usable thumbnail.
          }
        }
        if (depth < 4) {
          for (const sub of tiff.values(get(T.SubIFDs), 32)) {
            try {
              visit(sub, depth + 1, 'Sub-image')
            } catch {
              // A damaged sub-image does not hide the others.
            }
          }
        }
      }
    }
    visit(tiff.first, 0, 'IFD')
    if (ifd0) {
      const dng = (ifd0 as Ifd).entries.get(50706)
      if (dng) formatName = `DNG ${tiff.values(dng, 4).join('.')}`
      else if (bytes[8] === 0x43 && bytes[9] === 0x52) formatName = 'Canon CR2'
      summary = exifSummary(tiff, exifDirs(tiff, ifd0), { imageTags: false })
      orientation = summary.orientation
      const xmpEntry = (ifd0 as Ifd).entries.get(T.XMP)
      if (xmpEntry) xmp = new TextDecoder().decode(tiff.raw(xmpEntry, 4 << 20))
      if (summary.makerNote) {
        const note = readMakerNote(tiff, summary.makerNote, summary.makerNoteAt, summary.make)
        if (note) {
          maker = makerItems(note)
          // Nikon keeps a preview in its maker note (tag 0x11, offsets from the note's TIFF).
          const previewIfd = note.vendor === 'Nikon' ? note.ifd.entries.get(0x11) : undefined
          if (previewIfd) {
            try {
              const p = note.tiff.readIfd(note.tiff.value(previewIfd))
              const start = note.tiff.value(p.entries.get(T.JPEGInterchangeFormat))
              if (start) addJpeg(note.base + start, note.tiff.value(p.entries.get(T.JPEGInterchangeFormatLength)), 'Maker note')
            } catch {
              // The scan below still finds it.
            }
          }
        }
      }
    }
    if (sensor) {
      const s = sensor as Ifd
      const w = tiff.value(s.entries.get(T.ImageWidth))
      const h = tiff.value(s.entries.get(T.ImageLength))
      if (w && h) imageItems.push({ key: 'sensor', value: `${w} × ${h}` })
      const bits = tiff.values(s.entries.get(T.BitsPerSample), 4)
      if (bits.length) imageItems.push({ key: 'bitDepth', value: `${bits[0]}-bit` })
      const c = tiff.value(s.entries.get(T.Compression))
      if (c) imageItems.push({ key: 'compression', value: COMPRESSION_NAMES[c] ?? `code ${c}` })
    }
  } else {
    throw unsupportedFeature('this RAW variant')
  }

  // Previews the pointers missed (maker notes of other vendors, CR3 tracks).
  for (const info of findJpegs(bytes, 0, bytes.length, 32)) {
    if (!previews.has(info.start)) previews.set(info.start, { kind: 'jpeg', info, source: 'JPEG', rotate: 1 })
  }
  const list = [...previews.values()].sort((a, b) => sizeOf(b).w * sizeOf(b).h - sizeOf(a).w * sizeOf(a).h)
  if (!list.length) throw new ImageError('unsupported-feature', 'a RAW file without an embedded preview')

  // Panasonic and others keep the maker note only in the embedded JPEG's EXIF.
  if (!maker.length) {
    for (const p of list) {
      if (p.kind !== 'jpeg' || !p.info.exif) continue
      const meta = exifBlockWithMaker(p.info.exif)
      if (meta?.maker.length) {
        maker = meta.maker
        break
      }
    }
  }

  // A preview with its own orientation tag is turned by the browser; the others take the RAW's.
  for (const p of list) {
    const own = p.kind === 'jpeg' && p.info.exif ? (exifFromBlock(p.info.exif)?.orientation ?? 1) : 1
    p.rotate = own > 1 ? 1 : orientation
  }

  const images: ImageDesc[] = list.map((p, id) => {
    let { w, h } = sizeOf(p)
    if (p.rotate >= 5) [w, h] = [h, w]
    const role = id === 0 ? 'Largest preview' : w * h <= 320 * 240 ? 'Thumbnail' : 'Preview'
    return {
      id,
      width: w,
      height: h,
      at: [id],
      label: `${role} · ${w}×${h}`,
      info: [
        { key: 'dimensions', value: `${w} × ${h}` },
        { key: 'format', value: p.kind === 'jpeg' ? 'JPEG' : 'TIFF' },
        ...(p.kind === 'jpeg' ? [{ key: 'fileSize', value: String(p.info.end - p.info.start) }] : [])
      ]
    }
  })
  const largest = images[0]
  imageItems.unshift({ key: 'rawFormat', value: formatName }, { key: 'preview', value: `${largest.width} × ${largest.height}` }, { key: 'previews', value: String(list.length) })
  sections.push({ title: 'image', items: imageItems })
  if (summary) sections.push(...summary.sections)
  if (maker.length) sections.push({ title: 'makernote', items: maker, raw: true })
  if (xmp) {
    const s = xmpSection(xmp)
    if (s) sections.push(s)
  }

  async function decode(id: number): Promise<Raster> {
    const p = list[id]
    if (!p) throw new ImageError('damaged', 'preview')
    let r: Raster
    if (p.kind === 'ifd') {
      r = await decodeIfd(p.tiff, p.ifd, platform, { orient: false })
    } else {
      if (!platform.decodeImage) throw new ImageError('no-decoder', 'JPEG')
      const img = await platform.decodeImage(bytes.subarray(p.info.start, p.info.end), 'image/jpeg')
      r = dropAlpha(raster(img.width, img.height, 4, 'u8', img.data))
    }
    return p.rotate > 1 ? orient(r, p.rotate) : r
  }

  return {
    desc: {
      format: formatName,
      images,
      axes: images.length > 1 ? [{ key: 'image', labels: images.map((i) => i.label) }] : [],
      primary: 0,
      list: images.length > 1 ? 'image' : undefined,
      info: sections,
      notices: [{ code: 'raw-preview', detail: `${largest.width} × ${largest.height}` }]
    },
    decode
  }
}

/** Joins the EXIF of several blocks (CR3 keeps IFD0, EXIF and GPS apart): sections by title. */
function mergeSummaries(parts: ExifSummary[]): ExifSummary {
  const sections: InfoSection[] = []
  for (const p of parts) {
    for (const s of p.sections) {
      const same = sections.find((x) => x.title === s.title)
      if (same) {
        for (const item of s.items) {
          const i = same.items.findIndex((x) => x.key === item.key)
          if (i >= 0) same.items[i] = item
          else same.items.push(item)
        }
      }
      else sections.push({ ...s, items: [...s.items] })
    }
  }
  const first = parts[0]
  return { ...first, sections, make: parts.find((p) => p.make)?.make ?? '', model: parts.find((p) => p.model)?.model ?? '' }
}
