// Truevision TGA: colour-mapped, true-colour and grey images, raw or run-length encoded, 8 to 32
// bits per pixel, any origin; the TGA 2.0 footer and extension area (author, date, software,
// alpha meaning). TGA has no signature, so the file type and a sanity check decide.

import { latin1, Reader } from '../core/bytes'
import { checkSize, damaged, unsupportedCompression, unsupportedPixels } from '../core/errors'
import { type Decoded, type InfoItem, raster } from '../core/model'

interface Header {
  idLength: number
  mapType: number
  type: number
  mapStart: number
  mapLength: number
  mapDepth: number
  width: number
  height: number
  depth: number
  descriptor: number
}

function header(bytes: Uint8Array): Header {
  if (bytes.length < 18) throw damaged('TGA header')
  const r = new Reader(bytes, true)
  return {
    idLength: r.u8(),
    mapType: r.u8(),
    type: r.u8(),
    mapStart: (r.pos = 3, r.u16()),
    mapLength: r.u16(),
    mapDepth: r.u8(),
    width: (r.pos = 12, r.u16()),
    height: r.u16(),
    depth: r.u8(),
    descriptor: r.u8()
  }
}

/** Plausible TGA header: a known image type and bit depth and a non-empty size. */
export function looksLikeTga(bytes: Uint8Array): boolean {
  if (bytes.length < 18) return false
  const h = header(bytes)
  if (![1, 2, 3, 9, 10, 11, 32, 33].includes(h.type)) return false
  if (h.mapType > 1 || h.width === 0 || h.height === 0) return false
  if (![8, 15, 16, 24, 32].includes(h.depth)) return false
  if (h.mapType === 1 && ![15, 16, 24, 32].includes(h.mapDepth)) return false
  return true
}

const TYPE_NAMES: Record<number, string> = {
  1: 'Colour-mapped', 2: 'True colour', 3: 'Greyscale', 9: 'Colour-mapped, RLE', 10: 'True colour, RLE', 11: 'Greyscale, RLE'
}

function readColour(bytes: Uint8Array, at: number, depth: number, out: Uint8Array, d: number): void {
  if (depth === 24 || depth === 32) {
    out[d] = bytes[at + 2]
    out[d + 1] = bytes[at + 1]
    out[d + 2] = bytes[at]
    out[d + 3] = depth === 32 ? bytes[at + 3] : 255
  } else if (depth === 15 || depth === 16) {
    const v = bytes[at] | (bytes[at + 1] << 8)
    out[d] = (((v >> 10) & 31) * 255 + 15) / 31
    out[d + 1] = (((v >> 5) & 31) * 255 + 15) / 31
    out[d + 2] = ((v & 31) * 255 + 15) / 31
    out[d + 3] = depth === 16 ? (v & 0x8000 ? 255 : 0) : 255
  } else {
    out[d] = out[d + 1] = out[d + 2] = bytes[at]
    out[d + 3] = 255
  }
}

