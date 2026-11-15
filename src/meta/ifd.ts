// TIFF image file directories: the structure of TIFF itself, of EXIF blocks in JPEG, HEIF, PNG and
// PSD files, and of most camera RAW files. Classic TIFF (`II*\0` / `MM\0*`), BigTIFF (`II+\0`) and
// the RAW variants that only change the magic number (Olympus `IIRO`, Panasonic `IIU\0`).

import { latin1, Reader, text } from '../core/bytes'
import { damaged } from '../core/errors'

export interface IfdEntry {
  tag: number
  type: number
  count: number
  /** Where the value starts in the TIFF bytes (inline values point into the entry). */
  at: number
}

export interface Ifd {
  offset: number
  entries: Map<number, IfdEntry>
  next: number
}

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8
}

export const MAX_IFDS = 4096
const MAX_ENTRIES = 4096

export class Tiff {
  readonly r: Reader
  readonly big: boolean
  readonly first: number
  readonly magic: number

  /** `bytes` starts at the TIFF header (`II`/`MM`). */
  constructor(readonly bytes: Uint8Array) {
    if (bytes.length < 8) throw damaged('TIFF header')
    const order = latin1(bytes.subarray(0, 2))
    if (order !== 'II' && order !== 'MM') throw damaged('TIFF byte order')
    this.r = new Reader(bytes, order === 'II')
    this.r.seek(2)
    this.magic = this.r.u16()
    if (this.magic === 43) {
      this.big = true
      const size = this.r.u16()
      this.r.u16()
      if (size !== 8) throw damaged('BigTIFF offset size')
      this.first = this.r.u64()
    } else {
      this.big = false
      this.first = this.r.u32()
    }
  }

  get little(): boolean {
    return this.r.little
  }

  static is(bytes: Uint8Array, at = 0): boolean {
    if (bytes.length < at + 8) return false
    const a = bytes[at], b = bytes[at + 1]
    if (a === 0x49 && b === 0x49) {
      const m = bytes[at + 2] | (bytes[at + 3] << 8)
      return m === 42 || m === 43 || m === 0x4f52 || m === 0x5352 || m === 0x55
    }
    if (a === 0x4d && b === 0x4d) {
      const m = (bytes[at + 2] << 8) | bytes[at + 3]
      return m === 42 || m === 43
    }
    return false
  }

  readIfd(offset: number): Ifd {
    const r = this.r
    if (offset <= 0 || offset >= this.bytes.length) throw damaged('IFD offset')
    r.seek(offset)
    const count = this.big ? r.u64() : r.u16()
    if (count > MAX_ENTRIES) throw damaged('IFD entry count')
    const entries = new Map<number, IfdEntry>()
    const entrySize = this.big ? 20 : 12
    const inline = this.big ? 8 : 4
    for (let i = 0; i < count; i++) {
      const base = offset + (this.big ? 8 : 2) + i * entrySize
      r.seek(base)
      const tag = r.u16()
      const type = r.u16()
      const n = this.big ? r.u64() : r.u32()
      const size = (TYPE_SIZE[type] ?? 0) * n
      if (!TYPE_SIZE[type]) continue
      let at = r.pos
      if (size > inline) at = this.big ? r.u64() : r.u32()
      if (at + size > this.bytes.length) {
        // A value past the end: keep the entry readable as far as the file goes.
        if (at >= this.bytes.length) continue
      }
      if (!entries.has(tag)) entries.set(tag, { tag, type, count: n, at })
    }
    r.seek(offset + (this.big ? 8 : 2) + count * entrySize)
    let next = 0
    if (r.left >= (this.big ? 8 : 4)) next = this.big ? r.u64() : r.u32()
    return { offset, entries, next }
  }

  /** The chain of IFDs from `start` (IFD0 by default), stopping at loops and damage. */
  chain(start = this.first, max = MAX_IFDS): Ifd[] {
    const out: Ifd[] = []
    const seen = new Set<number>()
    let offset = start
    while (offset && !seen.has(offset) && out.length < max) {
      seen.add(offset)
      try {
        const ifd = this.readIfd(offset)
        out.push(ifd)
        offset = ifd.next
      } catch {
        break
      }
    }
    return out
  }

