// A minimal PSD/PSB writer for tests: header, colour table, a few image resources, layer records
// with channel data, and the flattened image, in any of the four compressions.

import { packbitsEncode } from '../codecs/packbits'
import { applyFloatingPoint, applyHorizontal } from '../codecs/predictor'
import { ByteWriter, zlibStored } from './writer'

export type Plane = Uint8Array | Uint16Array | Float32Array

export interface PsdLayerSpec {
  name: string
  left?: number
  top?: number
  width: number
  height: number
  /** Channel planes by id: 0, 1, 2 (colour), -1 (transparency), -2 (mask). */
  channels?: Record<number, Plane>
  hidden?: boolean
  opacity?: number
  blend?: string
  clipping?: boolean
  /** 1 open group, 2 closed group, 3 end of a group. */
  section?: number
  /** An extra tagged block key that marks the layer kind (`TySh`, `SoLd`, `levl`…). */
  marker?: string
  mask?: { left: number; top: number; width: number; height: number; defaultColor?: number }
}

export interface PsdSpec {
  width: number
  height: number
  depth?: 1 | 8 | 16 | 32
  mode?: number
  /** Flattened image planes, in channel order. */
  planes: Plane[]
  compression?: 0 | 1 | 2 | 3
  psb?: boolean
  /** Layers bottom first, as the file stores them. */
  layers?: PsdLayerSpec[]
  mergedAlpha?: boolean
  /** Writes resource 1057 with this "has real merged data" flag. */
  realMerged?: boolean
  palette?: Uint8Array
  icc?: Uint8Array
  xmp?: string
  resolution?: number
  /** The writer named in resource 1057. */
  writer?: string
}

const bytesOf = (depth: number) => (depth === 32 ? 4 : depth === 16 ? 2 : 1)

function planeBytes(plane: Plane, width: number, height: number, depth: number): Uint8Array {
  const n = width * height
  if (depth === 1) {
    const rowBytes = Math.ceil(width / 8)
    const out = new Uint8Array(rowBytes * height)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (plane[y * width + x] === 0) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    return out
  }
  if (depth === 8) return Uint8Array.from(plane.subarray(0, n))
  const w = new ByteWriter(false)
  for (let i = 0; i < n; i++) {
    if (depth === 16) w.u16(plane[i] ?? 0)
    else w.f32(plane[i] ?? 0)
  }
  return w.done()
}

/** One plane's data after the compression word; RLE row counts are returned separately. */
function encodePlane(plane: Plane, width: number, height: number, depth: number, compression: number): { counts: number[]; data: Uint8Array } {
  const raw = planeBytes(plane, width, height, depth)
  const rowBytes = depth === 1 ? Math.ceil(width / 8) : width * bytesOf(depth)
  if (compression === 0) return { counts: [], data: raw }
  if (compression === 1) {
    const rows: Uint8Array[] = []
    for (let y = 0; y < height; y++) rows.push(packbitsEncode(raw.subarray(y * rowBytes, (y + 1) * rowBytes)))
    const w = new ByteWriter(false)
    for (const r of rows) w.bytes(r)
    return { counts: rows.map((r) => r.length), data: w.done() }
  }
  const copy = raw.slice()
  if (compression === 3) {
    if (depth === 32) applyFloatingPoint(copy, height, rowBytes, width, 1, 32)
    else applyHorizontal(copy, height, rowBytes, width, 1, depth === 16 ? 16 : 8, false)
  }
  return { counts: [], data: zlibStored(copy) }
}

function writeCounts(w: ByteWriter, counts: number[], psb: boolean): void {
  for (const c of counts) psb ? w.u32(c) : w.u16(c)
}

/** Channel data of a layer: compression word, RLE counts, data. */
function layerChannel(plane: Plane, width: number, height: number, depth: number, compression: number, psb: boolean): Uint8Array {
  const w = new ByteWriter(false)
  const { counts, data } = encodePlane(plane, width, height, depth, compression)
  w.u16(compression)
  writeCounts(w, counts, psb)
  w.bytes(data)
  return w.done()
}

function resource(w: ByteWriter, id: number, data: Uint8Array): void {
  w.ascii('8BIM').u16(id).u16(0).u32(data.length).bytes(data)
  if (data.length % 2) w.u8(0)
}

