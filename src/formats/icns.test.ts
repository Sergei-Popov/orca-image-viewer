import { assert, test } from 'orca/testing'
import { encodePng } from '../core/png'
import { inflate } from '../core/inflate'
import { openDocument } from '../core/session'
import { ByteWriter } from '../fixtures/writer'

/** An icns file from [type, data] entries; `dark` entries go into the dark-mode set. */
function icns(entries: [string, Uint8Array][], dark: [string, Uint8Array][] = []): Uint8Array {
  const body = new ByteWriter(false)
  const put = (w: ByteWriter, type: string, data: Uint8Array) => {
    for (let i = 0; i < 4; i++) w.u8(type.charCodeAt(i))
    w.u32(data.length + 8).bytes(data)
  }
  for (const [type, data] of entries) put(body, type, data)
  if (dark.length) {
    const inner = new ByteWriter(false)
    for (const [type, data] of dark) put(inner, type, data)
    put(body, String.fromCharCode(0xfd, 0xd9, 0x2f, 0xa8), inner.done())
  }
  const b = body.done()
  return new ByteWriter(false).ascii('icns').u32(b.length + 8).bytes(b).done()
}

/** The icns RLE of one channel: a repeat run of `n` values, then literals. */
function rleChannel(value: number, n: number, literals: number[]): number[] {
  const out: number[] = []
  for (let left = n; left > 0; ) {
    const run = Math.min(left, 130)
    if (run >= 3) {
      out.push(run + 125, value)
      left -= run
    } else {
      out.push(left - 1, ...new Array(left).fill(value))
      left = 0
    }
  }
  if (literals.length) out.push(literals.length - 1, ...literals)
  return out
}

const stubDecoder = {
  inflate,
  // The tests decode PNG entries with a stand-in that reports a flat colour.
  decodeImage: async (data: Uint8Array) => {
    const v = new DataView(data.buffer, data.byteOffset)
    const w = v.getUint32(16)
    const h = v.getUint32(20)
    return { width: w, height: h, data: new Uint8Array(w * h * 4).fill(77) }
  }
}

test('ICNS: every entry listed largest first; RLE 24-bit with an 8-bit mask', async () => {
  // 16×16: red channel 250 then the last two pixels 1, 2; green 0; blue 9.
  const is32 = new Uint8Array([...rleChannel(250, 254, [1, 2]), ...rleChannel(0, 256, []), ...rleChannel(9, 256, [])])
  const mask = new Uint8Array(256).fill(128)
  const png = await encodePng(2, 2, new Uint8Array(16).fill(255))
  const jp2 = new Uint8Array([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
  const doc = await openDocument(icns([['is32', is32], ['s8mk', mask], ['ic07', png], ['ic09', jp2]]), 'icns', stubDecoder)
  assert.equal(doc.desc.format, 'ICNS')
  assert.deepEqual(
    doc.desc.images.map((i) => i.label),
    ['512×512 · ic09', '16×16 · is32', '2×2 · ic07']
  )
  assert.equal(doc.desc.images[0].unsupported, 'JPEG 2000')
  assert.deepEqual(
    doc.desc.notices.map((n) => [n.code, n.detail]),
    [['unsupported-images', 'JPEG 2000']]
  )
  assert.equal(doc.desc.primary, 1)
  const r = await doc.decode(1)
  assert.deepEqual(Array.from(r.data.subarray(0, 4)), [250, 0, 9, 128])
  assert.deepEqual(Array.from(r.data.subarray(254 * 4, 256 * 4)), [1, 0, 9, 128, 2, 0, 9, 128])
  assert.ok(!r.partial)
  assert.equal((await doc.decode(2)).data[0], 77)
  await assert.rejects(() => doc.decode(0), (e: unknown) => (e as { code?: string }).code === 'unsupported-compression')
})

test('ICNS: 1-bit icon with mask, 8-bit palette icon using it, ARGB, dark set', async () => {
  // ICN#: 32×32 1-bit image (top row black) then the mask (left half opaque).
  const icn = new Uint8Array(256)
  icn.fill(0xff, 0, 4)
  for (let y = 0; y < 32; y++) icn[128 + y * 4] = icn[128 + y * 4 + 1] = 0xff
  // icl8: index 0 (white) everywhere except pixel 1, index 255 (black), and pixel 2, index 215 (red ramp).
  const icl8 = new Uint8Array(1024)
  icl8[1] = 255
  icl8[2] = 215
  // ARGB 16×16: alpha 200, red 10, green 20, blue 30.
  const argb = new Uint8Array([0x41, 0x52, 0x47, 0x42, ...rleChannel(200, 256, []), ...rleChannel(10, 256, []), ...rleChannel(20, 256, []), ...rleChannel(30, 256, [])])
  const doc = await openDocument(icns([['ICN#', icn], ['icl8', icl8], ['ic04', argb]], [['ic04', argb]]), 'icns', stubDecoder)
  // ICN# is only the mask of icl8 here, so it is not listed on its own.
  assert.deepEqual(
    doc.desc.images.map((i) => i.label),
    ['32×32 · icl8', '16×16 · ic04', 'Dark · 16×16 · ic04']
  )
  const icon = await doc.decode(0)
  assert.deepEqual(Array.from(icon.data.subarray(0, 12)), [255, 255, 255, 255, 0, 0, 0, 255, 238, 0, 0, 255])
  // Right half of the mask is transparent.
  assert.equal(icon.data[(5 * 32 + 20) * 4 + 3], 0)
  assert.deepEqual(Array.from((await doc.decode(1)).data.subarray(0, 4)), [10, 20, 30, 200])
  assert.deepEqual(Array.from((await doc.decode(2)).data.subarray(0, 4)), [10, 20, 30, 200])
})

test('ICNS damaged: bad header, cut-off RLE shows what was read', async () => {
  await assert.rejects(() => openDocument(new Uint8Array([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 8]), 'icns', stubDecoder))
  const is32 = new Uint8Array(rleChannel(250, 256, []))
  const doc = await openDocument(icns([['is32', is32]]), 'icns', stubDecoder)
  const r = await doc.decode(0)
  assert.ok(r.partial)
  assert.equal(r.data[0], 250)
  assert.equal(r.data[3], 255)
})
