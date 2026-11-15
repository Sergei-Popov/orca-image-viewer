import { assert, test } from 'orca/testing'
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
  for (const [x, y] of [
    [0, 0],
    [15, 9],
    [7, 4]
  ]) {
    // Chroma is stored for every other column, starting at the even absolute x = -4.
    const ry = expectHalf((x - 4 - ((x - 4) & 1)) / 32)
    const red = (ry + 1) * 0.5
    assert.ok(Math.abs(sample(r, x, y, 0) - red) < 1e-6, `(${x}, ${y}) red`)
    assert.ok(Math.abs(sample(r, x, y, 2) - 0.5) < 1e-6, `(${x}, ${y}) blue`)
    assert.ok(Math.abs(sample(r, x, y, 1) - (0.5 - red * 0.2126 - 0.5 * 0.0722) / 0.7152) < 1e-6, `(${x}, ${y}) green`)
  }
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
