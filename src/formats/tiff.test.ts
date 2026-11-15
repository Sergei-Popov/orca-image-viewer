import { assert, test } from 'orca/testing'
import { lzwEncode } from '../codecs/lzw'
import { packbitsEncode } from '../codecs/packbits'
import { applyFloatingPoint, applyHorizontal } from '../codecs/predictor'
import { toHalf } from '../core/half'
import { inflate } from '../core/inflate'
import type { DocDesc } from '../core/model'
import { openDocument } from '../core/session'
import { zlib } from '../fixtures/exr'
import { tiff, type TiffIfd, type TiffValue } from '../fixtures/tiff'
import { ByteWriter } from '../fixtures/writer'

const platform = { inflate }

const item = (desc: DocDesc, section: string, key: string) => desc.info.find((s) => s.title === section)?.items.find((i) => i.key === key)?.value

const codeOf = (e: unknown) => (e as { code?: string }).code

interface Spec {
  width: number
  height: number
  bps?: number
  spp?: number
  photometric: number
  compression?: number
  rowsPerStrip?: number
  strips?: Uint8Array[]
  tiles?: { width: number; height: number; data: Uint8Array[] }
  extra?: TiffValue[]
}

/** An image directory with the baseline tags. */
function image(s: Spec): TiffIfd {
  const spp = s.spp ?? 1
  const blocks = s.tiles ? s.tiles.data : (s.strips ?? [])
  const entries: TiffValue[] = [
    { tag: 256, type: 4, values: [s.width] },
    { tag: 257, type: 4, values: [s.height] },
    { tag: 258, type: 3, values: new Array(spp).fill(s.bps ?? 8) },
    { tag: 259, type: 3, values: [s.compression ?? 1] },
    { tag: 262, type: 3, values: [s.photometric] },
    { tag: 277, type: 3, values: [spp] },
    ...(s.extra ?? [])
  ]
  if (s.tiles) {
    entries.push(
      { tag: 322, type: 3, values: [s.tiles.width] },
      { tag: 323, type: 3, values: [s.tiles.height] },
      { tag: 324, data: blocks },
      { tag: 325, type: 4, values: blocks.map((b) => b.length) }
    )
  } else {
    entries.push(
      { tag: 273, data: blocks },
      { tag: 278, type: 4, values: [s.rowsPerStrip ?? s.height] },
      { tag: 279, type: 4, values: blocks.map((b) => b.length) }
    )
  }
  return { entries }
}

const range = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i))

