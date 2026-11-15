// A HEIF writer for tests: ftyp, meta (hdlr, pitm, iinf, iloc, iref, iprp, idat) and mdat, with
// items stored in mdat or idat. The coded data is whatever the test's stand-in decoder reads.

import { ByteWriter } from './writer'

export interface HeifItemSpec {
  id: number
  type: string
  name?: string
  hidden?: boolean
  contentType?: string
  data: Uint8Array
  /** Property boxes, associated in this order. */
  props?: Uint8Array[]
  /** Stored in the idat box (construction method 1) instead of mdat. */
  idat?: boolean
}

export interface HeifSpec {
  major?: string
  brands?: string[]
  primary: number
  items: HeifItemSpec[]
  refs?: { type: string; from: number; to: number[] }[]
}

export function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const w = new ByteWriter(false)
  let n = 8
  for (const b of body) n += b.length
  w.u32(n).ascii(type)
  for (const b of body) w.bytes(b)
  return w.done()
}

/** A full box: version and flags, then the body. */
export function fullBox(type: string, version: number, flags: number, ...body: Uint8Array[]): Uint8Array {
  return box(type, new ByteWriter(false).u32(((version << 24) | flags) >>> 0).done(), ...body)
}

const bytes = (f: (w: ByteWriter) => void) => {
  const w = new ByteWriter(false)
  f(w)
  return w.done()
}

export const ispe = (width: number, height: number) => fullBox('ispe', 0, 0, bytes((w) => w.u32(width).u32(height)))
export const irot = (quarterTurns: number) => box('irot', new Uint8Array([quarterTurns & 3]))
export const imir = (axis: number) => box('imir', new Uint8Array([axis & 1]))
export const pixi = (bits: number[]) => fullBox('pixi', 0, 0, new Uint8Array([bits.length, ...bits]))
export const auxC = (type: string) => fullBox('auxC', 0, 0, bytes((w) => w.ascii(type).u8(0)))
export const nclx = (primaries: number, transfer: number, matrix: number, full: boolean) => box('colr', bytes((w) => w.ascii('nclx').u16(primaries).u16(transfer).u16(matrix).u8(full ? 0x80 : 0)))
export const clap = (width: number, height: number) => box('clap', bytes((w) => w.u32(width).u32(1).u32(height).u32(1).u32(0).u32(1).u32(0).u32(1)))

/** An HEVC decoder configuration: Main profile, level 3.1, no parameter sets. */
export const hvcC = () =>
  box('hvcC', new Uint8Array([1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0]))

/** Grid item data: rows × columns tiles making an output of width × height. */
export const gridData = (rows: number, columns: number, width: number, height: number) => bytes((w) => w.u8(0).u8(0).u8(rows - 1).u8(columns - 1).u16(width).u16(height))

function meta(spec: HeifSpec, mdatAt: number): Uint8Array {
  const hdlr = fullBox('hdlr', 0, 0, bytes((w) => w.u32(0).ascii('pict').zeros(12).u8(0)))
  const pitm = fullBox('pitm', 0, 0, bytes((w) => w.u16(spec.primary)))
  const infes = spec.items.map((it) =>
    fullBox(
      'infe',
      2,
      it.hidden ? 1 : 0,
      bytes((w) => {
        w.u16(it.id).u16(0).ascii(it.type).ascii(it.name ?? '').u8(0)
        if (it.type === 'mime') w.ascii(it.contentType ?? '').u8(0)
      })
    )
  )
  const iinf = fullBox('iinf', 0, 0, bytes((w) => w.u16(spec.items.length)), ...infes)
  // Item data: mdat items one after another, idat items likewise.
  let mdatOffset = mdatAt + 8
  let idatOffset = 0
  const idat = new ByteWriter(false)
  const iloc = bytes((w) => {
    w.u8(0x44).u8(0x00).u16(spec.items.length)
    for (const it of spec.items) {
      w.u16(it.id).u16(it.idat ? 1 : 0).u16(0).u16(1)
      if (it.idat) {
        w.u32(idatOffset).u32(it.data.length)
        idat.bytes(it.data)
        idatOffset += it.data.length
      } else {
        w.u32(mdatOffset).u32(it.data.length)
        mdatOffset += it.data.length
      }
    }
  })
  const refs = (spec.refs ?? []).map((r) => box(r.type, bytes((w) => {
    w.u16(r.from).u16(r.to.length)
    for (const t of r.to) w.u16(t)
  })))
  const all: Uint8Array[] = []
  const ipma = bytes((w) => {
    const withProps = spec.items.filter((it) => it.props?.length)
    w.u32(withProps.length)
    for (const it of withProps) {
      const props = it.props as Uint8Array[]
      w.u16(it.id).u8(props.length)
      for (const p of props) {
        all.push(p)
        w.u8(all.length)
      }
    }
  })
  const iprp = box('iprp', box('ipco', ...all), fullBox('ipma', 0, 0, ipma))
  const children = [hdlr, pitm, iinf, fullBox('iloc', 1, 0, iloc), ...(refs.length ? [fullBox('iref', 0, 0, ...refs)] : []), iprp]
  const idatBytes = idat.done()
  if (idatBytes.length) children.push(box('idat', idatBytes))
  return fullBox('meta', 0, 0, ...children)
}

export function heif(spec: HeifSpec): Uint8Array {
  const major = spec.major ?? 'heic'
  const ftyp = box('ftyp', bytes((w) => {
    w.ascii(major).u32(0)
    for (const b of spec.brands ?? ['mif1', 'heic']) w.ascii(b)
  }))
  // The meta box's size does not depend on the offsets in it, so a first pass sizes it.
  const size = meta(spec, 0).length
  const m = meta(spec, ftyp.length + size)
  const mdat = box('mdat', ...spec.items.filter((it) => !it.idat).map((it) => it.data))
  return new ByteWriter(false).bytes(ftyp).bytes(m).bytes(mdat).done()
}
