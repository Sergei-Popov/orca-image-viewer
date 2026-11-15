// DEFLATE through the browser's own DecompressionStream (also in Node), so no inflate library is
// shipped. Output stops at `expected` bytes when it is known, or at the raster byte limit, so a
// small stream cannot unpack into gigabytes.

import { damaged, MAX_RASTER_BYTES } from './errors'

export async function inflate(
  data: Uint8Array,
  format: 'deflate' | 'deflate-raw',
  expected?: number
): Promise<Uint8Array> {
  const limit = expected ?? MAX_RASTER_BYTES
  const stream = new DecompressionStream(format)
  const writer = stream.writable.getWriter()
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined)
  writer.close().catch(() => undefined)
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let error: unknown = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
      if (total >= limit) {
        reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch (e) {
    error = e
  }
  // Bytes after the end of the stream make Chromium fail once all the data is out: that is fine.
  if (error && (expected === undefined || total < expected)) {
    if (total === 0) throw damaged('DEFLATE')
  }
  const size = expected === undefined ? total : Math.min(total, expected)
  const out = new Uint8Array(expected ?? size)
  let at = 0
  for (const chunk of chunks) {
    if (at >= out.length) break
    const part = chunk.subarray(0, out.length - at)
    out.set(part, at)
    at += part.length
  }
  if (expected !== undefined && at < expected && error) {
    // A cut-off stream: keep what came out, the rest stays zero.
    return out
  }
  return out
}

/** Many streams at once, a few at a time, in order. */
export async function inflateAll(
  items: readonly { data: Uint8Array; expected?: number }[],
  format: 'deflate' | 'deflate-raw',
  run: (data: Uint8Array, format: 'deflate' | 'deflate-raw', expected?: number) => Promise<Uint8Array> = inflate
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = new Array(items.length)
  const width = 16
  for (let i = 0; i < items.length; i += width) {
    const batch = items.slice(i, i + width)
    const done = await Promise.all(batch.map((item) => run(item.data, format, item.expected)))
    for (let j = 0; j < done.length; j++) out[i + j] = done[j]
  }
  return out
}
