import { assert, test } from 'orca/testing'
import { lumaWeights } from '../codecs/exr-yca'
import { halfToFloat, toHalf } from '../core/half'
import { inflate } from '../core/inflate'
import type { Raster } from '../core/model'
import { openDocument } from '../core/session'
import { exr, type ExrPartSpec } from '../fixtures/exr'

const platform = { inflate }

const rgba = (channel: number, x: number, y: number, level: number) =>
  [x / 16 + level, y / 8, 0.25 + ((x + y) % 5) * 0.5, x > 20 ? 0.5 : 1][channel]

function part(extra: Partial<ExrPartSpec> = {}): ExrPartSpec {
  return {
    width: 37,
    height: 21,
    channels: [{ name: 'R' }, { name: 'G' }, { name: 'B' }, { name: 'A' }],
    value: rgba,
    ...extra
  }
}

/** A sample as a number, whatever the raster stores. */
function sample(r: Raster, x: number, y: number, c: number): number {
  const v = r.data[(y * r.width + x) * r.channels + c]
  return r.kind === 'f16' ? halfToFloat(v) : v
}

function expectHalf(v: number): number {
  return halfToFloat(toHalf(v))
}

function checkRgba(r: Raster, level = 0, x0 = 0, y0 = 0, tolerance = 0): void {
  for (let y = 0; y < r.height; y += 3) {
    for (let x = 0; x < r.width; x += 2) {
      for (let c = 0; c < 4; c++) {
        const want = expectHalf(rgba(c, x + x0, y + y0, level))
        const got = sample(r, x, y, c)
        assert.ok(Math.abs(got - want) <= tolerance * Math.max(1, Math.abs(want)), `(${x}, ${y}) channel ${c}: ${got} ≠ ${want}`)
      }
    }
  }
}

for (const [compression, name] of [
  [0, 'NONE'],
  [1, 'RLE'],
  [2, 'ZIPS'],
  [3, 'ZIP'],
  [5, 'PXR24']
] as const) {
  test(`EXR scanline half RGBA, ${name}`, async () => {
    const doc = await openDocument(await exr(part({ compression })), 'exr', platform)
    assert.equal(doc.desc.format, 'OpenEXR')
    const r = await doc.decode(doc.desc.primary)
    assert.equal(r.width, 37)
    assert.equal(r.height, 21)
    assert.equal(r.kind, 'f16')
    assert.equal(r.transfer, 'linear')
    assert.ok(r.alpha && r.premultiplied)
    assert.ok(!r.partial)
    checkRgba(r)
  })
}

test('EXR B44A with perceptually linear (pLinear) channels: stored as exp(v / 8), shown as v', async () => {
  // One value per 4×4 block; the edge blocks of the 10 × 9 image are partial.
  const block = (x: number, y: number) => (x >> 2) + 3 * (y >> 2)
  const values = [(x: number, y: number) => block(x, y) - 3.5, (x: number, y: number) => 0.25 * (block(x, y) + 1), () => 0.5]
  const file = await exr({
    width: 10,
    height: 9,
    channels: [{ name: 'R', pLinear: true }, { name: 'G' }, { name: 'B', pLinear: true }],
    value: (c, x, y) => values[c](x, y),
    compression: 7
  })
  const doc = await openDocument(file, 'exr', platform)
  const r = await doc.decode(doc.desc.primary)
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 10; x++) {
      for (let c = 0; c < 3; c++) {
        const want = values[c](x, y)
        const got = sample(r, x, y, c)
        // exp(v / 8) is stored as a half, so the value comes back within 8 × 2⁻¹¹.
        assert.ok(Math.abs(got - want) <= 0.004, `(${x}, ${y}) channel ${c}: ${got} ≠ ${want}`)
      }
    }
  }
})

test('EXR float and uint channels: float stays exact, uint is data', async () => {
  const doc = await openDocument(
    await exr({
      width: 19,
      height: 7,
      channels: [{ name: 'Z', type: 2 }, { name: 'id', type: 0 }],
      value: (c, x, y) => (c === 0 ? x * 0.1 - y : x * 1000 + y),
      compression: 3
    }),
    'exr',
    platform
  )
  const labels = doc.desc.images.map((i) => i.label)
  assert.deepEqual(labels, ['Z', 'id'])
  const z = await doc.decode(0)
  assert.equal(z.kind, 'f32')
  assert.equal(z.transfer, 'data')
  assert.equal(sample(z, 5, 3, 0), Math.fround(5 * 0.1 - 3))
  const id = await doc.decode(1)
  assert.equal(sample(id, 18, 6, 0), 18006)
  assert.deepEqual(id.range, [0, 18006])
})

