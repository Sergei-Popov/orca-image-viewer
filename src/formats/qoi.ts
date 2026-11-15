// QOI, the "Quite OK Image" format (qoiformat.org): 8-bit RGB or RGBA, a 64-entry colour index,
// small differences, luma differences and runs.

import { latin1, Reader } from '../core/bytes'
import { checkSize, damaged } from '../core/errors'
import { type Decoded, raster } from '../core/model'

export function isQoi(bytes: Uint8Array): boolean {
  return bytes.length >= 14 && latin1(bytes.subarray(0, 4)) === 'qoif'
}

export function decodeQoi(bytes: Uint8Array) {
  const r = new Reader(bytes, false)
  if (r.ascii(4) !== 'qoif') throw damaged('QOI signature')
  const width = r.u32()
  const height = r.u32()
  const channels = r.u8()
  const colorspace = r.u8()
  if (channels !== 3 && channels !== 4) throw damaged(`QOI channels ${channels}`)
  checkSize(width, height, 4)
  const out = new Uint8Array(width * height * channels)
  const index = new Uint8Array(64 * 4)
  let pr = 0, pg = 0, pb = 0, pa = 255
  let run = 0
  let p = 14
  const end = bytes.length
  const pixels = width * height
  let partial = false
  let i = 0
  for (; i < pixels; i++) {
    if (run > 0) {
      run--
    } else {
      if (p >= end) {
        partial = true
        break
      }
      const b1 = bytes[p++]
      if (b1 === 0xfe) {
        if (p + 3 > end) { partial = true; break }
        pr = bytes[p++]; pg = bytes[p++]; pb = bytes[p++]
      } else if (b1 === 0xff) {
        if (p + 4 > end) { partial = true; break }
        pr = bytes[p++]; pg = bytes[p++]; pb = bytes[p++]; pa = bytes[p++]
      } else {
        const op = b1 >> 6
        if (op === 0) {
          const k = (b1 & 63) * 4
          pr = index[k]; pg = index[k + 1]; pb = index[k + 2]; pa = index[k + 3]
        } else if (op === 1) {
          pr = (pr + ((b1 >> 4) & 3) - 2) & 255
          pg = (pg + ((b1 >> 2) & 3) - 2) & 255
          pb = (pb + (b1 & 3) - 2) & 255
        } else if (op === 2) {
          if (p >= end) { partial = true; break }
          const b2 = bytes[p++]
          const dg = (b1 & 63) - 32
          pr = (pr + dg - 8 + ((b2 >> 4) & 15)) & 255
          pg = (pg + dg) & 255
          pb = (pb + dg - 8 + (b2 & 15)) & 255
        } else {
          run = b1 & 63
        }
      }
      const k = ((pr * 3 + pg * 5 + pb * 7 + pa * 11) % 64) * 4
      index[k] = pr; index[k + 1] = pg; index[k + 2] = pb; index[k + 3] = pa
    }
    const d = i * channels
    out[d] = pr
    out[d + 1] = pg
    out[d + 2] = pb
    if (channels === 4) out[d + 3] = pa
  }
  return { width, height, channels, colorspace, data: out, partial }
}

export function openQoi(bytes: Uint8Array): Decoded {
  const q = decodeQoi(bytes)
  const r = raster(q.width, q.height, q.channels, 'u8', q.data, { partial: q.partial })
  return {
    desc: {
      format: 'QOI',
      images: [{ id: 0, width: q.width, height: q.height, at: [], label: `${q.width}×${q.height}`, info: [] }],
      axes: [],
      primary: 0,
      info: [
        {
          title: 'image',
          items: [
            { key: 'dimensions', value: `${q.width} × ${q.height}` },
            { key: 'channels', value: q.channels === 4 ? 'RGBA' : 'RGB' },
            { key: 'bitDepth', value: '8' },
            { key: 'colorSpace', value: q.colorspace === 1 ? 'Linear' : 'sRGB' }
          ]
        }
      ],
      notices: []
    },
    decode: async () => r
  }
}
