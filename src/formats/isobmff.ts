// ISO base media file format boxes (HEIF, CR3): a flat walk that never reads past its parent and
// stops at a damaged size.

import { fourcc } from '../core/bytes'

export interface Box {
  type: string
  /** Start of the box header. */
  start: number
  /** Start of the payload (after size, type and a large size or uuid). */
  body: number
  end: number
  /** 16-byte extended type of a `uuid` box, as hex. */
  uuid?: string
}

export function readBoxes(bytes: Uint8Array, from: number, to: number, max = 100000): Box[] {
  const out: Box[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = from
  const end = Math.min(to, bytes.length)
  while (at + 8 <= end && out.length < max) {
    let size = view.getUint32(at)
    const type = fourcc(bytes, at + 4)
    let body = at + 8
    if (size === 1) {
      if (at + 16 > end) break
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12)
      body = at + 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < body - at || at + size > end) {
      // A box that claims to run past its parent: keep what is there and stop.
      out.push({ type, start: at, body, end })
      break
    }
    const box: Box = { type, start: at, body, end: at + size }
    if (type === 'uuid' && body + 16 <= box.end) {
      box.uuid = Array.from(bytes.subarray(body, body + 16), (b) => b.toString(16).padStart(2, '0')).join('')
      box.body = body + 16
    }
    out.push(box)
    at += size
  }
  return out
}

export function child(bytes: Uint8Array, parent: Box, type: string, skip = 0): Box | undefined {
  return readBoxes(bytes, parent.body + skip, parent.end).find((b) => b.type === type)
}
