// QOI, TGA and Radiance HDR: small formats with their own parsers.

import { assert, test } from 'orca/testing'
import { inflate } from '../core/inflate'
import type { DocDesc } from '../core/model'
import { openDocument } from '../core/session'
import { ByteWriter } from '../fixtures/writer'

const platform = { inflate }

const item = (desc: DocDesc, section: string, key: string) => desc.info.find((s) => s.title === section)?.items.find((i) => i.key === key)?.value

const codeOf = (e: unknown) => (e as { code?: string }).code

const near = (a: ArrayLike<number>, b: number[], eps = 1e-6) => b.every((v, i) => Math.abs(a[i] - v) <= eps)

// ---------------------------------------------------------------- QOI

function qoi(width: number, height: number, channels: number, ops: number[]): Uint8Array {
  return new ByteWriter(false).ascii('qoif').u32(width).u32(height).u8(channels).u8(0).bytes(ops).zeros(7).u8(1).done()
}

test('QOI: every operation (RGB, difference, luma, run, RGBA, index)', async () => {
  const ops = [
    0xfe, 10, 20, 30, // RGB
    0x76, // difference: +1, −1, 0
    0xaa, 0xa5, // luma: green +10, red +12, blue +7
    0xc1, // run of 2
    0xff, 1, 2, 3, 128, // RGBA
    0x09 // index 9: the first colour
  ]
  const doc = await openDocument(qoi(7, 1, 4, ops), 'qoi', platform)
  assert.equal(doc.desc.format, 'QOI')
  assert.equal(item(doc.desc, 'image', 'channels'), 'RGBA')
  const r = await doc.decode(0)
  assert.deepEqual(Array.from(r.data), [10, 20, 30, 255, 11, 19, 30, 255, 23, 29, 37, 255, 23, 29, 37, 255, 23, 29, 37, 255, 1, 2, 3, 128, 10, 20, 30, 255])
  assert.ok(!r.partial)
})

test('QOI damaged: a cut-off stream keeps the pixels read, a bad channel count is refused', async () => {
  const full = qoi(4, 1, 3, [0xfe, 1, 2, 3, 0xfe, 4, 5, 6, 0xc1])
  const cut = await openDocument(full.subarray(0, 14 + 8), 'qoi', platform)
  const r = await cut.decode(0)
  assert.ok(r.partial)
  assert.deepEqual(Array.from(r.data.subarray(0, 6)), [1, 2, 3, 4, 5, 6])
  await assert.rejects(
    () => openDocument(qoi(1, 1, 5, [0xfe, 1, 2, 3]), 'qoi', platform),
    (e: unknown) => codeOf(e) === 'damaged'
  )
})

// ---------------------------------------------------------------- TGA

interface TgaSpec {
  type: number
  width: number
  height: number
  depth: number
  descriptor?: number
  map?: { depth: number; entries: number[] }
  id?: string
  data: number[]
}

function tga(s: TgaSpec, extension?: (w: ByteWriter) => void): Uint8Array {
  const w = new ByteWriter(true)
  const id = s.id ?? ''
  const mapEntries = s.map ? s.map.entries.length / Math.ceil(s.map.depth / 8) : 0
  w.u8(id.length).u8(s.map ? 1 : 0).u8(s.type).u16(0).u16(mapEntries).u8(s.map?.depth ?? 0)
  w.u16(0).u16(0).u16(s.width).u16(s.height).u8(s.depth).u8(s.descriptor ?? 0)
  w.ascii(id)
  if (s.map) w.bytes(s.map.entries)
  w.bytes(s.data)
  if (extension) {
    // TGA 2.0: the extension area, then the footer that points to it.
    const at = w.length
    extension(w)
    w.u32(at).u32(0).ascii('TRUEVISION-XFILE.').u8(0)
  }
  return w.done()
}

/** A 495-byte TGA 2.0 extension area. */
function tgaExtension(author: string, software: string, attributes: number) {
  return (w: ByteWriter) => {
    const start = w.length
    const field = (s: string, n: number) => w.ascii(s).zeros(n - s.length)
    w.u16(495)
    field(author, 41)
    w.zeros(324)
    w.u16(5).u16(17).u16(2026).u16(13).u16(30).u16(0)
    field('', 41)
    w.zeros(6)
    field(software, 41)
    w.u16(120).u8(0x62)
    w.zeros(start + 494 - w.length)
    w.u8(attributes)
  }
}