test('EXR tiled mipmap: every level is its own image', async () => {
  const doc = await openDocument(await exr(part({ compression: 3, tiles: { w: 16, h: 8, mipmap: true } })), 'exr', platform)
  const mip = doc.desc.axes.find((a) => a.key === 'mip')
  assert.ok(mip)
  assert.equal(mip.labels.length, 6)
  assert.deepEqual(
    doc.desc.images.map((i) => `${i.width}×${i.height}`),
    ['37×21', '18×10', '9×5', '4×2', '2×1', '1×1']
  )
  for (const level of [0, 1, 3, 5]) {
    const r = await doc.decode(level)
    assert.ok(!r.partial, `level ${level}`)
    checkRgba(r, level)
  }
})

test('EXR multipart with layers names parts and channel groups', async () => {
  const doc = await openDocument(
    await exr([
      part({ name: 'beauty', compression: 2 }),
      {
        name: 'aovs',
        width: 37,
        height: 21,
        channels: [{ name: 'diffuse.R' }, { name: 'diffuse.G' }, { name: 'diffuse.B' }, { name: 'depth.Z', type: 2 }],
        value: (c, x, y) => [x / 37, y / 21, 0.5, 100 + x][c],
        compression: 1
      }
    ]),
    'exr',
    platform
  )
  assert.deepEqual(
    doc.desc.images.map((i) => i.label),
    ['beauty · RGBA', 'aovs · depth.Z', 'aovs · diffuse']
  )
  assert.deepEqual(
    doc.desc.notices.map((n) => n.code),
    ['exr-multipart']
  )
  checkRgba(await doc.decode(0))
  const depth = await doc.decode(1)
  assert.equal(sample(depth, 7, 2, 0), 107)
  const diffuse = await doc.decode(2)
  assert.equal(diffuse.channels, 3)
  assert.equal(sample(diffuse, 0, 20, 1), expectHalf(20 / 21))
})

test('EXR data window offset and subsampled luminance/chroma convert to RGB', async () => {
  const doc = await openDocument(
    await exr({
      width: 16,
      height: 10,
      x0: -4,
      y0: 6,
      channels: [{ name: 'Y' }, { name: 'RY', xs: 2, ys: 2 }, { name: 'BY', xs: 2, ys: 2 }],
      value: (c, x) => [0.5, x / 32, 0][c],
      compression: 3
    }),
    'exr',
    platform
  )
  const r = await doc.decode(0)
  assert.equal(r.channels, 3)
  assert.equal(r.color, 'rgb')
  const [wr, wg, wb] = lumaWeights(null)
  for (const [x, y] of [
    [6, 2],
    [7, 3],
    [8, 4],
    [9, 5]
  ]) {
    // Chroma is stored for every other column from the even absolute x = −4; OpenEXR's filter
    // rebuilds the columns between, so on a ramp they land halfway, not on the left sample.
    const ry = (x - 4) / 32
    const red = (ry + 1) * 0.5
    assert.ok(Math.abs(sample(r, x, y, 0) - red) < 1e-3, `(${x}, ${y}) red ${sample(r, x, y, 0)} ≠ ${red}`)
    assert.ok(Math.abs(sample(r, x, y, 2) - 0.5) < 1e-3, `(${x}, ${y}) blue`)
    assert.ok(Math.abs(sample(r, x, y, 1) - (0.5 - red * wr - 0.5 * wb) / wg) < 1e-3, `(${x}, ${y}) green`)
  }
})