test('TIFF pages: RGB strips, 16-bit grey LZW with predictor, 4-bit palette PackBits', async () => {
  // Page 1: 4×3 RGB in two strips.
  const rgb = range(36, (i) => (i * 7) & 255)
  const page1 = image({ width: 4, height: 3, spp: 3, photometric: 2, rowsPerStrip: 2, strips: [rgb.subarray(0, 24), rgb.subarray(24)] })
  page1.entries.push({ tag: 305, text: 'Test writer 1.0' }, { tag: 315, text: 'A. Tester' }, { tag: 285, text: 'Cover' })
  // Page 2: 5×2 16-bit grey, horizontal predictor then LZW.
  const grey = new Uint8Array(20)
  const view = new DataView(grey.buffer)
  for (let i = 0; i < 10; i++) view.setUint16(i * 2, i * 1000 + 7, true)
  const predicted = grey.slice()
  applyHorizontal(predicted, 2, 10, 5, 1, 16, true)
  const page2 = image({ width: 5, height: 2, bps: 16, photometric: 1, compression: 5, strips: [lzwEncode(predicted)], extra: [{ tag: 317, type: 3, values: [2] }] })
  // Page 3: 4×2 palette, 4 bits per pixel, PackBits. Colour k is red k × 17, blue (15 − k) × 17.
  const map = [...range(16, (k) => k), ...new Array(16).fill(0), ...range(16, (k) => 15 - k)].map((v) => v * 0x1111)
  const page3 = image({
    width: 4,
    height: 2,
    bps: 4,
    photometric: 3,
    compression: 32773,
    strips: [packbitsEncode(new Uint8Array([0x01, 0x23, 0xff, 0xff]))],
    extra: [{ tag: 320, type: 3, values: map }]
  })
  const doc = await openDocument(tiff([page1, page2, page3]), 'tif', platform)
  const d = doc.desc
  assert.equal(d.format, 'TIFF')
  assert.deepEqual(
    d.images.map((i) => i.label),
    ['Page 1 · Cover', 'Page 2', 'Page 3']
  )
  assert.equal(d.list, 'page')
  assert.equal(item(d, 'file', 'pages'), '3')
  assert.equal(item(d, 'file', 'software'), 'Test writer 1.0')
  assert.equal(item(d, 'file', 'artist'), 'A. Tester')

  const r1 = await doc.decode(0)
  assert.deepEqual(Array.from(r1.data), Array.from(rgb))
  const r2 = await doc.decode(1)
  assert.equal(r2.kind, 'u16')
  assert.deepEqual(
    Array.from(r2.data),
    Array.from({ length: 10 }, (_, i) => i * 1000 + 7)
  )
  const r3 = await doc.decode(2)
  assert.equal(r3.channels, 3)
  assert.deepEqual(Array.from(r3.data.subarray(0, 6)), [0, 0, 255, 17, 0, 238])
  assert.deepEqual(Array.from(r3.data.subarray(12, 15)), [255, 0, 0])
  assert.ok(!r1.partial && !r2.partial && !r3.partial)
})

test('TIFF tiles stored through StripOffsets and StripByteCounts (old SGI writers) are read as tiles', async () => {
  // A 20 × 20 grey image in four 16 × 16 tiles; tile k holds 10·k + its row within the tile.
  const tile = (k: number) => range(256, (i) => 10 * k + (i >> 4))
  const data = [0, 1, 2, 3].map(tile)
  const entries: TiffValue[] = [
    { tag: 256, type: 4, values: [20] },
    { tag: 257, type: 4, values: [20] },
    { tag: 258, type: 3, values: [8] },
    { tag: 259, type: 3, values: [1] },
    { tag: 262, type: 3, values: [1] },
    { tag: 273, data },
    { tag: 277, type: 3, values: [1] },
    { tag: 279, type: 4, values: data.map((b) => b.length) },
    { tag: 322, type: 3, values: [16] },
    { tag: 323, type: 3, values: [16] }
  ]
  const r = await (await openDocument(tiff([{ entries }]), 'tif', platform)).decode(0)
  const at = (x: number, y: number) => r.data[y * r.width + x]
  assert.deepEqual([at(0, 0), at(15, 5), at(16, 0), at(19, 15), at(0, 16), at(17, 19)], [0, 5, 10, 25, 20, 33])
})

test('TIFF tiles: big-endian 16-bit RGB in separate planes, Deflate, edge tiles', async () => {
  const W = 20
  const H = 10
  const tile = async (plane: number, tx: number) => {
    const t = new ByteWriter(false)
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const gx = tx * 16 + x
        t.u16(gx < W && y < H ? plane * 10000 + y * 100 + gx : 0)
      }
    }
    return zlib(t.done())
  }
  const data: Uint8Array[] = []
  for (let p = 0; p < 3; p++) for (let tx = 0; tx < 2; tx++) data.push(await tile(p, tx))
  const ifd = image({ width: W, height: H, bps: 16, spp: 3, photometric: 2, compression: 8, tiles: { width: 16, height: 16, data }, extra: [{ tag: 284, type: 3, values: [2] }] })
  const doc = await openDocument(tiff([ifd], { little: false }), 'tiff', platform)
  assert.equal(item(doc.desc, 'image', 'layout'), '6 tiles of 16 × 16')
  assert.equal(item(doc.desc, 'file', 'byteOrder'), 'Big-endian (MM)')
  const r = await doc.decode(0)
  assert.equal(r.kind, 'u16')
  const at = (5 * W + 17) * 3
  assert.deepEqual(Array.from(r.data.subarray(at, at + 3)), [517, 10517, 20517])
})

