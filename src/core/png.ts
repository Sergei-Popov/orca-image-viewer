// A small PNG writer for "Save as PNG…": 8-bit grey, RGB or RGBA, adaptive row filters, and
// DEFLATE through the browser's own CompressionStream.

let crcTable: Uint32Array | null = null

/** The running CRC-32 register over `bytes`; the finished CRC is `(crc32(…) ^ 0xffffffff) >>> 0`. */
export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return crc
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined)
  writer.close().catch(() => undefined)
  const chunks: Uint8Array[] = []
  const reader = stream.readable.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0)
  return out
}

/** Grey, RGB or RGBA depending on what the pixels need. */
export function pngLayout(rgba: Uint8ClampedArray | Uint8Array): 0 | 2 | 6 {
  let grey = true
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) return 6
    if (grey && (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2])) grey = false
  }
  return grey ? 0 : 2
}

/** Encodes RGBA bytes as a PNG file. */
export async function encodePng(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Promise<Uint8Array> {
  const colorType = pngLayout(rgba)
  const bpp = colorType === 0 ? 1 : colorType === 2 ? 3 : 4
  const stride = width * bpp
  const raw = new Uint8Array((stride + 1) * height)
  const row = new Uint8Array(stride)
  const prev = new Uint8Array(stride)
  const candidates = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)]
  for (let y = 0; y < height; y++) {
    let s = y * width * 4
    for (let x = 0, d = 0; x < width; x++, s += 4) {
      if (bpp === 1) row[d++] = rgba[s]
      else {
        row[d++] = rgba[s]
        row[d++] = rgba[s + 1]
        row[d++] = rgba[s + 2]
        if (bpp === 4) row[d++] = rgba[s + 3]
      }
    }
    // Sub, Up and Paeth; keep the one with the smallest sum of signed residuals.
    const [sub, up, paeth] = candidates
    let best = 0
    let bestScore = Infinity
    const scores = [0, 0, 0]
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      sub[i] = (row[i] - a) & 0xff
      up[i] = (row[i] - b) & 0xff
      paeth[i] = (row[i] - pred) & 0xff
      scores[0] += sub[i] < 128 ? sub[i] : 256 - sub[i]
      scores[1] += up[i] < 128 ? up[i] : 256 - up[i]
      scores[2] += paeth[i] < 128 ? paeth[i] : 256 - paeth[i]
    }
    for (let k = 0; k < 3; k++) {
      if (scores[k] < bestScore) {
        bestScore = scores[k]
        best = k
      }
    }
    const at = y * (stride + 1)
    raw[at] = best === 0 ? 1 : best === 1 ? 2 : 4
    raw.set(candidates[best], at + 1)
    prev.set(row)
  }
  const ihdr = new Uint8Array(13)
  const hv = new DataView(ihdr.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = colorType
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // sRGB chunk: the pixels are what the screen showed.
  const parts = [signature, chunk('IHDR', ihdr), chunk('sRGB', new Uint8Array([0])), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))]
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
