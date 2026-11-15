// Test fixtures are built byte by byte with these helpers; no sample images are kept in the repo.

export class ByteWriter {
  private buf = new Uint8Array(1024)
  length = 0

  constructor(readonly little = false) {}

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }

  private view(n: number): DataView {
    this.ensure(n)
    return new DataView(this.buf.buffer, this.length, n)
  }

  u8(v: number): this {
    this.ensure(1)
    this.buf[this.length++] = v & 255
    return this
  }

  i8(v: number): this {
    return this.u8(v < 0 ? v + 256 : v)
  }

  u16(v: number): this {
    this.view(2).setUint16(0, v, this.little)
    this.length += 2
    return this
  }

  i16(v: number): this {
    this.view(2).setInt16(0, v, this.little)
    this.length += 2
    return this
  }

  u32(v: number): this {
    this.view(4).setUint32(0, v >>> 0, this.little)
    this.length += 4
    return this
  }

  i32(v: number): this {
    this.view(4).setInt32(0, v, this.little)
    this.length += 4
    return this
  }

  u64(v: number): this {
    const hi = Math.floor(v / 2 ** 32)
    const lo = v >>> 0
    return this.little ? this.u32(lo).u32(hi) : this.u32(hi).u32(lo)
  }

  f32(v: number): this {
    this.view(4).setFloat32(0, v, this.little)
    this.length += 4
    return this
  }

  f64(v: number): this {
    this.view(8).setFloat64(0, v, this.little)
    this.length += 8
    return this
  }

  bytes(data: ArrayLike<number>): this {
    this.ensure(data.length)
    this.buf.set(data, this.length)
    this.length += data.length
    return this
  }

  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
    return this
  }

  zeros(n: number): this {
    this.ensure(n)
    this.buf.fill(0, this.length, this.length + n)
    this.length += n
    return this
  }

  /** Pads with zeros to a multiple of `n` bytes. */
  align(n: number): this {
    while (this.length % n) this.u8(0)
    return this
  }

  patchU16(at: number, v: number): void {
    new DataView(this.buf.buffer).setUint16(at, v, this.little)
  }

  patchU32(at: number, v: number): void {
    new DataView(this.buf.buffer).setUint32(at, v >>> 0, this.little)
  }

  patchU64(at: number, v: number): void {
    const view = new DataView(this.buf.buffer)
    const hi = Math.floor(v / 2 ** 32)
    const lo = v >>> 0
    view.setUint32(at, this.little ? lo : hi, this.little)
    view.setUint32(at + 4, this.little ? hi : lo, this.little)
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}

function adler32(data: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** Raw DEFLATE with stored (uncompressed) blocks: valid input for any inflater, built in sync. */
export function deflateRawStored(data: Uint8Array): Uint8Array {
  const w = new ByteWriter(true)
  if (data.length === 0) return w.u8(1).u16(0).u16(0xffff).done()
  for (let at = 0; at < data.length; at += 65535) {
    const n = Math.min(65535, data.length - at)
    w.u8(at + n >= data.length ? 1 : 0)
      .u16(n)
      .u16(~n & 0xffff)
      .bytes(data.subarray(at, at + n))
  }
  return w.done()
}

/** A zlib stream (RFC 1950) around stored DEFLATE blocks. */
export function zlibStored(data: Uint8Array): Uint8Array {
  const raw = deflateRawStored(data)
  return new ByteWriter(false).u8(0x78).u8(0x01).bytes(raw).u32(adler32(data)).done()
}

/** A smooth test pattern: 8-bit RGBA, `w × h`, with a soft alpha ramp at the right edge. */
export function pattern(w: number, h: number, seed = 0): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      out[i] = (x * 255) / Math.max(1, w - 1)
      out[i + 1] = (y * 255) / Math.max(1, h - 1)
      out[i + 2] = (seed * 37 + x * 3 + y * 5) & 255
      out[i + 3] = x >= w - 2 ? 128 : 255
    }
  }
  return out
}