test('TIFF floats and orientation: float grey is data with a range, half RGB stays half, rotation', async () => {
  // 3×2 float grey, floating-point predictor.
  const values = [-1.5, 0, 2.25, 10, 0.5, 3]
  const floats = new ByteWriter(false)
  for (const v of values) floats.f32(v)
  const predicted = floats.done()
  applyFloatingPoint(predicted, 2, 12, 3, 1, 32)
  const f32 = image({ width: 3, height: 2, bps: 32, photometric: 1, strips: [predicted], extra: [{ tag: 317, type: 3, values: [3] }, { tag: 339, type: 3, values: [3] }] })
  // 2×1 half-float RGB.
  const halves = new ByteWriter(true)
  for (const v of [1, 0.5, 0.25, 4, 2, 1]) halves.u16(toHalf(v))
  const f16 = image({ width: 2, height: 1, bps: 16, spp: 3, photometric: 2, strips: [halves.done()], extra: [{ tag: 339, type: 3, values: [3, 3, 3] }] })
  // 3×2 grey turned a quarter clockwise (orientation 6).
  const turned = image({ width: 3, height: 2, photometric: 1, strips: [new Uint8Array([1, 2, 3, 4, 5, 6])], extra: [{ tag: 274, type: 3, values: [6] }] })
  const doc = await openDocument(tiff([f32, f16, turned]), 'tif', platform)

  const a = await doc.decode(0)
  assert.equal(a.kind, 'f32')
  assert.equal(a.transfer, 'data')
  assert.deepEqual(Array.from(a.data), values)
  assert.deepEqual(a.range, [-1.5, 10])

  const b = await doc.decode(1)
  assert.equal(b.kind, 'f16')
  assert.equal(b.transfer, 'linear')
  assert.deepEqual(
    Array.from(b.data),
    [1, 0.5, 0.25, 4, 2, 1].map(toHalf)
  )

  assert.deepEqual([doc.desc.images[2].width, doc.desc.images[2].height], [2, 3])
  const c = await doc.decode(2)
  assert.deepEqual([c.width, c.height], [2, 3])
  assert.deepEqual(Array.from(c.data), [4, 1, 5, 2, 6, 3])
})

test('TIFF colour models: CMYK, subsampled YCbCr, CIELAB, 1-bit white-is-zero, alpha kinds', async () => {
  const cmyk = image({ width: 2, height: 1, spp: 4, photometric: 5, strips: [new Uint8Array([0, 0, 0, 0, 0, 255, 255, 0])] })
  // 4×2 YCbCr with 2×2 subsampling: two units of four luma samples, then Cb and Cr.
  const ycc = image({
    width: 4,
    height: 2,
    spp: 3,
    photometric: 6,
    strips: [new Uint8Array([100, 100, 100, 100, 128, 128, 200, 200, 200, 200, 128, 128])],
    extra: [{ tag: 530, type: 3, values: [2, 2] }]
  })
  const lab = image({ width: 2, height: 1, spp: 3, photometric: 8, strips: [new Uint8Array([255, 0, 0, 0, 0, 0])] })
  const bilevel = image({ width: 8, height: 1, bps: 1, photometric: 0, strips: [new Uint8Array([0xa0])] })
  const straight = image({ width: 1, height: 1, spp: 4, photometric: 2, strips: [new Uint8Array([10, 20, 30, 40])], extra: [{ tag: 338, type: 3, values: [2] }] })
  const premultiplied = image({ width: 1, height: 1, spp: 4, photometric: 2, strips: [new Uint8Array([10, 20, 30, 40])], extra: [{ tag: 338, type: 3, values: [1] }] })
  const doc = await openDocument(tiff([cmyk, ycc, lab, bilevel, straight, premultiplied]), 'tif', platform)

  const c = await doc.decode(0)
  assert.deepEqual(Array.from(c.data), [255, 255, 255, 255, 0, 0])
  assert.deepEqual(
    c.notices?.map((n) => n.code),
    ['cmyk-converted']
  )
  const y = await doc.decode(1)
  assert.deepEqual(Array.from(y.data.subarray(0, 3)), [100, 100, 100])
  assert.deepEqual(Array.from(y.data.subarray((1 * 4 + 3) * 3, (1 * 4 + 3) * 3 + 3)), [200, 200, 200])
  const l = await doc.decode(2)
  assert.ok(l.data[0] >= 254 && l.data[1] >= 254 && l.data[2] >= 254)
  assert.deepEqual(Array.from(l.data.subarray(3)), [0, 0, 0])
  assert.deepEqual(Array.from((await doc.decode(3)).data), [0, 255, 0, 255, 255, 255, 255, 255])
  const s = await doc.decode(4)
  assert.ok(s.alpha && !s.premultiplied)
  const p = await doc.decode(5)
  assert.ok(p.alpha && p.premultiplied)
})

