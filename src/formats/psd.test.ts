import { assert, test } from 'orca/testing'
import { inflate } from '../core/inflate'
import type { DocDesc, Raster } from '../core/model'
import { openDocument } from '../core/session'
import { psd } from '../fixtures/psd'
import { ByteWriter } from '../fixtures/writer'

const platform = { inflate }

const item = (desc: DocDesc, section: string, key: string) => desc.info.find((s) => s.title === section)?.items.find((i) => i.key === key)?.value

const codeOf = (e: unknown) => (e as { code?: string }).code

const fill = (n: number, v: number) => new Uint8Array(n).fill(v)

const pixel = (r: Raster, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * r.channels, (y * r.width + x + 1) * r.channels))

test('PSD layers: groups, blend modes, opacity, hidden and text layers, Unicode names, composite', async () => {
  const n = 16
  const file = psd({
    width: 4,
    height: 4,
    planes: [fill(n, 10), fill(n, 20), fill(n, 30)],
    realMerged: true,
    // Bottom first, as the file stores them.
    layers: [
      { name: 'Фон', width: 4, height: 4, channels: { [-1]: fill(n, 255), 0: fill(n, 200), 1: fill(n, 0), 2: fill(n, 0) } },
      { name: '</Layer group>', width: 0, height: 0, section: 3 },
      { name: 'Shade', left: 1, top: 1, width: 2, height: 2, blend: 'mul ', opacity: 0.5, channels: { [-1]: fill(4, 255), 0: fill(4, 128), 1: fill(4, 128), 2: fill(4, 128) } },
      { name: 'Title', width: 2, height: 1, marker: 'TySh', channels: { [-1]: fill(2, 255), 0: fill(2, 0), 1: fill(2, 0), 2: fill(2, 255) } },
      { name: 'Group', width: 0, height: 0, section: 1 },
      { name: 'Hidden', width: 1, height: 1, hidden: true, channels: { [-1]: fill(1, 255), 0: fill(1, 1), 1: fill(1, 2), 2: fill(1, 3) } }
    ]
  })
  const doc = await openDocument(file, 'psd', platform)
  const d = doc.desc
  assert.equal(d.format, 'PSD')
  const layers = d.layers ?? []
  assert.deepEqual(
    layers.map((l) => [l.name, l.kind, l.depth, l.visible]),
    [
      ['Hidden', 'pixel', 0, false],
      ['Group', 'group', 0, true],
      ['Title', 'text', 1, true],
      ['Shade', 'pixel', 1, true],
      ['Фон', 'pixel', 0, true]
    ]
  )
  const shade = layers[3]
  assert.equal(shade.blend, 'Multiply')
  assert.equal(Math.round(shade.opacity * 100), 50)
  assert.deepEqual([shade.left, shade.top, shade.width, shade.height], [1, 1, 2, 2])
  assert.equal(item(d, 'image', 'layers'), '4 (1 group)')
  assert.equal(item(d, 'image', 'compression'), 'RLE (PackBits)')
  assert.equal(item(d, 'image', 'composite'), 'Yes')

  // The saved composite.
  const flat = await doc.decode(0)
  assert.deepEqual(pixel(flat, 2, 2), [10, 20, 30])
  // One layer's own pixels, with its transparency.
  const own = await doc.decode(shade.image)
  assert.deepEqual([own.width, own.height, own.channels], [2, 2, 4])
  assert.deepEqual(pixel(own, 0, 0), [128, 128, 128, 255])
  // A composite of chosen layers: the background with the half-opacity Multiply layer over it.
  const visible = layers.map((l) => l.name === 'Фон' || l.name === 'Shade' || l.name === 'Group')
  const mixed = await (doc.composite as NonNullable<typeof doc.composite>)(visible)
  assert.deepEqual(pixel(mixed, 0, 0).slice(0, 3), [200, 0, 0])
  const under = pixel(mixed, 1, 1)
  assert.ok(Math.abs(under[0] - 150) <= 1, `multiply at half opacity: ${under}`)
  assert.equal(under[1], 0)
})

test('PSD without a saved composite: the visible layers are composited, and the viewer says so', async () => {
  const file = psd({
    width: 2,
    height: 2,
    planes: [fill(4, 255), fill(4, 255), fill(4, 255)],
    realMerged: false,
    layers: [
      { name: 'Red', width: 2, height: 2, channels: { [-1]: fill(4, 255), 0: fill(4, 255), 1: fill(4, 0), 2: fill(4, 0) } },
      { name: 'Blue dot', left: 1, top: 0, width: 1, height: 1, channels: { [-1]: fill(1, 255), 0: fill(1, 0), 1: fill(1, 0), 2: fill(1, 255) } }
    ]
  })
  const doc = await openDocument(file, 'psd', platform)
  assert.ok(doc.desc.notices.some((x) => x.code === 'psd-no-composite'))
  assert.equal(item(doc.desc, 'image', 'composite'), 'Not saved (composited from layers)')
  const r = await doc.decode(0)
  assert.deepEqual(pixel(r, 0, 0).slice(0, 3), [255, 0, 0])
  assert.deepEqual(pixel(r, 1, 0).slice(0, 3), [0, 0, 255])
})

