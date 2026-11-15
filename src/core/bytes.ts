// Bounds-checked reading of little- and big-endian numbers. Every read past the end throws a
// `truncated` ImageError, so a cut-off file never reads garbage or loops.

import { truncated } from './errors'

export class Reader {
  readonly view: DataView
  pos: number
  little: boolean

  constructor(
    readonly bytes: Uint8Array,
    little = true,
    pos = 0
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.little = little
    this.pos = pos
  }

  get length(): number {
    return this.bytes.length
  }

  get left(): number {
    return this.bytes.length - this.pos
  }

  need(n: number, at = this.pos): void {
    if (at < 0 || n < 0 || at + n > this.bytes.length) throw truncated()
  }

  skip(n: number): void {
    this.need(n)
    this.pos += n
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.bytes.length) throw truncated()
    this.pos = pos
  }

  u8(): number {
    this.need(1)
    return this.bytes[this.pos++]
  }

  i8(): number {
    this.need(1)
    return this.view.getInt8(this.pos++)
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.pos, this.little)
    this.pos += 2
    return v
  }

  i16(): number {
    this.need(2)
    const v = this.view.getInt16(this.pos, this.little)
    this.pos += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.pos, this.little)
    this.pos += 4
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.view.getInt32(this.pos, this.little)
    this.pos += 4
    return v
  }

  /** A 64-bit unsigned integer as a number; exact up to 2^53, which covers every file offset. */
  u64(): number {
    this.need(8)
    const a = this.view.getUint32(this.pos, this.little)
    const b = this.view.getUint32(this.pos + 4, this.little)
    this.pos += 8
    return this.little ? b * 2 ** 32 + a : a * 2 ** 32 + b
  }

  f32(): number {
    this.need(4)
    const v = this.view.getFloat32(this.pos, this.little)
    this.pos += 4
    return v
  }

  f64(): number {
    this.need(8)
    const v = this.view.getFloat64(this.pos, this.little)
    this.pos += 8
    return v
  }

  take(n: number): Uint8Array {
    this.need(n)
    const out = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /** `n` bytes as Latin-1 (four-character codes, signatures). */
  ascii(n: number): string {
    return latin1(this.take(n))
  }

  /** A NUL-terminated Latin-1 string of at most `max` bytes. */
  cstring(max = 4096): string {
    const start = this.pos
    const end = Math.min(this.bytes.length, start + max)
    let i = start
    while (i < end && this.bytes[i] !== 0) i++
    if (i >= this.bytes.length) throw truncated()
    const s = latin1(this.bytes.subarray(start, i))
    this.pos = i + 1
    return s
  }
}

export function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return s
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function utf16be(bytes: Uint8Array): string {
  return new TextDecoder('utf-16be', { fatal: false }).decode(bytes)
}

/** Text from a metadata field: UTF-8 when valid, Latin-1 otherwise, without trailing NULs. */
export function text(bytes: Uint8Array): string {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  const body = bytes.subarray(0, end)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return latin1(body)
  }
}

export function startsWith(bytes: Uint8Array, signature: ArrayLike<number> | string, at = 0): boolean {
  const sig = typeof signature === 'string' ? Array.from(signature, (c) => c.charCodeAt(0)) : signature
  if (bytes.length < at + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false
  return true
}

export function fourcc(bytes: Uint8Array, at: number): string {
  if (at + 4 > bytes.length) return ''
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const p of parts) length += p.length
  const out = new Uint8Array(length)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function hex(n: number, width = 4): string {
  return '0x' + n.toString(16).toUpperCase().padStart(width, '0')
}