test('TIFF JPEG strips share the JPEGTables tables', async () => {
  const tables = new ByteWriter(false).u8(0xff).u8(0xd8).u8(0xff).u8(0xdb).u16(67).u8(0)
  for (let i = 0; i < 64; i++) tables.u8(1)
  tables.u8(0xff).u8(0xd9)
  // A strip: SOI, SOF0 (8×8), SOS, a few entropy bytes, EOI; no tables of its own.
  const strip = () => {
    const w = new ByteWriter(false).u8(0xff).u8(0xd8)
    w.u8(0xff).u8(0xc0).u16(17).u8(8).u16(8).u16(8).u8(3)
    for (let c = 1; c <= 3; c++) w.u8(c).u8(0x11).u8(0)
    w.u8(0xff).u8(0xda).u16(12).u8(3)
    for (let c = 1; c <= 3; c++) w.u8(c).u8(0)
    return w.u8(0).u8(63).u8(0).u8(0x12).u8(0x34).u8(0xff).u8(0xd9).done()
  }
  let calls = 0
  const jpegPlatform = {
    inflate,
    decodeImage: async (data: Uint8Array) => {
      // The tables come first, then the strip without its own start marker.
      assert.deepEqual(Array.from(data.subarray(0, 4)), [0xff, 0xd8, 0xff, 0xdb])
      assert.equal(data.indexOf(0xd8, 2), -1)
      calls++
      return { width: 8, height: 8, data: new Uint8Array(256).fill(calls * 50) }
    }
  }
  const ifd = image({ width: 8, height: 16, spp: 3, photometric: 6, compression: 7, rowsPerStrip: 8, strips: [strip(), strip()], extra: [{ tag: 347, bytes: tables.done() }] })
  const doc = await openDocument(tiff([ifd]), 'tif', jpegPlatform)
  const r = await doc.decode(0)
  assert.equal(calls, 2)
  assert.equal(r.channels, 3)
  assert.equal(r.data[0], 50)
  assert.equal(r.data[(15 * 8) * 3], 100)
})

/** A minimal ICC profile header with a `desc` tag. */
function icc(description: string): Uint8Array {
  const text = new TextEncoder().encode(description)
  const tagAt = 128 + 4 + 12
  const size = tagAt + 12 + text.length + 1
  const w = new ByteWriter(false).u32(size).ascii('test').u8(4).u8(0x30).u16(0).ascii('mntr').ascii('RGB ').ascii('XYZ ').zeros(12).ascii('acsp')
  w.zeros(128 - w.length)
  w.u32(1).ascii('desc').u32(tagAt).u32(12 + text.length + 1)
  return w.ascii('desc').u32(0).u32(text.length + 1).bytes(text).u8(0).done()
}