test('PSD depths and modes: 16-bit grey with prediction, 32-bit float, CMYK, bitmap, indexed, PSB', async () => {
  const grey = await openDocument(psd({ width: 3, height: 1, depth: 16, mode: 1, compression: 3, planes: [Uint16Array.from([0, 1000, 65535])] }), 'psd', platform)
  const g = await grey.decode(0)
  assert.equal(g.kind, 'u16')
  assert.deepEqual(Array.from(g.data), [0, 1000, 65535])

  const hdr = await openDocument(
    psd({ width: 2, height: 1, depth: 32, compression: 3, planes: [Float32Array.from([0.5, 4]), Float32Array.from([0.25, 2]), Float32Array.from([0, 1])] }),
    'psd',
    platform
  )
  const f = await hdr.decode(0)
  assert.equal(f.kind, 'f32')
  assert.equal(f.transfer, 'linear')
  assert.deepEqual(Array.from(f.data), [0.5, 0.25, 0, 4, 2, 1])

  // CMYK stores ink inverted: 255 is no ink.
  const cmyk = await openDocument(psd({ width: 2, height: 1, mode: 4, compression: 0, planes: [Uint8Array.from([255, 255]), Uint8Array.from([255, 0]), Uint8Array.from([255, 0]), Uint8Array.from([255, 255])] }), 'psd', platform)
  const c = await cmyk.decode(0)
  assert.deepEqual(Array.from(c.data.subarray(0, 6)), [255, 255, 255, 255, 0, 0])

  const bitmap = await openDocument(psd({ width: 3, height: 1, depth: 1, mode: 0, compression: 0, planes: [Uint8Array.from([0, 1, 0])] }), 'psd', platform)
  assert.deepEqual(Array.from((await bitmap.decode(0)).data), [0, 255, 0])

  const palette = new Uint8Array(768)
  palette[1] = 250
  palette[256 + 1] = 100
  palette[512 + 2] = 77
  const indexed = await openDocument(psd({ width: 2, height: 1, mode: 2, palette, planes: [Uint8Array.from([1, 2])] }), 'psd', platform)
  assert.deepEqual(Array.from((await indexed.decode(0)).data.subarray(0, 6)), [250, 100, 0, 0, 0, 77])

  const big = await openDocument(
    psd({
      width: 2,
      height: 2,
      psb: true,
      planes: [fill(4, 1), fill(4, 2), fill(4, 3)],
      layers: [{ name: 'Only', width: 2, height: 2, channels: { [-1]: fill(4, 255), 0: fill(4, 9), 1: fill(4, 8), 2: fill(4, 7) } }]
    }),
    'psb',
    platform
  )
  assert.equal(big.desc.format, 'PSB')
  assert.equal(item(big.desc, 'file', 'version'), 'PSB (large document)')
  assert.deepEqual(pixel(await big.decode(1), 1, 1), [9, 8, 7, 255])
})

test('PSD damaged: bad signature, unsupported depth, cut-off image data', async () => {
  await assert.rejects(
    () => openDocument(new ByteWriter(false).ascii('8BPS').u16(7).zeros(20).done(), 'psd', platform),
    (e: unknown) => codeOf(e) === 'damaged'
  )
  const odd = psd({ width: 1, height: 1, planes: [fill(1, 0), fill(1, 0), fill(1, 0)] })
  odd[23] = 7
  await assert.rejects(
    () => openDocument(odd, 'psd', platform),
    (e: unknown) => codeOf(e) === 'unsupported-pixels'
  )
  const full = psd({ width: 8, height: 8, compression: 0, planes: [fill(64, 50), fill(64, 60), fill(64, 70)] })
  const doc = await openDocument(full.subarray(0, full.length - 100), 'psd', platform)
  const r = await doc.decode(0)
  assert.ok(r.partial)
  assert.deepEqual(pixel(r, 0, 0), [50, 60, 0])

  // Cut off inside the layers: no saved composite to show, so the readable layers are composited
  // and the result is marked partial.
  const red = { [-1]: fill(16, 255), 0: fill(16, 255), 1: fill(16, 0), 2: fill(16, 0) }
  const layered = psd({
    width: 4,
    height: 4,
    compression: 0,
    planes: [fill(16, 1), fill(16, 2), fill(16, 3)],
    realMerged: true,
    layers: [
      { name: 'Base', width: 4, height: 4, channels: red },
      { name: 'Top', width: 4, height: 4, channels: { [-1]: fill(16, 255), 0: fill(16, 0), 1: fill(16, 0), 2: fill(16, 255) } }
    ]
  })
  // The file ends with the composite (2 + 3 × 16 bytes) after a 4-byte global mask length: cut
  // those and the last 8 bytes of the top layer's blue channel.
  const cut = await openDocument(layered.subarray(0, layered.length - 50 - 4 - 8), 'psd', platform)
  assert.equal(item(cut.desc, 'image', 'composite'), 'Missing, the file is cut off (composited from layers)')
  const shown = await cut.decode(0)
  assert.ok(shown.partial)
})