export function openTga(bytes: Uint8Array): Decoded {
  if (!looksLikeTga(bytes)) throw damaged('TGA header')
  const h = header(bytes)
  if (h.type === 32 || h.type === 33) throw unsupportedCompression('Huffman/delta')
  const { width, height } = h
  checkSize(width, height, 4)
  const mapped = h.type === 1 || h.type === 9
  const grey = h.type === 3 || h.type === 11
  const rle = h.type >= 9
  if (mapped && h.mapType !== 1) throw damaged('TGA colour map')
  if (mapped && h.depth !== 8 && h.depth !== 16) throw unsupportedPixels(`${h.depth}-bit colour-mapped`)
  if (grey && h.depth !== 8 && h.depth !== 16) throw unsupportedPixels(`${h.depth}-bit greyscale`)

  let at = 18 + h.idLength
  const imageId = latin1(bytes.subarray(18, Math.min(bytes.length, at))).replace(/\0+$/, '').trim()
  // Colour map: entries of mapDepth bits.
  const mapBytes = Math.ceil(h.mapDepth / 8)
  const map = new Uint8Array(Math.max(1, h.mapLength) * 4)
  if (h.mapType === 1) {
    if (at + h.mapLength * mapBytes > bytes.length) throw damaged('TGA colour map')
    for (let i = 0; i < h.mapLength; i++) readColour(bytes, at + i * mapBytes, h.mapDepth, map, i * 4)
    at += h.mapLength * mapBytes
  }

  // Grey 16-bit is grey + alpha (8 + 8 bits); otherwise pixels are unpacked to RGBA bytes.
  const bpp = Math.ceil(h.depth / 8)
  const pixels = width * height
  const out = new Uint8Array(pixels * 4)
  let partial = false
  const put = (src: number, i: number) => {
    const d = i * 4
    if (mapped) {
      const index = (bpp === 1 ? bytes[src] : bytes[src] | (bytes[src + 1] << 8)) - h.mapStart
      if (index >= 0 && index < h.mapLength) {
        const m = index * 4
        out[d] = map[m]; out[d + 1] = map[m + 1]; out[d + 2] = map[m + 2]; out[d + 3] = map[m + 3]
      } else out[d + 3] = 255
    } else if (grey) {
      out[d] = out[d + 1] = out[d + 2] = bytes[src]
      out[d + 3] = bpp === 2 ? bytes[src + 1] : 255
    } else {
      readColour(bytes, src, h.depth, out, d)
    }
  }
  if (!rle) {
    const need = pixels * bpp
    const have = Math.min(need, bytes.length - at)
    const n = Math.floor(have / bpp)
    for (let i = 0; i < n; i++) put(at + i * bpp, i)
    partial = n < pixels
  } else {
    let i = 0
    let p = at
    while (i < pixels) {
      if (p >= bytes.length) {
        partial = true
        break
      }
      const head = bytes[p++]
      const count = (head & 0x7f) + 1
      if (head & 0x80) {
        if (p + bpp > bytes.length) { partial = true; break }
        for (let k = 0; k < count && i < pixels; k++) put(p, i++)
        p += bpp
      } else {
        for (let k = 0; k < count && i < pixels; k++) {
          if (p + bpp > bytes.length) { partial = true; break }
          put(p, i++)
          p += bpp
        }
        if (partial) break
      }
    }
  }

  // The footer says whether the alpha channel means anything.
  const ext = extension(bytes)
  const alphaBits = h.descriptor & 15
  let alpha = (h.depth === 32 || (h.depth === 16 && !grey) || (grey && bpp === 2) || (mapped && h.mapDepth === 32)) && alphaBits > 0
  if (mapped && h.mapDepth === 32) alpha = true
  if (ext && (ext.attributes === 0 || ext.attributes === 1 || ext.attributes === 2)) alpha = false
  // Many writers store 32-bit pixels with an all-zero alpha: show those opaque.
  if (alpha) {
    let any = false
    for (let i = 3; i < out.length; i += 4) if (out[i] !== 0) { any = true; break }
    if (!any) alpha = false
  }
  if (!alpha) for (let i = 3; i < out.length; i += 4) out[i] = 255

  // Origin: bottom-left unless bit 5; right-to-left with bit 4.
  const top = (h.descriptor & 0x20) !== 0
  const right = (h.descriptor & 0x10) !== 0
  if (!top || right) {
    const flipped = new Uint8Array(out.length)
    for (let y = 0; y < height; y++) {
      const sy = top ? y : height - 1 - y
      for (let x = 0; x < width; x++) {
        const sx = right ? width - 1 - x : x
        const s = (sy * width + sx) * 4
        const d = (y * width + x) * 4
        flipped[d] = out[s]; flipped[d + 1] = out[s + 1]; flipped[d + 2] = out[s + 2]; flipped[d + 3] = out[s + 3]
      }
    }
    out.set(flipped)
  }

  const r = raster(width, height, 4, 'u8', out, { alpha, partial })
  const items: InfoItem[] = [
    { key: 'dimensions', value: `${width} × ${height}` },
    { key: 'type', value: TYPE_NAMES[h.type] ?? String(h.type) },
    { key: 'bitDepth', value: mapped ? `${h.depth} (colour map ${h.mapDepth})` : String(h.depth) },
    { key: 'channels', value: grey ? (bpp === 2 ? 'Grey + alpha' : 'Grey') : alpha ? 'RGBA' : 'RGB' },
    { key: 'compression', value: rle ? 'RLE' : 'None' },
    { key: 'origin', value: `${top ? 'Top' : 'Bottom'}-${right ? 'right' : 'left'}` }
  ]
  if (mapped) items.push({ key: 'paletteSize', value: String(h.mapLength) })
  if (imageId) items.push({ key: 'imageId', value: imageId })
  const fileItems: InfoItem[] = []
  if (ext) {
    if (ext.author) fileItems.push({ key: 'author', value: ext.author })
    if (ext.comment) fileItems.push({ key: 'comment', value: ext.comment })
    if (ext.date) fileItems.push({ key: 'created', value: ext.date })
    if (ext.software) fileItems.push({ key: 'software', value: ext.software })
    if (ext.job) fileItems.push({ key: 'job', value: ext.job })
    if (ext.attributes >= 0) fileItems.push({ key: 'alphaType', value: ['None', 'Undefined (ignored)', 'Undefined (kept)', 'Alpha', 'Premultiplied alpha'][ext.attributes] ?? String(ext.attributes) })
    fileItems.push({ key: 'version', value: 'TGA 2.0' })
  }
  return {
    desc: {
      format: 'TGA',
      images: [{ id: 0, width, height, at: [], label: `${width}×${height}`, info: [] }],
      axes: [],
      primary: 0,
      info: [{ title: 'image', items }, ...(fileItems.length ? [{ title: 'file', items: fileItems }] : [])],
      notices: []
    },
    decode: async () => r
  }
}

interface Extension {
  author: string
  comment: string
  date: string
  job: string
  software: string
  attributes: number
}

function extension(bytes: Uint8Array): Extension | null {
  if (bytes.length < 26 + 18) return null
  const sig = latin1(bytes.subarray(bytes.length - 18, bytes.length - 2))
  if (sig !== 'TRUEVISION-XFILE') return null
  const r = new Reader(bytes, true, bytes.length - 26)
  const offset = r.u32()
  if (!offset || offset + 495 > bytes.length) return null
  r.seek(offset)
  if (r.u16() < 495) return null
  const str = (n: number) => latin1(r.take(n)).replace(/\0[\s\S]*$/, '').trim()
  const author = str(41)
  const comment = [str(81), str(81), str(81), str(81)].filter(Boolean).join('\n')
  const [mo, d, y, hh, mm, ss] = [r.u16(), r.u16(), r.u16(), r.u16(), r.u16(), r.u16()]
  const job = str(41)
  r.skip(6)
  const software = str(41)
  const version = r.u16()
  const letter = String.fromCharCode(r.u8()).trim()
  r.seek(offset + 494)
  const attributes = r.u8()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    author,
    comment,
    date: y ? `${y}-${pad(mo)}-${pad(d)} ${pad(hh)}:${pad(mm)}:${pad(ss)}` : '',
    job,
    software: software ? `${software}${version ? ` ${(version / 100).toFixed(2)}${letter}` : ''}` : '',
    attributes
  }
}