  /** Numeric values of an entry (rationals as numbers), at most `max` of them. */
  values(entry: IfdEntry | undefined, max = 1 << 24): number[] {
    if (!entry) return []
    const r = this.r
    const size = TYPE_SIZE[entry.type]
    const n = Math.min(entry.count, max, Math.floor((this.bytes.length - entry.at) / size))
    const out = new Array<number>(Math.max(0, n))
    r.seek(entry.at)
    for (let i = 0; i < n; i++) {
      switch (entry.type) {
        case 1: case 2: case 7: out[i] = r.u8(); break
        case 6: out[i] = r.i8(); break
        case 3: out[i] = r.u16(); break
        case 8: out[i] = r.i16(); break
        case 4: case 13: out[i] = r.u32(); break
        case 9: out[i] = r.i32(); break
        case 5: { const a = r.u32(); const b = r.u32(); out[i] = b ? a / b : 0; break }
        case 10: { const a = r.i32(); const b = r.i32(); out[i] = b ? a / b : 0; break }
        case 11: out[i] = r.f32(); break
        case 12: out[i] = r.f64(); break
        case 16: case 18: out[i] = r.u64(); break
        case 17: { const v = r.u64(); out[i] = v >= 2 ** 63 ? v - 2 ** 64 : v; break }
      }
    }
    return out
  }

  /** Rationals as [numerator, denominator] pairs, for exact display (1/250 s). */
  rationals(entry: IfdEntry | undefined, max = 64): [number, number][] {
    if (!entry || (entry.type !== 5 && entry.type !== 10)) return []
    const r = this.r
    const n = Math.min(entry.count, max, Math.floor((this.bytes.length - entry.at) / 8))
    const out: [number, number][] = []
    r.seek(entry.at)
    for (let i = 0; i < n; i++) {
      out.push(entry.type === 5 ? [r.u32(), r.u32()] : [r.i32(), r.i32()])
    }
    return out
  }

  value(entry: IfdEntry | undefined, fallback = 0): number {
    const v = this.values(entry, 1)
    return v.length ? v[0] : fallback
  }

  raw(entry: IfdEntry | undefined, max = 1 << 30): Uint8Array {
    if (!entry) return new Uint8Array(0)
    const size = (TYPE_SIZE[entry.type] ?? 1) * entry.count
    const end = Math.min(this.bytes.length, entry.at + Math.min(size, max))
    return this.bytes.subarray(entry.at, end)
  }

  string(entry: IfdEntry | undefined): string {
    if (!entry) return ''
    return text(this.raw(entry, 65536)).trim()
  }
}

/** The tag number lookups used across decoders. */
export const T = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  Photometric: 262,
  FillOrder: 266,
  ImageDescription: 270,
  Make: 271,
  Model: 272,
  StripOffsets: 273,
  Orientation: 274,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  XResolution: 282,
  YResolution: 283,
  PlanarConfiguration: 284,
  PageName: 285,
  ResolutionUnit: 296,
  PageNumber: 297,
  Software: 305,
  DateTime: 306,
  Artist: 315,
  Predictor: 317,
  ColorMap: 320,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SubIFDs: 330,
  InkSet: 332,
  ExtraSamples: 338,
  SampleFormat: 339,
  SMinSampleValue: 340,
  SMaxSampleValue: 341,
  JPEGTables: 347,
  JPEGInterchangeFormat: 513,
  JPEGInterchangeFormatLength: 514,
  YCbCrCoefficients: 529,
  YCbCrSubSampling: 530,
  YCbCrPositioning: 531,
  ReferenceBlackWhite: 532,
  XMP: 700,
  Copyright: 33432,
  IPTC: 33723,
  Photoshop: 34377,
  ExifIFD: 34665,
  ICC: 34675,
  GPSIFD: 34853,
  InteropIFD: 40965,
  DNGVersion: 50706,
  UniqueCameraModel: 50708,
  GDALNoData: 42113
} as const
