// An OpenEXR writer for tests: single- or multi-part, scanline or tiled (one level or mipmap),
// half/float/uint channels with x/y subsampling, NONE, RLE, ZIPS, ZIP and PXR24 compression.

import { exrPredict } from '../codecs/exr-misc'
import { toHalf } from '../core/half'
import { ByteWriter } from './writer'

export interface ExrChannelSpec {
  name: string
  /** 0 uint, 1 half (default), 2 float. */
  type?: 0 | 1 | 2
  xs?: number
  ys?: number
}

export interface ExrPartSpec {
  name?: string
  width: number
  height: number
  /** Data window origin. */
  x0?: number
  y0?: number
  channels: ExrChannelSpec[]
  /** The value of a channel (index into `channels`) at absolute x, y on a mip level. */
  value: (channel: number, x: number, y: number, level: number) => number
  compression?: 0 | 1 | 2 | 3 | 5
  tiles?: { w: number; h: number; mipmap?: boolean }
  /** A `chunkCount` attribute other than the real one (damaged headers). */
  chunkCount?: number
}

/** zlib through Node's (and the browser's) CompressionStream. */
export async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** OpenEXR RLE: runs of 3+ equal bytes as a count and a byte, the rest as literal runs. */
export function exrRleEncode(src: Uint8Array): Uint8Array {
  const w = new ByteWriter(true)
  let i = 0
  while (i < src.length) {
    let run = 1
    while (i + run < src.length && src[i + run] === src[i] && run < 128) run++
    if (run >= 3) {
      w.u8(run - 1).u8(src[i])
      i += run
      continue
    }
    let n = 0
    while (i + n < src.length && n < 127) {
      if (i + n + 2 < src.length && src[i + n] === src[i + n + 1] && src[i + n] === src[i + n + 2]) break
      n++
    }
    w.i8(-n).bytes(src.subarray(i, i + n))
    i += n
  }
  return w.done()
}

