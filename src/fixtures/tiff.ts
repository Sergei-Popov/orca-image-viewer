// A TIFF writer for tests: IFD chains with sub-IFDs, out-of-line values and data blocks (strips,
// tiles, JPEG previews, maker notes), in either byte order. Also a minimal JPEG for RAW previews.

import { ByteWriter } from './writer'

export type TiffValue =
  /** Numbers of a TIFF type; rationals as numerator, denominator pairs. */
  | { tag: number; type: number; values: number[] }
  | { tag: number; text: string }
  /** A block of BYTE or UNDEFINED (default) data. */
  | { tag: number; type?: number; bytes: Uint8Array }
  /** A pointer to another IFD (EXIF, GPS, Nikon's preview IFD). */
  | { tag: number; ifd: TiffIfd }
  /** SubIFDs. */
  | { tag: number; ifds: TiffIfd[] }
  /** Offsets of data blocks written elsewhere in the file (strips, tiles, a JPEG). */
  | { tag: number; type?: 3 | 4; data: Uint8Array[] }

export interface TiffIfd {
  entries: TiffValue[]
}

const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 }

function encode(type: number, values: number[], little: boolean): Uint8Array {
  const w = new ByteWriter(little)
  for (const v of values) {
    switch (type) {
      case 1:
      case 7:
        w.u8(v)
        break
      case 6:
        w.i8(v)
        break
      case 3:
        w.u16(v)
        break
      case 8:
        w.i16(v)
        break
      case 4:
      case 5:
      case 13:
        w.u32(v)
        break
      case 9:
      case 10:
        w.i32(v)
        break
      case 11:
        w.f32(v)
        break
      case 12:
        w.f64(v)
        break
    }
  }
  return w.done()
}

function writeIfd(w: ByteWriter, ifd: TiffIfd): { at: number; next: number } {
  w.align(2)
  const at = w.length
  const entries = [...ifd.entries].sort((a, b) => a.tag - b.tag)
  w.u16(entries.length)
  const later: (() => void)[] = []
  for (const e of entries) {
    let type: number
    let count: number
    let payload: Uint8Array | null = null
    let children: (() => number)[] = []
    if ('values' in e) {
      type = e.type
      count = type === 5 || type === 10 ? e.values.length / 2 : e.values.length
      payload = encode(type, e.values, w.little)
    } else if ('text' in e) {
      type = 2
      payload = new Uint8Array([...new TextEncoder().encode(e.text), 0])
      count = payload.length
    } else if ('bytes' in e) {
      type = e.type ?? 7
      payload = e.bytes
      count = e.bytes.length
    } else if ('ifd' in e) {
      type = 4
      count = 1
      const sub = e.ifd
      children = [() => writeIfd(w, sub).at]
    } else if ('ifds' in e) {
      type = 4
      count = e.ifds.length
      children = e.ifds.map((sub) => () => writeIfd(w, sub).at)
    } else {
      type = e.type ?? 4
      count = e.data.length
      children = e.data.map((block) => () => {
        const off = w.length
        w.bytes(block)
        return off
      })
    }
    w.u16(e.tag).u16(type).u32(count)
    const slot = w.length
    if (payload) {
      if (payload.length <= 4) w.bytes(payload).zeros(4 - payload.length)
      else {
        w.u32(0)
        const data = payload
        later.push(() => {
          w.align(2)
          w.patchU32(slot, w.length)
          w.bytes(data)
        })
      }
    } else if (children.length === 1) {
      w.u32(0)
      const child = children[0]
      later.push(() => patch(w, slot, type, child()))
    } else {
      // An array of offsets out of line, each patched once its target is written.
      w.u32(0)
      later.push(() => {
        w.align(2)
        const array = w.length
        w.patchU32(slot, array)
        w.zeros(count * SIZE[type])
        children.forEach((child, i) => patch(w, array + i * SIZE[type], type, child()))
      })
    }
  }
  const next = w.length
  w.u32(0)
  for (const f of later) f()
  return { at, next }
}

function patch(w: ByteWriter, at: number, type: number, value: number): void {
  if (type === 3) w.patchU16(at, value)
  else w.patchU32(at, value)
}

/** A classic TIFF: the IFDs in `chain` linked by their next pointers. `magic` 42, or a RAW's. */
/** `pad` zero bytes after the header move the first IFD (maker notes with longer headers). */
export function tiff(chain: TiffIfd[], options: { little?: boolean; magic?: number; pad?: number } = {}): Uint8Array {
  const little = options.little ?? true
  const w = new ByteWriter(little)
  w.ascii(little ? 'II' : 'MM')
    .u16(options.magic ?? 42)
    .u32(0)
    .zeros(options.pad ?? 0)
  let link = 4
  for (const ifd of chain) {
    const { at, next } = writeIfd(w, ifd)
    w.patchU32(link, at)
    link = next
  }
  return w.done()
}

/**
 * A structurally valid baseline JPEG header and a few entropy bytes: enough for the parser to
 * find its size and end; the tests decode it with a stand-in decoder.
 */
export function miniJpeg(width: number, height: number, exif?: Uint8Array): Uint8Array {
  const w = new ByteWriter(false).u8(0xff).u8(0xd8)
  if (exif) {
    w.u8(0xff).u8(0xe1).u16(exif.length + 8).ascii('Exif').u16(0).bytes(exif)
  }
  w.u8(0xff).u8(0xdb).u16(67).u8(0)
  for (let i = 0; i < 64; i++) w.u8(1)
  w.u8(0xff).u8(0xc0).u16(17).u8(8).u16(height).u16(width).u8(3)
  for (let c = 1; c <= 3; c++) w.u8(c).u8(0x11).u8(0)
  w.u8(0xff).u8(0xda).u16(12).u8(3)
  for (let c = 1; c <= 3; c++) w.u8(c).u8(0)
  w.u8(0).u8(63).u8(0)
  // Entropy data with a stuffed 0xff.
  w.u8(0x12).u8(0xff).u8(0).u8(0x34)
  return w.u8(0xff).u8(0xd9).done()
}
