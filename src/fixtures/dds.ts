// DDS files and BC blocks for tests, built field by field.

import { ByteWriter } from './writer'

export interface DdsSpec {
  width: number
  height: number
  mips?: number
  depth?: number
  /** A legacy FourCC (`DXT1`, `ATI2`…), `DX10` with `dxgi`, or uncompressed with `masks`. */
  fourcc?: string
  dxgi?: number
  arraySize?: number
  cube?: boolean
  /** Legacy pixel format flags and masks for uncompressed data. */
  pfFlags?: number
  bits?: number
  masks?: [number, number, number, number]
  data: Uint8Array
}

export function dds(spec: DdsSpec): Uint8Array {
  const w = new ByteWriter(true)
  const mips = spec.mips ?? 1
  const flags = 0x1 | 0x2 | 0x4 | 0x1000 | (mips > 1 ? 0x20000 : 0) | (spec.depth ? 0x800000 : 0)
  w.ascii('DDS ').u32(124).u32(flags).u32(spec.height).u32(spec.width).u32(0).u32(spec.depth ?? 0).u32(mips).zeros(44)
  // Pixel format.
  const code = spec.dxgi !== undefined ? 'DX10' : spec.fourcc
  w.u32(32)
  if (code) w.u32(4).ascii(code).u32(0).u32(0).u32(0).u32(0).u32(0)
  else {
    const m = spec.masks ?? [0, 0, 0, 0]
    w.u32(spec.pfFlags ?? 0x40).u32(0).u32(spec.bits ?? 32).u32(m[0]).u32(m[1]).u32(m[2]).u32(m[3])
  }
  const legacyCube = spec.cube && spec.dxgi === undefined
  w.u32(0x1000 | (mips > 1 ? 0x400008 : 0))
    .u32((legacyCube ? 0x200 | 0xfc00 : 0) | (spec.depth ? 0x200000 : 0))
    .zeros(12)
  if (spec.dxgi !== undefined) w.u32(spec.dxgi).u32(spec.depth ? 4 : 3).u32(spec.cube ? 4 : 0).u32(spec.arraySize ?? 1).u32(0)
  return w.bytes(spec.data).done()
}

/** Bits written least significant first, as BC6H and BC7 blocks store them. */
export class BlockWriter {
  private readonly bits: number[] = []

  put(value: number, count: number): this {
    for (let i = 0; i < count; i++) this.bits.push(Math.floor(value / 2 ** i) % 2)
    return this
  }

  done(): Uint8Array {
    const out = new Uint8Array(16)
    this.bits.slice(0, 128).forEach((b, i) => (out[i >> 3] |= b << (i & 7)))
    return out
  }
}

/** A 565 colour. */
export const rgb565 = (r: number, g: number, b: number) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)

/** A BC1 block: two 565 colours and 16 two-bit indices (pixel 0 first). */
export function bc1Block(c0: number, c1: number, indices: number[]): Uint8Array {
  const w = new ByteWriter(true).u16(c0).u16(c1)
  let bits = 0
  indices.forEach((v, i) => (bits += v * 4 ** i))
  return w.u32(bits).done()
}