test('EXR luminance/chroma with a chromaticities attribute: G is solved with those primaries', async () => {
  // Rec. 2020 primaries; full-resolution chroma, so only the weights matter.
  const rec2020 = [0.708, 0.292, 0.17, 0.797, 0.131, 0.046, 0.3127, 0.329]
  const [wr, wg, wb] = lumaWeights(rec2020)
  assert.ok(Math.abs(wr - 0.2627) < 1e-4 && Math.abs(wg - 0.678) < 1e-4 && Math.abs(wb - 0.0593) < 1e-4, `Rec. 2020 weights ${[wr, wg, wb]}`)
  const rec709 = lumaWeights(null)
  assert.ok(Math.abs(rec709[0] - 0.212639) < 1e-5 && Math.abs(rec709[1] - 0.715169) < 1e-5, `Rec. 709 weights ${rec709}`)
  const doc = await openDocument(
    await exr({ width: 4, height: 4, channels: [{ name: 'Y' }, { name: 'RY' }, { name: 'BY' }], value: (c) => [0.5, 0.2, -0.1][c], chromaticities: rec2020 }),
    'exr',
    platform
  )
  const r = await doc.decode(0)
  const [R, B] = [0.6, 0.45]
  assert.ok(Math.abs(sample(r, 1, 1, 0) - R) < 1e-3)
  assert.ok(Math.abs(sample(r, 1, 1, 2) - B) < 1e-3)
  assert.ok(Math.abs(sample(r, 1, 1, 1) - (0.5 - R * wr - B * wb) / wg) < 1e-3, `green ${sample(r, 1, 1, 1)}`)
})

test('EXR damaged files: cut off, bad signature, unsupported compression', async () => {
  const bytes = await exr(part({ compression: 0 }))
  const cut = await openDocument(bytes.subarray(0, Math.floor(bytes.length * 0.6)), 'exr', platform)
  const r = await cut.decode(0)
  assert.ok(r.partial)
  assert.equal(sample(r, 3, 0, 0), expectHalf(3 / 16))

  const broken = bytes.slice()
  broken[10] = 0xff
  broken[11] = 0xff
  await assert.rejects(async () => (await openDocument(broken, 'exr', platform)).decode(0))

  const dwa = bytes.slice()
  // The compression attribute's value byte follows its name, type and size.
  const at = findAscii(dwa, 'compression\0compression\0') + 'compression\0compression\0'.length + 4
  dwa[at] = 8
  const doc = await openDocument(dwa, 'exr', platform)
  assert.ok(doc.desc.images[0].unsupported?.includes('DWAA'))
  await assert.rejects(() => doc.decode(0), (e: unknown) => (e as { code?: string }).code === 'unsupported-compression')
})

function findAscii(bytes: Uint8Array, text: string): number {
  outer: for (let i = 0; i + text.length <= bytes.length; i++) {
    for (let k = 0; k < text.length; k++) if (bytes[i + k] !== text.charCodeAt(k)) continue outer
    return i
  }
  return -1
}

test('EXR damaged headers: chunk counts across parts must fit in the file', async () => {
  const tiny = (name: string, chunkCount: number): ExrPartSpec => ({ name, width: 1, height: 1, channels: [{ name: 'Y' }], value: () => 0.5, chunkCount })
  const chunkCount = (e: unknown) => (e as { code?: string }).code === 'damaged' && (e as { detail?: string }).detail === 'EXR chunk count'
  // 64 parts of 16 million chunks each, and no offset tables at all: headers only.
  const many = await exr(
    Array.from({ length: 64 }, (_, i) => tiny(`p${i}`, 16_000_000)),
    { headersOnly: true }
  )
  const started = Date.now()
  await assert.rejects(() => openDocument(many, 'exr', platform), chunkCount)
  assert.ok(Date.now() - started < 1000, 'rejected at once')
  // Small counts, but more table than file.
  const short = new Uint8Array([...(await exr([tiny('a', 1000), tiny('b', 1000)], { headersOnly: true })), ...new Uint8Array(64)])
  await assert.rejects(() => openDocument(short, 'exr', platform), chunkCount)
  // The same parts with their real tables open.
  const fine = await openDocument(await exr([tiny('a', 1), tiny('b', 1)]), 'exr', platform)
  assert.equal(fine.desc.images.length, 2)
})

