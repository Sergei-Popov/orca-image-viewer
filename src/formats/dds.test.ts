import { assert, test } from 'orca/testing'
import { decodeBc } from '../codecs/bc'
import { halfToFloat, toHalf } from '../core/half'
import { inflate } from '../core/inflate'
import { openDocument } from '../core/session'
import { bc1Block, BlockWriter, dds, rgb565 } from '../fixtures/dds'
import { ByteWriter } from '../fixtures/writer'

const platform = { inflate }

const open = (bytes: Uint8Array) => openDocument(bytes, 'dds', platform)

test('BC1: four colours, and three colours with transparent black', () => {
  const red = rgb565(255, 0, 0)
  const blue = rgb565(0, 0, 255)
  const four = decodeBc('bc1', bc1Block(red, blue, [0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0, 4, 4)
  assert.deepEqual(Array.from(four.subarray(0, 16)), [255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255, 85, 0, 170, 255])
  const three = decodeBc('bc1', bc1Block(blue, red, [0, 1, 2, 3, ...new Array(12).fill(3)]), 0, 4, 4)
  assert.deepEqual(Array.from(three.subarray(8, 16)), [128, 0, 128, 255, 0, 0, 0, 0])
})

test('BC7 mode 6: endpoints with P-bits and 4-bit weights', () => {
  const w = new BlockWriter().put(64, 7)
  const e0 = [100, 50, 25]
  const e1 = [0, 127, 10]
  for (let c = 0; c < 3; c++) w.put(e0[c], 7).put(e1[c], 7)
  w.put(127, 7).put(0, 7) // alpha
  w.put(1, 1).put(0, 1) // P-bits
  // Pixel 0 (the anchor) has 3 bits, the others 4.
  w.put(0, 3).put(15, 4).put(8, 4)
  for (let i = 3; i < 16; i++) w.put(0, 4)
  const px = decodeBc('bc7', w.done(), 0, 4, 4)
  assert.deepEqual(Array.from(px.subarray(0, 4)), [201, 101, 51, 255])
  assert.deepEqual(Array.from(px.subarray(4, 8)), [0, 254, 20, 0])
  const mix = (a: number, b: number) => ((64 - 34) * a + 34 * b + 32) >> 6
  assert.deepEqual(Array.from(px.subarray(8, 12)), [mix(201, 0), mix(101, 254), mix(51, 20), mix(255, 0)])
})

test('BC6H mode 11: unsigned 10-bit endpoints unquantize to half floats', () => {
  const w = new BlockWriter().put(3, 5)
  w.put(1023, 10).put(0, 10).put(512, 10) // endpoint 0: R G B
  w.put(0, 10).put(0, 10).put(0, 10) // endpoint 1
  w.put(0, 3)
  for (let i = 1; i < 16; i++) w.put(0, 4)
  const px = decodeBc('bc6h', w.done(), 0, 4, 4) as Uint16Array
  const unq = ((512 << 16) + 0x8000) >> 10
  assert.deepEqual(Array.from(px.subarray(0, 3)), [0x7bff, 0, (unq * 31) >> 6])
  assert.equal(halfToFloat(px[0]), 65504)
})

test('DDS DX10 cube array with mips: axes, labels and every surface in file order', async () => {
  const W = 8
  const H = 4
  const mips = 3
  const data = new ByteWriter(true)
  const colourOf = (a: number, f: number, l: number) => [a * 100 + 10, f * 40, l * 80, 255]
  for (let a = 0; a < 2; a++) {
    for (let f = 0; f < 6; f++) {
      for (let l = 0; l < mips; l++) {
        const n = Math.max(1, W >> l) * Math.max(1, H >> l)
        for (let i = 0; i < n; i++) data.bytes(colourOf(a, f, l))
      }
    }
  }
  const doc = await open(dds({ width: W, height: H, mips, dxgi: 28, cube: true, arraySize: 2, data: data.done() }))
  assert.deepEqual(
    doc.desc.axes.map((a) => a.key),
    ['layer', 'face', 'mip']
  )
  assert.equal(doc.desc.images.length, 2 * 6 * 3)
  assert.equal(doc.desc.images[0].label, 'Layer 0 · +X · Mip 0 · 8×4')
  for (const id of [0, 5, 17, 35]) {
    const image = doc.desc.images[id]
    const [a, f, l] = image.at
    const r = await doc.decode(id)
    assert.equal(r.width, Math.max(1, W >> l))
    assert.deepEqual(Array.from(r.data.subarray(0, 4)), colourOf(a, f, l), image.label)
  }
})

test('DDS legacy formats: DXT1, R5G6B5, luminance with out-of-range masks, A8', async () => {
  const red = rgb565(255, 0, 0)
  const dxt1 = await open(dds({ width: 4, height: 4, fourcc: 'DXT1', data: bc1Block(red, red, new Array(16).fill(0)) }))
  assert.deepEqual(Array.from((await dxt1.decode(0)).data.subarray(0, 4)), [255, 0, 0, 255])

  const px = new ByteWriter(true).u16(0xf800).u16(0x07e0).u16(0x001f).u16(0xffff).done()
  const r565 = dds({ width: 2, height: 2, bits: 16, pfFlags: 0x40, masks: [0xf800, 0x07e0, 0x001f, 0], data: px })
  const rgb = await (await open(r565)).decode(0)
  assert.deepEqual(Array.from(rgb.data), [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])

  // An 8-bit luminance file whose mask says 0xff000000 (as some writers save it).
  const grey = await (await open(dds({ width: 2, height: 1, bits: 8, pfFlags: 0x20000, masks: [0xff000000, 0, 0, 0], data: new Uint8Array([7, 200]) }))).decode(0)
  assert.equal(grey.channels, 1)
  assert.deepEqual(Array.from(grey.data), [7, 200])

  const alpha = await (await open(dds({ width: 2, height: 1, bits: 8, pfFlags: 0x2, masks: [0, 0, 0, 0xff], data: new Uint8Array([0, 99]) }))).decode(0)
  assert.deepEqual(Array.from(alpha.data), [0, 99])
})

test('DDS float formats: R16G16B16A16 half stays half, R32 float is data with a range', async () => {
  const half = new ByteWriter(true)
  for (const v of [1.5, -2, 0.25, 1]) half.u16(toHalf(v))
  const h = await (await open(dds({ width: 1, height: 1, dxgi: 10, data: half.done() }))).decode(0)
  assert.equal(h.kind, 'f16')
  assert.equal(h.transfer, 'linear')
  assert.deepEqual(Array.from(h.data, (v) => halfToFloat(v)), [1.5, -2, 0.25, 1])

  const f = await (await open(dds({ width: 2, height: 1, dxgi: 41, data: new ByteWriter(true).f32(-3).f32(7.5).done() }))).decode(0)
  assert.equal(f.transfer, 'data')
  assert.deepEqual(f.range, [-3, 7.5])
})

test('DDS volume texture: slices of every mip level', async () => {
  const data = new ByteWriter(true)
  // 2×2×2 with 2 mips: four pixels per slice at mip 0, one pixel at mip 1.
  for (const v of [10, 20, 30]) {
    const n = v === 30 ? 1 : 4
    for (let i = 0; i < n; i++) data.u8(v)
  }
  const doc = await open(dds({ width: 2, height: 2, depth: 2, mips: 2, bits: 8, pfFlags: 0x20000, masks: [0xff, 0, 0, 0], data: data.done() }))
  assert.deepEqual(
    doc.desc.images.map((i) => i.label),
    ['Mip 0 · Slice 0 · 2×2', 'Mip 0 · Slice 1 · 2×2', 'Mip 1 · Slice 0 · 1×1']
  )
  assert.equal((await doc.decode(1)).data[3], 20)
  assert.equal((await doc.decode(2)).data[0], 30)
})

test('DDS damaged and unsupported: cut off, short header, YUY2', async () => {
  const blocks = new ByteWriter(true)
  for (let i = 0; i < 4; i++) blocks.bytes(bc1Block(rgb565(0, 255, 0), rgb565(0, 255, 0), new Array(16).fill(0)))
  const full = dds({ width: 8, height: 8, fourcc: 'DXT1', data: blocks.done() })
  const cut = await (await open(full.subarray(0, full.length - 12))).decode(0)
  assert.ok(cut.partial)
  assert.deepEqual(Array.from(cut.data.subarray(0, 4)), [0, 255, 0, 255])

  await assert.rejects(() => open(full.subarray(0, 60)))

  const yuy2 = await open(dds({ width: 4, height: 4, fourcc: 'YUY2', data: new Uint8Array(32) }))
  assert.equal(yuy2.desc.images[0].unsupported, 'YUY2')
  await assert.rejects(() => yuy2.decode(0), (e: unknown) => (e as { code?: string }).code === 'unsupported-pixels')
})

test('DDS damaged headers: array sizes and depths the file cannot hold are rejected before any image is built', async () => {
  const damagedCount = (e: unknown) => (e as { code?: string; detail?: string }).code === 'damaged' && (e as { detail?: string }).detail === 'DDS image count'
  // 4×4 RGBA8, a few bytes of data, and an array size from a damaged u32: headers only.
  for (const arraySize of [30_000_000, 0xffffffff]) {
    const started = Date.now()
    await assert.rejects(() => open(dds({ width: 4, height: 4, dxgi: 28, arraySize, data: new Uint8Array(16) })), damagedCount)
    assert.ok(Date.now() - started < 1000, `arraySize ${arraySize} is rejected at once`)
  }
  // A legacy volume texture with depth 0x7fffffff.
  await assert.rejects(() => open(dds({ width: 4, height: 4, depth: 0x7fffffff, bits: 32, masks: [0xff, 0xff00, 0xff0000, 0xff000000], data: new Uint8Array(64) })), damagedCount)
  // BC1: each surface needs at least one 8-byte block.
  const block = bc1Block(rgb565(255, 0, 0), rgb565(255, 0, 0), new Array(16).fill(0))
  const two = new ByteWriter(true).bytes(block).bytes(block).done()
  assert.equal((await open(dds({ width: 4, height: 4, dxgi: 71, arraySize: 2, data: two }))).desc.images.length, 2)
  await assert.rejects(() => open(dds({ width: 4, height: 4, dxgi: 71, arraySize: 3, data: two })), damagedCount)
  // An absolute cap, even when the bytes would be there: 1×1 R8 with one byte per layer.
  assert.equal((await open(dds({ width: 1, height: 1, dxgi: 61, arraySize: 8192, data: new Uint8Array(8192) }))).desc.images.length, 8192)
  await assert.rejects(() => open(dds({ width: 1, height: 1, dxgi: 61, arraySize: 8193, data: new Uint8Array(8193) })), damagedCount)
})

test('DDS details in Russian: header kind, alpha mode and legacy formats translated', async () => {
  const { englishLeft } = await import('../fixtures/russian')
  const block = bc1Block(rgb565(255, 0, 0), rgb565(255, 0, 0), new Array(16).fill(0))
  const files = [
    dds({ width: 4, height: 4, dxgi: 71, arraySize: 2, data: new ByteWriter(true).bytes(block).bytes(block).done() }),
    dds({ width: 4, height: 4, fourcc: 'DXT1', mips: 3, data: new ByteWriter(true).bytes(block).bytes(block).bytes(block).done() }),
    dds({ width: 1, height: 1, bits: 32, masks: [0xff, 0xff00, 0xff0000, 0xff000000], cube: true, data: new Uint8Array(24) }),
    dds({ width: 2, height: 2, depth: 2, bits: 8, pfFlags: 0x20000, masks: [0xff, 0, 0, 0], data: new Uint8Array(8) })
  ]
  for (const file of files) assert.deepEqual(englishLeft((await open(file)).desc), [])
})

test('DDS side list: cube faces or array layers at the chosen mip level, mip levels otherwise', async () => {
  const rgba = (w: number, h: number, mips: number, surfaces: number) => {
    let n = 0
    for (let l = 0; l < mips; l++) n += Math.max(1, w >> l) * Math.max(1, h >> l)
    return new Uint8Array(n * 4 * surfaces)
  }
  const cube = await open(dds({ width: 4, height: 4, mips: 3, dxgi: 28, cube: true, data: rgba(4, 4, 3, 6) }))
  assert.equal(cube.desc.list, 'face')
  const array = await open(dds({ width: 4, height: 4, mips: 3, dxgi: 28, arraySize: 4, data: rgba(4, 4, 3, 4) }))
  assert.equal(array.desc.list, 'layer')
  const mipped = await open(dds({ width: 4, height: 4, mips: 3, dxgi: 28, data: rgba(4, 4, 3, 1) }))
  assert.equal(mipped.desc.list, 'mip')
})