export function psd(spec: PsdSpec): Uint8Array {
  const depth = spec.depth ?? 8
  const mode = spec.mode ?? 3
  const compression = spec.compression ?? 1
  const psb = !!spec.psb
  const w = new ByteWriter(false)
  w.ascii('8BPS').u16(psb ? 2 : 1).zeros(6).u16(spec.planes.length).u32(spec.height).u32(spec.width).u16(depth).u16(mode)
  // Colour mode data.
  const palette = spec.palette ?? new Uint8Array(0)
  w.u32(palette.length).bytes(palette)
  // Image resources.
  const res = new ByteWriter(false)
  if (spec.resolution) {
    const fixed = Math.round(spec.resolution * 65536)
    resource(res, 1005, new ByteWriter(false).u32(fixed).u16(1).u16(1).u32(fixed).u16(1).u16(1).done())
  }
  if (spec.realMerged !== undefined) {
    const writer = spec.writer ?? 'Test writer'
    const v = new ByteWriter(false).u32(1).u8(spec.realMerged ? 1 : 0).u32(writer.length)
    for (const ch of writer) v.u16(ch.charCodeAt(0))
    v.u32(0).u32(1)
    resource(res, 1057, v.done())
  }
  if (spec.icc) resource(res, 1039, spec.icc)
  if (spec.xmp) resource(res, 1060, new TextEncoder().encode(spec.xmp))
  const resBytes = res.done()
  w.u32(resBytes.length).bytes(resBytes)

  // Layer and mask information.
  const lm = new ByteWriter(false)
  const layers = spec.layers ?? []
  if (layers.length) {
    const info = new ByteWriter(false)
    info.i16(spec.mergedAlpha ? -layers.length : layers.length)
    const channelData: Uint8Array[] = []
    for (const layer of layers) {
      const left = layer.left ?? 0
      const top = layer.top ?? 0
      info.i32(top).i32(left).i32(top + layer.height).i32(left + layer.width)
      const ids = Object.keys(layer.channels ?? {}).map(Number).sort((a, b) => a - b)
      info.u16(ids.length)
      for (const id of ids) {
        const plane = (layer.channels as Record<number, Plane>)[id]
        const isMask = id === -2 && layer.mask
        const cw = isMask ? (layer.mask as NonNullable<PsdLayerSpec['mask']>).width : layer.width
        const ch = isMask ? (layer.mask as NonNullable<PsdLayerSpec['mask']>).height : layer.height
        const data = layerChannel(plane, cw, ch, depth, compression, psb)
        channelData.push(data)
        info.i16(id)
        psb ? info.u64(data.length) : info.u32(data.length)
      }
      info.ascii('8BIM').ascii((layer.blend ?? 'norm').padEnd(4, ' ').slice(0, 4))
      info.u8(Math.round((layer.opacity ?? 1) * 255)).u8(layer.clipping ? 1 : 0).u8((layer.hidden ? 2 : 0) | 8).u8(0)
      const extra = new ByteWriter(false)
      if (layer.mask) {
        const m = layer.mask
        extra.u32(20).i32(m.top).i32(m.left).i32(m.top + m.height).i32(m.left + m.width).u8(m.defaultColor ?? 0).u8(0).u16(0)
      } else {
        extra.u32(0)
      }
      extra.u32(0)
      const name = layer.name.slice(0, 255)
      // A Pascal name padded to 4 bytes (what comes before it is a multiple of 4 already).
      extra.u8(name.length).ascii(name).align(4)
      // Unicode name, so non-Latin names survive.
      const luni = new ByteWriter(false).u32(layer.name.length)
      for (const c of layer.name) luni.u16(c.charCodeAt(0))
      luni.align(4)
      const luniBytes = luni.done()
      extra.ascii('8BIM').ascii('luni').u32(luniBytes.length).bytes(luniBytes)
      if (layer.section) extra.ascii('8BIM').ascii('lsct').u32(4).u32(layer.section)
      if (layer.marker) extra.ascii('8BIM').ascii(layer.marker).u32(4).u32(0)
      const extraBytes = extra.done()
      info.u32(extraBytes.length).bytes(extraBytes)
    }
    for (const c of channelData) info.bytes(c)
    info.align(2)
    const infoBytes = info.done()
    psb ? lm.u64(infoBytes.length) : lm.u32(infoBytes.length)
    lm.bytes(infoBytes)
    lm.u32(0)
  }
  const lmBytes = lm.done()
  psb ? w.u64(lmBytes.length) : w.u32(lmBytes.length)
  w.bytes(lmBytes)

  // The flattened image: all channels' RLE counts first, then the data.
  w.u16(compression)
  if (compression === 2 || compression === 3) {
    const all = new ByteWriter(false)
    const rowBytes = depth === 1 ? Math.ceil(spec.width / 8) : spec.width * bytesOf(depth)
    for (const plane of spec.planes) {
      const raw = planeBytes(plane, spec.width, spec.height, depth)
      if (compression === 3) {
        if (depth === 32) applyFloatingPoint(raw, spec.height, rowBytes, spec.width, 1, 32)
        else applyHorizontal(raw, spec.height, rowBytes, spec.width, 1, depth === 16 ? 16 : 8, false)
      }
      all.bytes(raw)
    }
    w.bytes(zlibStored(all.done()))
  } else {
    const encoded = spec.planes.map((p) => encodePlane(p, spec.width, spec.height, depth, compression))
    for (const e of encoded) writeCounts(w, e.counts, psb)
    for (const e of encoded) w.bytes(e.data)
  }
  return w.done()
}

/** Splits 8-bit RGBA into R, G, B, A planes. */
export function planesOf(rgba: Uint8Array, n: number, channels = 4): Uint8Array[] {
  const out = Array.from({ length: channels }, () => new Uint8Array(n))
  for (let i = 0; i < n; i++) for (let k = 0; k < channels; k++) out[k][i] = rgba[i * 4 + k]
  return out
}