test('TIFF metadata: EXIF camera details, XMP and the ICC profile', async () => {
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Test Person</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>'
  const ifd = image({
    width: 1,
    height: 1,
    photometric: 1,
    strips: [new Uint8Array([9])],
    extra: [
      { tag: 271, text: 'Test Camera Co' },
      { tag: 272, text: 'Model 9' },
      { tag: 700, type: 1, bytes: new TextEncoder().encode(xmp) },
      { tag: 34675, bytes: icc('Test RGB profile') },
      { tag: 34665, ifd: { entries: [{ tag: 0x829a, type: 5, values: [1, 125] }, { tag: 0x8827, type: 3, values: [400] }] } },
      // GPS time with a fraction of a second: 23:59:30.5.
      { tag: 34853, ifd: { entries: [{ tag: 7, type: 5, values: [23, 1, 59, 1, 305, 10] }, { tag: 29, text: '2024:02:29' }] } }
    ]
  })
  const doc = await openDocument(tiff([ifd]), 'tif', platform)
  const d = doc.desc
  assert.equal(item(d, 'image', 'iccProfile'), 'Test RGB profile')
  assert.equal(item(d, 'image', 'iccDetails'), 'RGB · Display · v4.3')
  assert.equal(item(d, 'xmp', 'dc:creator'), 'Test Person')
  assert.ok(item(d, 'camera', 'camera')?.includes('Model 9'))
  assert.ok(item(d, 'camera', 'exposure')?.includes('1/125 s'))
  assert.equal(item(d, 'gps', 'gpsTime'), '2024-02-29 23:59:30.5 UTC')
})

test('BigTIFF: 64-bit offsets and counts', async () => {
  const w = new ByteWriter(true).ascii('II').u16(43).u16(8).u16(0).u64(16)
  const entries: [number, number, number][] = [
    [256, 3, 2],
    [257, 3, 2],
    [258, 3, 8],
    [259, 3, 1],
    [262, 3, 1],
    [273, 16, 16 + 8 + 9 * 20 + 8],
    [277, 3, 1],
    [278, 3, 2],
    [279, 16, 4]
  ]
  w.u64(entries.length)
  for (const [tag, type, value] of entries) {
    w.u16(tag).u16(type).u64(1)
    if (type === 3) w.u16(value).zeros(6)
    else w.u64(value)
  }
  w.u64(0).bytes([10, 20, 30, 40])
  const doc = await openDocument(w.done(), 'tif', platform)
  assert.equal(doc.desc.format, 'BigTIFF')
  assert.deepEqual(Array.from((await doc.decode(0)).data), [10, 20, 30, 40])
})

test('TIFF damaged and unsupported: short header, cut-off strip, no images, JPEG 2000, sensor data', async () => {
  await assert.rejects(() => openDocument(new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0]), 'tif', platform))
  await assert.rejects(
    () => openDocument(tiff([{ entries: [{ tag: 271, text: 'Nobody' }] }]), 'tif', platform),
    (e: unknown) => codeOf(e) === 'damaged'
  )
  const full = tiff([image({ width: 4, height: 4, photometric: 1, strips: [range(16, (i) => i + 1)] })])
  const cut = await openDocument(full.subarray(0, full.length - 8), 'tif', platform)
  const r = await cut.decode(0)
  assert.ok(r.partial)
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0])

  const odd = await openDocument(
    tiff([
      image({ width: 2, height: 2, photometric: 2, spp: 3, compression: 34712, strips: [new Uint8Array(12)] }),
      image({ width: 2, height: 2, bps: 16, photometric: 32803, strips: [new Uint8Array(8)] })
    ]),
    'tif',
    platform
  )
  await assert.rejects(
    () => odd.decode(0),
    (e: unknown) => codeOf(e) === 'unsupported-compression'
  )
  await assert.rejects(
    () => odd.decode(1),
    (e: unknown) => codeOf(e) === 'unsupported-pixels'
  )
})

