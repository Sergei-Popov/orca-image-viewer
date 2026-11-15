// Apple icon files (.icns): every entry as its own image, from the 1-bit 32×32 icon to 1024×1024
// PNGs, plus the dark-mode set some files carry. Classic entries (1-, 4-, 8-bit with masks, RLE
// 24-bit with 8-bit masks, ARGB) are decoded here; PNG and JPEG by the browser; JPEG 2000 is listed
// as unsupported.

import { fourcc, startsWith } from '../core/bytes'
import { damaged, ImageError, unsupportedCompression } from '../core/errors'
import type { Decoded, ImageDesc, InfoItem, Platform, Raster } from '../core/model'
import { raster } from '../core/model'

/** Classic entry kinds by type: size, bits per pixel and the mask types that give their alpha. */
const CLASSIC: Record<string, { w: number; h: number; bits: 1 | 4 | 8 | 24; masks: string[] }> = {
  'ICON': { w: 32, h: 32, bits: 1, masks: [] },
  'ICN#': { w: 32, h: 32, bits: 1, masks: ['ICN#'] },
  'icm#': { w: 16, h: 12, bits: 1, masks: ['icm#'] },
  'icm4': { w: 16, h: 12, bits: 4, masks: ['icm#'] },
  'icm8': { w: 16, h: 12, bits: 8, masks: ['icm#'] },
  'ics#': { w: 16, h: 16, bits: 1, masks: ['ics#'] },
  'ics4': { w: 16, h: 16, bits: 4, masks: ['ics#'] },
  'ics8': { w: 16, h: 16, bits: 8, masks: ['ics#'] },
  'is32': { w: 16, h: 16, bits: 24, masks: ['s8mk', 'ics#'] },
  'icl4': { w: 32, h: 32, bits: 4, masks: ['ICN#'] },
  'icl8': { w: 32, h: 32, bits: 8, masks: ['ICN#'] },
  'il32': { w: 32, h: 32, bits: 24, masks: ['l8mk', 'ICN#'] },
  'ich#': { w: 48, h: 48, bits: 1, masks: ['ich#'] },
  'ich4': { w: 48, h: 48, bits: 4, masks: ['ich#'] },
  'ich8': { w: 48, h: 48, bits: 8, masks: ['ich#'] },
  'ih32': { w: 48, h: 48, bits: 24, masks: ['h8mk', 'ich#'] },
  'it32': { w: 128, h: 128, bits: 24, masks: ['t8mk'] }
}

/** Entries that hold PNG, JPEG 2000 or ARGB data, with their nominal pixel size. */
const MODERN: Record<string, number> = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512,
  ic04: 16,
  ic05: 32,
  icsb: 18,
  icsB: 36,
  sb24: 24,
  SB24: 48
}

/** Retina entries: the size they stand for at 2×. */
const RETINA: Record<string, string> = { ic10: '512@2x', ic11: '16@2x', ic12: '32@2x', ic13: '128@2x', ic14: '256@2x', icsB: '18@2x', SB24: '24@2x' }

const MASKS = new Set(['s8mk', 'l8mk', 'h8mk', 't8mk'])
const DARK = String.fromCharCode(0xfd, 0xd9, 0x2f, 0xa8)

/** The classic 16-colour palette. */
// prettier-ignore
const PALETTE4 = [
  0xffffff, 0xfcf305, 0xff6402, 0xdd0806, 0xf20884, 0x4600a5, 0x0000d4, 0x02abea,
  0x1fb714, 0x006411, 0x562c05, 0x90713a, 0xc0c0c0, 0x808080, 0x404040, 0x000000
]

/** The classic 256-colour palette: a 6×6×6 cube without black, ramps of red, green, blue and grey, black. */
function palette8(): number[] {
  const out: number[] = []
  const levels = [255, 204, 153, 102, 51, 0]
  for (const r of levels) for (const g of levels) for (const b of levels) out.push((r << 16) | (g << 8) | b)
  out.pop()
  const ramp = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17]
  for (const shift of [16, 8, 0]) for (const v of ramp) out.push(v << shift)
  for (const v of ramp) out.push((v << 16) | (v << 8) | v)
  out.push(0)
  return out
}

interface Entry {
  type: string
  start: number
  end: number
  dark: boolean
}

function readEntries(bytes: Uint8Array, from: number, to: number, dark: boolean, out: Entry[], depth = 0): void {
  let at = from
  while (at + 8 <= to && out.length < 512) {
    const type = fourcc(bytes, at)
    const size = ((bytes[at + 4] << 24) | (bytes[at + 5] << 16) | (bytes[at + 6] << 8) | bytes[at + 7]) >>> 0
    if (size < 8) break
    const end = Math.min(at + size, to)
    // The dark set: its entries follow directly (or, in some files, after an `icns` header).
    if (type === DARK && depth === 0) readEntries(bytes, at + (startsWith(bytes, 'icns', at + 8) ? 16 : 8), end, true, out, 1)
    else out.push({ type, start: at + 8, end, dark })
    if (at + size > to) break
    at += size
  }
}