const sorted = (channels: ExrChannelSpec[]) =>
  channels.map((c, index) => ({ ...c, index, type: c.type ?? 1, xs: c.xs ?? 1, ys: c.ys ?? 1 })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

type Channel = ReturnType<typeof sorted>[number]

const mod = (a: number, b: number) => ((a % b) + b) % b

/** One block (lines `y0..y0+h-1`, columns `x0..x0+w-1`, absolute) in the uncompressed layout. */
function rawBlock(part: ExrPartSpec, chans: Channel[], x0: number, y0: number, w: number, h: number, level: number): Uint8Array {
  const out = new ByteWriter(true)
  for (let y = y0; y < y0 + h; y++) {
    for (const c of chans) {
      if (mod(y, c.ys) !== 0) continue
      for (let x = x0; x < x0 + w; x++) {
        if (mod(x, c.xs) !== 0) continue
        const v = part.value(c.index, x, y, level)
        if (c.type === 1) out.u16(toHalf(v))
        else if (c.type === 2) out.f32(v)
        else out.u32(v)
      }
    }
  }
  return out.done()
}

function pxr24Planes(chans: Channel[], raw: Uint8Array, x0: number, y0: number, w: number, h: number): Uint8Array {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const out = new ByteWriter(false)
  let at = 0
  for (let y = y0; y < y0 + h; y++) {
    for (const c of chans) {
      if (mod(y, c.ys) !== 0) continue
      let n = 0
      for (let x = x0; x < x0 + w; x++) if (mod(x, c.xs) === 0) n++
      const size = c.type === 1 ? 2 : c.type === 2 ? 3 : 4
      const planes = Array.from({ length: size }, () => new Uint8Array(n))
      let prev = 0
      for (let k = 0; k < n; k++) {
        let v: number
        if (c.type === 1) {
          v = view.getUint16(at, true)
          at += 2
        } else {
          v = view.getUint32(at, true)
          at += 4
          // Floats keep their top 24 bits, rounded.
          if (c.type === 2) v = Math.min(0xffffff, Math.round(v / 256))
        }
        const diff = c.type === 0 ? (v - prev) >>> 0 : (v - prev) & (c.type === 1 ? 0xffff : 0xffffff)
        prev = v
        for (let b = 0; b < size; b++) planes[b][k] = Math.floor(diff / 2 ** (8 * (size - 1 - b))) & 255
      }
      for (const p of planes) out.bytes(p)
    }
  }
  return out.done()
}

async function compress(part: ExrPartSpec, chans: Channel[], raw: Uint8Array, x0: number, y0: number, w: number, h: number): Promise<Uint8Array> {
  let packed: Uint8Array
  switch (part.compression ?? 0) {
    case 1:
      packed = exrRleEncode(exrPredict(raw))
      break
    case 2:
    case 3:
      packed = await zlib(exrPredict(raw))
      break
    case 5:
      packed = await zlib(pxr24Planes(chans, raw, x0, y0, w, h))
      break
    default:
      return raw
  }
  // OpenEXR stores a block uncompressed when compressing does not make it smaller.
  return packed.length < raw.length ? packed : raw
}

function attr(w: ByteWriter, name: string, type: string, data: Uint8Array): void {
  w.ascii(name).u8(0).ascii(type).u8(0).u32(data.length).bytes(data)
}

const LINES = [1, 1, 1, 16, 32, 16]

function levelSizes(part: ExrPartSpec): { w: number; h: number }[] {
  if (!part.tiles?.mipmap) return [{ w: part.width, h: part.height }]
  const out = [{ w: part.width, h: part.height }]
  while (out[out.length - 1].w > 1 || out[out.length - 1].h > 1) {
    const l = out.length
    out.push({ w: Math.max(1, Math.floor(part.width / 2 ** l)), h: Math.max(1, Math.floor(part.height / 2 ** l)) })
  }
  return out
}

/** `headersOnly` stops after the headers, before the offset tables and chunks. */
export async function exr(spec: ExrPartSpec | ExrPartSpec[], options: { headersOnly?: boolean } = {}): Promise<Uint8Array> {
  const parts = Array.isArray(spec) ? spec : [spec]
  const multipart = parts.length > 1
  const w = new ByteWriter(true)
  const tiledSingle = !multipart && !!parts[0].tiles
  w.u32(0x01312f76).u32(2 | (tiledSingle ? 0x200 : 0) | (multipart ? 0x1000 : 0))

  // Blocks per part: [header bytes of the chunk, data].
  const chunkLists: { head: Uint8Array; data: Uint8Array }[][] = []
  for (const [pi, part] of parts.entries()) {
    const chans = sorted(part.channels)
    const x0 = part.x0 ?? 0
    const y0 = part.y0 ?? 0
    const list: { head: Uint8Array; data: Uint8Array }[] = []
    if (part.tiles) {
      const t = part.tiles
      for (const [level, size] of levelSizes(part).entries()) {
        for (let ty = 0; ty * t.h < size.h; ty++) {
          for (let tx = 0; tx * t.w < size.w; tx++) {
            const bw = Math.min(t.w, size.w - tx * t.w)
            const bh = Math.min(t.h, size.h - ty * t.h)
            const bx = x0 + tx * t.w
            const by = y0 + ty * t.h
            const raw = rawBlock(part, chans, bx, by, bw, bh, level)
            const data = await compress(part, chans, raw, bx, by, bw, bh)
            const head = new ByteWriter(true)
            if (multipart) head.i32(pi)
            head.i32(tx).i32(ty).i32(level).i32(level).u32(data.length)
            list.push({ head: head.done(), data })
          }
        }
      }
    } else {
      const lines = LINES[part.compression ?? 0]
      for (let y = y0; y < y0 + part.height; y += lines) {
        const bh = Math.min(lines, y0 + part.height - y)
        const raw = rawBlock(part, chans, x0, y, part.width, bh, 0)
        const data = await compress(part, chans, raw, x0, y, part.width, bh)
        const head = new ByteWriter(true)
        if (multipart) head.i32(pi)
        head.i32(y).u32(data.length)
        list.push({ head: head.done(), data })
      }
    }
    chunkLists.push(list)

    // Header.
    const cl = new ByteWriter(true)
    for (const c of chans) cl.ascii(c.name).u8(0).i32(c.type).u8(0).zeros(3).i32(c.xs).i32(c.ys)
    cl.u8(0)
    attr(w, 'channels', 'chlist', cl.done())
    attr(w, 'compression', 'compression', new Uint8Array([part.compression ?? 0]))
    const box = new ByteWriter(true).i32(x0).i32(y0).i32(x0 + part.width - 1).i32(y0 + part.height - 1).done()
    attr(w, 'dataWindow', 'box2i', box)
    attr(w, 'displayWindow', 'box2i', box)
    attr(w, 'lineOrder', 'lineOrder', new Uint8Array([0]))
    attr(w, 'pixelAspectRatio', 'float', new ByteWriter(true).f32(1).done())
    attr(w, 'screenWindowCenter', 'v2f', new ByteWriter(true).f32(0).f32(0).done())
    attr(w, 'screenWindowWidth', 'float', new ByteWriter(true).f32(1).done())
    if (part.tiles) attr(w, 'tiles', 'tiledesc', new ByteWriter(true).u32(part.tiles.w).u32(part.tiles.h).u8(part.tiles.mipmap ? 1 : 0).done())
    if (multipart) {
      attr(w, 'name', 'string', new TextEncoder().encode(part.name ?? `part${pi}`))
      attr(w, 'type', 'string', new TextEncoder().encode(part.tiles ? 'tiledimage' : 'scanlineimage'))
    }
    if (multipart || part.chunkCount !== undefined) attr(w, 'chunkCount', 'int', new ByteWriter(true).i32(part.chunkCount ?? list.length).done())
    w.u8(0)
  }
  if (multipart) w.u8(0)
  if (options.headersOnly) return w.done()

  // Offset tables, then the chunks.
  const tableAt = w.length
  const total = chunkLists.reduce((s, l) => s + l.length, 0)
  w.zeros(total * 8)
  let k = 0
  for (const list of chunkLists) {
    for (const chunk of list) {
      w.patchU64(tableAt + k * 8, w.length)
      k++
      w.bytes(chunk.head).bytes(chunk.data)
    }
  }
  return w.done()
}