test('EXR labels in Russian: part and channel names stay as the file has them, generated words are translated', async () => {
  const { imageText, stringsFor } = await import('../i18n')
  const ru = stringsFor('ru')
  // Parts named "Depth" and "Layer 2", the second with one loose channel named "Alpha" and mip
  // levels: the decoders use those words too, but here they are the file's names.
  const doc = await openDocument(
    await exr([part({ name: 'Depth' }), part({ name: 'Layer 2', channels: [{ name: 'Alpha' }], value: () => 0.5, tiles: { w: 16, h: 16, mipmap: true } })]),
    'exr',
    platform
  )
  const axis = doc.desc.axes.find((a) => a.key === 'part')
  assert.ok(axis)
  assert.deepEqual(
    axis.labels.map((l, i) => imageText(ru, l, axis.fileText?.[i])),
    ['Depth · RGBA', 'Layer 2 · Alpha']
  )
  const level = doc.desc.images.find((i) => i.label === 'Layer 2 · Alpha · level 1')
  assert.ok(level)
  assert.equal(imageText(ru, level.label, level.fileText), 'Layer 2 · Alpha · уровень 1')
  // Unmarked, the same words are the decoders' own and are translated; so is a nameless "Part 2".
  assert.equal(imageText(ru, 'Depth · Layer 2 · Alpha'), 'Глубина · Слой 2 · Альфа')
  assert.equal(imageText(ru, 'Part 2 · Depth', [1]), 'Часть 2 · Depth')
})

test('EXR damaged headers: views × levels past the image cap are rejected before any image is described', async () => {
  const imageCount = (e: unknown) => (e as { code?: string }).code === 'damaged' && (e as { detail?: string }).detail === 'EXR image count'
  const chunkCount = (e: unknown) => (e as { code?: string }).code === 'damaged' && (e as { detail?: string }).detail === 'EXR chunk count'
  const loose = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `c${i}` }))
  // A ripmap over a 2^31 − 1 square data window in one tile per level (31 × 31 levels) with 100
  // channels that make 100 views: 96,100 images from a 10 KB header. Headers only.
  const huge = await exr({ width: 0x7fffffff, height: 0x7fffffff, channels: loose(100), value: () => 0, tiles: { w: 0x7fffffff, h: 0x7fffffff, ripmap: true } }, { headersOnly: true })
  const started = Date.now()
  await assert.rejects(() => openDocument(huge, 'exr', platform), imageCount)
  assert.ok(Date.now() - started < 1000, 'rejected at once')
  // The cap itself: a 128 × 128 ripmap has 8 × 8 levels, so 128 views make 8192 images and get
  // past the count (to the missing tables); 129 views do not.
  const square = (views: number) => exr({ width: 128, height: 128, channels: loose(views), value: () => 0, tiles: { w: 64, h: 64, ripmap: true } }, { headersOnly: true })
  await assert.rejects(async () => openDocument(await square(128), 'exr', platform), chunkCount)
  await assert.rejects(async () => openDocument(await square(129), 'exr', platform), imageCount)
})

test('EXR details in Russian: channel types, tiles, line order and attributes translated', async () => {
  const { englishLeft } = await import('../fixtures/russian')
  const files = [
    await exr(part({ compression: 3, tiles: { w: 16, h: 8, mipmap: true } })),
    await exr({ width: 2, height: 2, channels: [{ name: 'id', type: 0 }, { name: 'Z', type: 2 }], value: () => 1 }),
    await exr([part({ name: 'beauty', compression: 2 }), part({ name: 'aovs', compression: 5 })])
  ]
  for (const file of files) assert.deepEqual(englishLeft((await openDocument(file, 'exr', platform)).desc, ['id']), [])
})

test('EXR side list: parts, or layers of one part, at the chosen level; levels of a single image', async () => {
  const multipart = await openDocument(await exr([part({ name: 'beauty' }), part({ name: 'aovs' })]), 'exr', platform)
  assert.equal(multipart.desc.list, 'part')
  const layers = await openDocument(await exr({ width: 2, height: 2, channels: [{ name: 'R' }, { name: 'G' }, { name: 'B' }, { name: 'spec.R' }, { name: 'spec.G' }, { name: 'spec.B' }], value: () => 0.5 }), 'exr', platform)
  assert.equal(layers.desc.list, 'layer')
  const mip = await openDocument(await exr(part({ compression: 3, tiles: { w: 16, h: 8, mipmap: true } })), 'exr', platform)
  assert.equal(mip.desc.list, 'mip')
  const single = await openDocument(await exr(part()), 'exr', platform)
  assert.equal(single.desc.list, undefined)
})