/** The RLE of 24-bit and ARGB entries: each channel in turn, runs of literals or repeats. */
export function icnsRle(data: Uint8Array, at: number, end: number, pixels: number, channels: number, out: Uint8Array, stride: number, first: number): boolean {
  let p = at
  for (let c = 0; c < channels; c++) {
    let o = 0
    while (o < pixels) {
      if (p >= end) return false
      const n = data[p++]
      if (n < 0x80) {
        for (let k = 0; k <= n && o < pixels; k++) out[(o++) * stride + first + c] = data[p++] ?? 0
      } else {
        const v = data[p++] ?? 0
        for (let k = 0; k < n - 125 && o < pixels; k++) out[(o++) * stride + first + c] = v
      }
    }
  }
  return true
}

function pngSize(data: Uint8Array): [number, number] | null {
  if (data.length < 24 || !startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return null
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return [v.getUint32(16), v.getUint32(20)]
}

const isJp2 = (d: Uint8Array) => startsWith(d, [0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20]) || startsWith(d, [0xff, 0x4f, 0xff, 0x51])

export function openIcns(bytes: Uint8Array, platform: Platform): Decoded {
  if (bytes.length < 8 || fourcc(bytes, 0) !== 'icns') throw damaged('ICNS header')
  const declared = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0
  const entries: Entry[] = []
  readEntries(bytes, 8, Math.min(bytes.length, Math.max(declared, 8)), false, entries)
  const byType = new Map<string, Entry>()
  for (const e of entries) byType.set((e.dark ? 'dark:' : '') + e.type, e)
  const find = (type: string, dark: boolean) => byType.get((dark ? 'dark:' : '') + type)

  interface Shown {
    entry: Entry
    w: number
    h: number
    kind: 'classic' | 'png' | 'jpeg' | 'argb' | 'jp2' | 'unknown'
  }
  const shown: Shown[] = []
  const extras: InfoItem[] = []
  for (const e of entries) {
    const data = bytes.subarray(e.start, e.end)
    if (MASKS.has(e.type)) continue
    if (CLASSIC[e.type]) {
      // A 1-bit entry with a mask is shown only when no colour entry of its size uses that mask.
      const c = CLASSIC[e.type]
      if (c.bits === 1 && e.type !== 'ICON') {
        const users = Object.entries(CLASSIC).filter(([t, k]) => k.masks.includes(e.type) && t !== e.type && find(t, e.dark))
        if (users.length) continue
      }
      shown.push({ entry: e, w: c.w, h: c.h, kind: 'classic' })
      continue
    }
    if (MODERN[e.type] !== undefined) {
      const n = MODERN[e.type]
      const size = pngSize(data)
      if (size) shown.push({ entry: e, w: size[0], h: size[1], kind: 'png' })
      else if (isJp2(data)) shown.push({ entry: e, w: n, h: n, kind: 'jp2' })
      else if (startsWith(data, [0xff, 0xd8, 0xff])) shown.push({ entry: e, w: n, h: n, kind: 'jpeg' })
      else if (startsWith(data, 'ARGB')) shown.push({ entry: e, w: n, h: n, kind: 'argb' })
      else shown.push({ entry: e, w: n, h: n, kind: 'unknown' })
      continue
    }
    if (e.type === 'TOC ') extras.push({ key: 'toc', value: String(Math.floor((e.end - e.start) / 8)) })
    else if (e.type === 'icnV' && e.end - e.start >= 4) extras.push({ key: 'version', value: String(Math.round(new DataView(bytes.buffer, bytes.byteOffset + e.start, 4).getFloat32(0) * 100) / 100) })
    else if (e.type === 'name') extras.push({ key: 'name', value: new TextDecoder().decode(data).slice(0, 200) })
    else if (e.type !== 'info') extras.push({ key: e.type, value: `${e.end - e.start} bytes` })
  }
  if (!shown.length) throw damaged('ICNS entries')
  // Largest first, light before dark.
  shown.sort((a, b) => Number(a.entry.dark) - Number(b.entry.dark) || b.w * b.h - a.w * a.h)

  const images: ImageDesc[] = shown.map((s, id) => {
    const what = s.kind === 'classic' ? `${CLASSIC[s.entry.type].bits === 24 ? '24-bit' : `${CLASSIC[s.entry.type].bits}-bit`}` : s.kind === 'jp2' ? 'JPEG 2000' : s.kind.toUpperCase()
    const retina = RETINA[s.entry.type] ? ` (${RETINA[s.entry.type]})` : ''
    return {
      id,
      width: s.w,
      height: s.h,
      at: [id],
      label: `${s.entry.dark ? 'Dark · ' : ''}${s.w}×${s.h}${retina} · ${s.entry.type}`,
      unsupported: s.kind === 'jp2' ? 'JPEG 2000' : s.kind === 'unknown' ? `${s.entry.type} data` : undefined,
      info: [
        { key: 'entry', value: s.entry.type },
        { key: 'dimensions', value: `${s.w} × ${s.h}` },
        { key: 'format', value: what },
        { key: 'fileSize', value: String(s.entry.end - s.entry.start) }
      ]
    }
  })
  const hasDark = shown.some((s) => s.entry.dark)
  const items: InfoItem[] = [
    { key: 'entries', value: String(entries.length) },
    { key: 'sizes', value: [...new Set(shown.filter((s) => !s.entry.dark).map((s) => s.w))].sort((a, b) => b - a).join(', ') }
  ]
  if (hasDark) items.push({ key: 'darkVariant', value: 'Yes' })
  const unsupported = images.filter((i) => i.unsupported).length
  const primary = Math.max(0, images.findIndex((i) => !i.unsupported))

  async function decode(id: number): Promise<Raster> {
    const s = shown[id]
    if (!s) throw damaged('ICNS entry')
    const data = bytes.subarray(s.entry.start, s.entry.end)
    switch (s.kind) {
      case 'png':
      case 'jpeg': {
        if (!platform.decodeImage) throw new ImageError('no-decoder', s.kind.toUpperCase())
        const img = await platform.decodeImage(data, s.kind === 'png' ? 'image/png' : 'image/jpeg')
        return raster(img.width, img.height, 4, 'u8', img.data)
      }
      case 'argb': {
        const out = new Uint8Array(s.w * s.h * 4)
        const complete = icnsRle(data, 4, data.length, s.w * s.h, 4, out, 4, 0)
        // Stored as A, R, G, B: rotate to R, G, B, A.
        for (let i = 0; i < out.length; i += 4) {
          const a = out[i]
          out[i] = out[i + 1]
          out[i + 1] = out[i + 2]
          out[i + 2] = out[i + 3]
          out[i + 3] = a
        }
        return withPartial(raster(s.w, s.h, 4, 'u8', out), !complete)
      }
      case 'jp2':
        throw unsupportedCompression('JPEG 2000')
      case 'unknown':
        throw damaged(`${s.entry.type} data`)
      default:
        return decodeClassic(s.entry, s.w, s.h)
    }
  }

  function decodeClassic(e: Entry, w: number, h: number): Raster {
    const c = CLASSIC[e.type]
    const data = bytes.subarray(e.start, e.end)
    const n = w * h
    const out = new Uint8Array(n * 4)
    let complete = true
    if (c.bits === 24) {
      const skip = e.type === 'it32' ? 4 : 0
      if (data.length === n * 4) {
        // Uncompressed: X, R, G, B.
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) out[i * 4 + k] = data[i * 4 + 1 + k]
      } else {
        complete = icnsRle(data, skip, data.length, n, 3, out, 4, 0)
      }
    } else if (c.bits === 8) {
      const pal = palette8()
      for (let i = 0; i < n; i++) setRgb(out, i, pal[data[i] ?? 0])
      complete = data.length >= n
    } else if (c.bits === 4) {
      for (let i = 0; i < n; i++) setRgb(out, i, PALETTE4[((data[i >> 1] ?? 0) >> (i & 1 ? 0 : 4)) & 15])
      complete = data.length >= n / 2
    } else {
      for (let i = 0; i < n; i++) setRgb(out, i, (data[i >> 3] ?? 0) & (0x80 >> (i & 7)) ? 0 : 0xffffff)
      complete = data.length >= n / 8
    }
    // Alpha: an 8-bit mask, the second half of a 1-bit entry, or opaque.
    let alphaDone = false
    for (const m of c.masks) {
      const mask = find(m, e.dark)
      if (!mask) continue
      const md = bytes.subarray(mask.start, mask.end)
      if (MASKS.has(m)) {
        for (let i = 0; i < n; i++) out[i * 4 + 3] = md[i] ?? 0
      } else {
        const base = n / 8
        for (let i = 0; i < n; i++) out[i * 4 + 3] = (md[base + (i >> 3)] ?? 0) & (0x80 >> (i & 7)) ? 255 : 0
      }
      alphaDone = true
      break
    }
    if (!alphaDone) for (let i = 0; i < n; i++) out[i * 4 + 3] = 255
    return withPartial(raster(w, h, 4, 'u8', out), !complete)
  }

  return {
    desc: {
      format: 'ICNS',
      images,
      axes: [{ key: 'size', labels: images.map((i) => i.label) }],
      primary,
      list: 'size',
      info: [
        { title: 'image', items },
        ...(extras.length ? [{ title: 'file', items: extras }] : [])
      ],
      notices: unsupported ? [{ code: 'unsupported-images', detail: [...new Set(images.map((i) => i.unsupported).filter(Boolean))].join(', ') }] : []
    },
    decode
  }
}

function setRgb(out: Uint8Array, i: number, rgb: number): void {
  out[i * 4] = rgb >> 16
  out[i * 4 + 1] = (rgb >> 8) & 255
  out[i * 4 + 2] = rgb & 255
}

function withPartial(r: Raster, partial: boolean): Raster {
  if (partial) r.partial = true
  return r
}