test('TIFF without StripByteCounts: 130,000 one-row strips run to the next offset, found in sorted order', async () => {
  const n = 130_000
  const strips = Array.from({ length: n }, (_, i) => Uint8Array.of(i % 251))
  const file = tiff([
    {
      entries: [
        { tag: 256, type: 3, values: [1] },
        { tag: 257, type: 4, values: [n] },
        { tag: 258, type: 3, values: [8] },
        { tag: 259, type: 3, values: [1] },
        { tag: 262, type: 3, values: [1] },
        { tag: 273, type: 4, data: strips },
        { tag: 277, type: 3, values: [1] },
        { tag: 278, type: 3, values: [1] }
      ]
    }
  ])
  const started = Date.now()
  const doc = await openDocument(file, 'tif', platform)
  const r = await doc.decode(0)
  assert.ok(Date.now() - started < 3000, 'no quadratic search, no spread into Math.min')
  assert.deepEqual([r.width, r.height], [1, n])
  assert.deepEqual([r.data[0], r.data[1], r.data[250], r.data[251], r.data[n - 1]], [0, 1, 250, 0, (n - 1) % 251])
})

test('TIFF details in Russian: the readers’ wording is translated, plurals included', async () => {
  const { englishLeft } = await import('../fixtures/russian')
  const { infoValue, stringsFor } = await import('../i18n')
  const one = (n: number) => new Uint8Array(n)
  const pages = [
    image({ width: 2, height: 1, spp: 5, photometric: 5, compression: 8, strips: [one(10)], extra: [{ tag: 284, type: 3, values: [2] }, { tag: 317, type: 3, values: [2] }, { tag: 338, type: 3, values: [2] }, { tag: 274, type: 3, values: [6] }] }),
    image({ width: 16, height: 16, spp: 4, photometric: 2, compression: 5, tiles: { width: 16, height: 16, data: [one(1024)] }, extra: [{ tag: 338, type: 3, values: [1] }, { tag: 274, type: 3, values: [2] }] }),
    image({ width: 4, height: 2, bps: 4, photometric: 3, compression: 32773, rowsPerStrip: 1, strips: [one(2), one(2)], extra: [{ tag: 320, type: 3, values: new Array(48).fill(0) }] }),
    image({ width: 2, height: 1, bps: 32, photometric: 1, compression: 50000, strips: [one(8)], extra: [{ tag: 339, type: 3, values: [3] }, { tag: 317, type: 3, values: [3] }] }),
    image({ width: 1, height: 1, bps: 16, photometric: 0, compression: 4, strips: [one(2)], extra: [{ tag: 339, type: 3, values: [2] }, { tag: 254, type: 4, values: [1] }] }),
    image({ width: 1, height: 1, photometric: 32803, compression: 7, strips: [one(1)], extra: [{ tag: 254, type: 4, values: [4] }] }),
    image({ width: 1, height: 1, photometric: 2, spp: 3, compression: 34925, strips: [one(3)], extra: [{ tag: 274, type: 3, values: [8] }] })
  ]
  const doc = await openDocument(tiff(pages), 'tif', platform)
  assert.deepEqual(englishLeft(doc.desc), [])
  const ru = stringsFor('ru')
  const layouts = doc.desc.images.map((i) => i.info.find((x) => x.key === 'layout')?.value)
  assert.deepEqual(layouts.slice(0, 3), ['1 strip of 1 row', '1 tile of 16 × 16', '2 strips of 1 row'])
  assert.deepEqual(layouts.slice(0, 3).map((v) => infoValue(ru, 'layout', v ?? '')), ['1 полоса по 1 строке', '1 плитка 16 × 16', '2 полосы по 1 строке'])
  assert.equal(infoValue(ru, 'layout', '25 strips of 5 rows'), '25 полос по 5 строк')
  assert.equal(infoValue(ru, 'pages', '3 (21 images)'), '3 (21 изображение)')
})