test('TGA: true colour bottom-up, RLE with alpha top-down, colour map, grey with alpha, 16-bit', async () => {
  // 2×2 BGR, bottom row first.
  const bottomUp = await openDocument(tga({ type: 2, width: 2, height: 2, depth: 24, data: [3, 2, 1, 6, 5, 4, 30, 20, 10, 60, 50, 40] }), 'tga', platform)
  assert.deepEqual(Array.from((await bottomUp.decode(0)).data), [10, 20, 30, 255, 40, 50, 60, 255, 1, 2, 3, 255, 4, 5, 6, 255])
  assert.equal(item(bottomUp.desc, 'image', 'origin'), 'Bottom-left')

  // 3×1 RLE BGRA, top-left origin with 8 alpha bits: a run of two, then one raw pixel.
  const rle = await openDocument(tga({ type: 10, width: 3, height: 1, depth: 32, descriptor: 0x28, data: [0x81, 30, 20, 10, 128, 0x00, 3, 2, 1, 255] }), 'tga', platform)
  const r = await rle.decode(0)
  assert.ok(r.alpha)
  assert.deepEqual(Array.from(r.data), [10, 20, 30, 128, 10, 20, 30, 128, 1, 2, 3, 255])
  assert.equal(item(rle.desc, 'image', 'compression'), 'RLE')

  // Colour-mapped: two 24-bit entries (BGR).
  const mapped = await openDocument(tga({ type: 1, width: 2, height: 1, depth: 8, descriptor: 0x20, map: { depth: 24, entries: [255, 0, 0, 0, 0, 255] }, data: [1, 0] }), 'tga', platform)
  assert.deepEqual(Array.from((await mapped.decode(0)).data), [255, 0, 0, 255, 0, 0, 255, 255])
  assert.equal(item(mapped.desc, 'image', 'paletteSize'), '2')

  // Grey with alpha, RLE.
  const grey = await openDocument(tga({ type: 11, width: 2, height: 1, depth: 16, descriptor: 0x28, data: [0x81, 90, 200] }), 'tga', platform)
  assert.deepEqual(Array.from((await grey.decode(0)).data), [90, 90, 90, 200, 90, 90, 90, 200])

  // A1R5G5B5: pure red with the attribute bit set, and blue without it.
  const five = await openDocument(tga({ type: 2, width: 2, height: 1, depth: 16, descriptor: 0x21, data: [0x00, 0xfc, 0x1f, 0x00] }), 'tga', platform)
  const f = await five.decode(0)
  assert.deepEqual(Array.from(f.data), [255, 0, 0, 255, 0, 0, 255, 0])
})

test('TGA 2.0 extension area: author, software, date and the alpha meaning', async () => {
  const pixels = { type: 2, width: 1, height: 1, depth: 32, descriptor: 0x28, data: [3, 2, 1, 0], id: 'Test id' }
  // Attributes 3: real alpha (here zero, so fully transparent).
  const kept = await openDocument(tga(pixels, tgaExtension('Test Author', 'Paint', 3)), 'tga', platform)
  const d = kept.desc
  assert.equal(item(d, 'file', 'author'), 'Test Author')
  assert.equal(item(d, 'file', 'software'), 'Paint 1.20b')
  assert.equal(item(d, 'file', 'created'), '2026-05-17 13:30:00')
  assert.equal(item(d, 'file', 'alphaType'), 'Alpha')
  assert.equal(item(d, 'image', 'imageId'), 'Test id')
  // All-zero alpha is shown opaque, as most writers that leave it empty mean.
  assert.equal((await kept.decode(0)).data[3], 255)
  // Attributes 0: no alpha, whatever the pixels hold.
  const none = await openDocument(tga({ ...pixels, data: [3, 2, 1, 77] }, tgaExtension('', '', 0)), 'tga', platform)
  const n = await none.decode(0)
  assert.equal(n.data[3], 255)
  assert.ok(!n.alpha)
})

test('TGA damaged: cut-off pixels are partial, Huffman TGA is refused', async () => {
  const full = tga({ type: 2, width: 2, height: 2, depth: 24, descriptor: 0x20, data: [3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10] })
  const cut = await openDocument(full.subarray(0, full.length - 6), 'tga', platform)
  const r = await cut.decode(0)
  assert.ok(r.partial)
  assert.deepEqual(Array.from(r.data.subarray(0, 8)), [1, 2, 3, 255, 4, 5, 6, 255])
  await assert.rejects(
    () => openDocument(tga({ type: 32, width: 1, height: 1, depth: 8, data: [0] }), 'tga', platform),
    (e: unknown) => codeOf(e) === 'unsupported-compression'
  )
})

// ---------------------------------------------------------------- Radiance HDR

function hdr(header: string[], resolution: string, data: number[]): Uint8Array {
  return new ByteWriter(false)
    .ascii(`#?RADIANCE\n${header.map((l) => `${l}\n`).join('')}\n${resolution}\n`)
    .bytes(data)
    .done()
}

/** One RGBE pixel's value: (m + 0.5) × 2^(e − 136). */
const rgbe = (m: number, e: number) => (m + 0.5) * 2 ** (e - 136)

test('Radiance HDR: flat pixels, header fields, old and new run-length scanlines', async () => {
  const doc = await openDocument(
    hdr(['FORMAT=32-bit_rle_rgbe', 'EXPOSURE=2', 'SOFTWARE=Test renderer'], '-Y 2 +X 2', [128, 64, 32, 129, 0, 0, 0, 0, 1, 2, 3, 128, 255, 255, 255, 140]),
    'hdr',
    platform
  )
  const d = doc.desc
  assert.equal(d.format, 'Radiance HDR')
  assert.equal(item(d, 'image', 'exposureHeader'), '2')
  assert.equal(item(d, 'image', 'software'), 'Test renderer')
  const r = await doc.decode(0)
  assert.equal(r.kind, 'f32')
  assert.equal(r.transfer, 'linear')
  assert.ok(near(r.data, [rgbe(128, 129), rgbe(64, 129), rgbe(32, 129), 0, 0, 0, rgbe(1, 128), rgbe(2, 128), rgbe(3, 128), rgbe(255, 140), rgbe(255, 140), rgbe(255, 140)]))

  // New RLE, 8 wide: red a run, green literals, blue a run of zero, exponent a run.
  const rle = await openDocument(hdr(['FORMAT=32-bit_rle_rgbe'], '-Y 1 +X 8', [2, 2, 0, 8, 0x88, 200, 8, 1, 2, 3, 4, 5, 6, 7, 8, 0x88, 0, 0x88, 128]), 'pic', platform)
  const n = await rle.decode(0)
  assert.ok(near(n.data.subarray(0, 3), [rgbe(200, 128), rgbe(1, 128), rgbe(0, 128)]))
  assert.ok(near(n.data.subarray(21, 24), [rgbe(200, 128), rgbe(8, 128), rgbe(0, 128)]))

  // Old RLE: a pixel, then 1,1,1,n repeats it n times.
  const old = await openDocument(hdr([], '-Y 1 +X 4', [10, 20, 30, 128, 1, 1, 1, 3]), 'hdr', platform)
  const o = await old.decode(0)
  assert.ok(near(o.data.subarray(9, 12), [rgbe(10, 128), rgbe(20, 128), rgbe(30, 128)]))
})

test('Radiance HDR scan orders: bottom-up and column-major', async () => {
  // Values above 1: a pixel of 1, 1, 1 is the old run-length marker.
  const px = (v: number) => [v, v, v, 128]
  // Scanlines from the bottom: the first one stored is the last row.
  const up = await openDocument(hdr([], '+Y 2 +X 1', [...px(11), ...px(12)]), 'hdr', platform)
  const u = await up.decode(0)
  assert.ok(near([u.data[0], u.data[3]], [rgbe(12, 128), rgbe(11, 128)]))
  // Columns: three scanlines along Y, each two pixels from the top.
  const cols = await openDocument(hdr([], '+X 3 -Y 2', [...px(11), ...px(12), ...px(13), ...px(14), ...px(15), ...px(16)]), 'hdr', platform)
  assert.deepEqual([cols.desc.images[0].width, cols.desc.images[0].height], [3, 2])
  const c = await cols.decode(0)
  // Row 0: 11, 13, 15; row 1: 12, 14, 16.
  assert.ok(near([0, 1, 2, 3, 4, 5].map((i) => c.data[i * 3]), [11, 13, 15, 12, 14, 16].map((v) => rgbe(v, 128))))
})

test('Radiance HDR damaged: cut-off scanlines are partial, a bad resolution line is refused', async () => {
  const cut = await openDocument(hdr([], '-Y 2 +X 1', [5, 5, 5, 128]), 'hdr', platform)
  const r = await cut.decode(0)
  assert.ok(r.partial)
  assert.ok(near(r.data.subarray(0, 3), [rgbe(5, 128), rgbe(5, 128), rgbe(5, 128)]))
  assert.deepEqual(Array.from(r.data.subarray(3)), [0, 0, 0])
  await assert.rejects(
    () => openDocument(hdr([], '-Y 2 +Y 1', [5, 5, 5, 128]), 'hdr', platform),
    (e: unknown) => codeOf(e) === 'damaged'
  )
})
