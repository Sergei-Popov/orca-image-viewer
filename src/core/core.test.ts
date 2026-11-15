// The PNG writer behind "Save as PNG" and the tone pipeline that turns samples into screen pixels.

import { assert, test } from 'orca/testing'
import { autoTone, DEFAULT_TONE, formatFloat, histogram, initialTone, overview, pixelValues, renderRegion, type Tone } from '../viewer/tone'
import { toHalf } from './half'
import { inflate } from './inflate'
import { raster, type Raster } from './model'
import { crc32, encodePng } from './png'

const ascii = (s: string) => new TextEncoder().encode(s)

/** Chunks of a PNG file, with their CRCs checked. */
function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: { type: string; data: Uint8Array }[] = []
  for (let at = 8; at < png.length; ) {
    const n = v.getUint32(at)
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
    assert.equal(v.getUint32(at + 8 + n), (crc32(png.subarray(at + 4, at + 8 + n)) ^ 0xffffffff) >>> 0, `${type} CRC`)
    out.push({ type, data: png.subarray(at + 8, at + 8 + n) })
    at += 12 + n
  }
  return out
}

/** Undoes PNG row filters (8-bit samples). */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= bpp ? out[y * stride + i - bpp] : 0
      const b = y ? out[(y - 1) * stride + i] : 0
      const c = i >= bpp && y ? out[(y - 1) * stride + i - bpp] : 0
      const p = a + b - c
      const pred = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][f]
      out[y * stride + i] = (x + pred) & 255
    }
  }
  return out
}

test('PNG writer: valid chunks, the smallest colour type, and pixels that round-trip', async () => {
  assert.equal((crc32(ascii('IEND')) ^ 0xffffffff) >>> 0, 0xae426082)
  const cases: [string, Uint8Array, number, number][] = [
    ['RGBA', Uint8Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? (i === 7 ? 0 : 255) : i * 9)), 6, 4],
    ['RGB', Uint8Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 255 : i * 9)), 2, 3],
    ['grey', Uint8Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) * 40)), 0, 1]
  ]
  for (const [name, rgba, colourType, bpp] of cases) {
    const list = chunks(await encodePng(3, 2, rgba))
    assert.deepEqual(
      list.map((c) => c.type),
      ['IHDR', 'sRGB', 'IDAT', 'IEND'],
      name
    )
    const ihdr = new DataView(list[0].data.buffer, list[0].data.byteOffset)
    assert.deepEqual([ihdr.getUint32(0), ihdr.getUint32(4), list[0].data[8], list[0].data[9]], [3, 2, 8, colourType], name)
    const raw = await inflate(list[2].data, 'deflate')
    const pixels = unfilter(raw, 3, 2, bpp)
    const expected = Array.from({ length: 6 * bpp }, (_, i) => rgba[Math.floor(i / bpp) * 4 + (i % bpp)])
    assert.deepEqual(Array.from(pixels), expected, name)
  }
})

const render = (r: Raster, tone: Tone) => {
  const out = new Uint8ClampedArray(r.width * r.height * 4)
  renderRegion(r, tone, 0, 0, r.width, r.height, out)
  return Array.from(out)
}

test('Tone: 8-bit sRGB unchanged, channel views, alpha view', () => {
  const r = raster(2, 1, 4, 'u8', Uint8Array.from([10, 20, 30, 255, 200, 100, 50, 128]))
  assert.deepEqual(render(r, DEFAULT_TONE), [10, 20, 30, 255, 200, 100, 50, 128])
  assert.deepEqual(render(r, { ...DEFAULT_TONE, channel: 'g' }), [20, 20, 20, 255, 100, 100, 100, 255])
  assert.deepEqual(render(r, { ...DEFAULT_TONE, channel: 'a' }), [255, 255, 255, 255, 128, 128, 128, 255])
  // Luminance in linear light, encoded back: a grey stays the same grey.
  const grey = raster(1, 1, 3, 'u8', Uint8Array.from([90, 90, 90]))
  assert.deepEqual(render(grey, { ...DEFAULT_TONE, channel: 'luma' }).slice(0, 3), [90, 90, 90])
})

test('Tone: exposure in linear light, premultiplied alpha, levels for measured data', () => {
  // 0.25 linear, one stop up: 0.5 linear, which sRGB encodes as 188.
  const lin = raster(1, 1, 3, 'f32', Float32Array.from([0.25, 0.25, 0.25]), { transfer: 'linear' })
  assert.deepEqual(render(lin, { ...DEFAULT_TONE, exposure: 1 }).slice(0, 3), [188, 188, 188])
  // Half-float input takes the same path.
  const half = raster(1, 1, 3, 'f16', Uint16Array.from([0.25, 0.25, 0.25].map(toHalf)), { transfer: 'linear' })
  assert.deepEqual(render(half, { ...DEFAULT_TONE, exposure: 1 }).slice(0, 3), [188, 188, 188])
  // Premultiplied 0.25 at alpha 0.5 is 0.5 straight.
  const pre = raster(1, 1, 4, 'f32', Float32Array.from([0.25, 0.25, 0.25, 0.5]), { transfer: 'linear', premultiplied: true })
  assert.deepEqual(render(pre, DEFAULT_TONE), [188, 188, 188, 128])
  // Data: levels at 10 and 20 put 15 at mid grey; the tone opens at the data's range.
  const data = raster(3, 1, 1, 'f32', Float32Array.from([10, 15, 20]), { transfer: 'data', range: [10, 20] })
  const tone = initialTone(data)
  assert.deepEqual([tone.black, tone.white], [10, 20])
  assert.deepEqual(render(data, tone), [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255])
})

test('Tone: auto levels, histogram, overview, inspector values', () => {
  const ramp = raster(151, 1, 1, 'u8', Uint8Array.from({ length: 151 }, (_, i) => 50 + i))
  const auto = autoTone(ramp, DEFAULT_TONE)
  assert.equal(Math.round(auto.black * 255), 50)
  assert.equal(Math.round(auto.white * 255), 200)
  const bright = raster(4, 1, 3, 'f32', Float32Array.from([1, 1, 1, 2, 2, 2, 4, 4, 4, 4, 4, 4]), { transfer: 'linear' })
  assert.equal(autoTone(bright, DEFAULT_TONE).exposure, -2)

  const h = histogram(Uint8ClampedArray.from([255, 0, 0, 255, 255, 0, 0, 255, 9, 9, 9, 0]))
  assert.equal(h.r[255], 2)
  assert.equal(h.g[0], 2)
  assert.equal(h.r[9], 0, 'transparent pixels are left out')

  const big = raster(4, 2, 1, 'u8', Uint8Array.from([0, 255, 10, 30, 255, 0, 50, 70]))
  const o = overview(big, 2)
  assert.deepEqual([o.raster.width, o.raster.height, o.scale], [2, 1, 0.5])
  assert.ok(Math.abs(o.raster.data[0] - 0.5) < 1e-6 && Math.abs(o.raster.data[1] - 40 / 255) < 1e-6)

  const hf = raster(1, 1, 3, 'f16', Uint16Array.from([1.5, 0, 65504].map(toHalf)), { transfer: 'linear' })
  assert.deepEqual(
    pixelValues(hf, 0, 0).map((p) => `${p.name}=${p.value}`),
    ['R=1.5000', 'G=0.0000', 'B=65504.0000']
  )
  assert.equal(formatFloat(0.00002), '2.000e-5')
  assert.equal(formatFloat(Infinity), '+Inf')
  assert.equal(formatFloat(Number.NaN), 'NaN')
  assert.deepEqual(pixelValues(hf, 1, 0), [])
})

test('Image labels in Russian: generated words translated, names from the file kept', async () => {
  const { imageText, stringsFor } = await import('../i18n')
  const ru = stringsFor('ru-RU')
  const en = stringsFor('en')
  const cases: [string, string][] = [
    ['Page 2 · sub-image 1', 'Страница 2 · вложенное изображение 1'],
    ['Page 3 (reduced)', 'Страница 3 (уменьшенная)'],
    ['Layer 0 · +X · Mip 2 · 16×16', 'Слой 0 · +X · MIP-уровень 2 · 16×16'],
    ['Dark · 16×16 · ic04', 'Тёмный вариант · 16×16 · ic04'],
    ['Largest preview · 4608×3072', 'Наибольшее превью · 4608×3072'],
    ['Thumbnail of 3 160×120', 'Миниатюра изображения 3 160×120'],
    ['beauty · RGBA · level 2', 'beauty · RGBA · уровень 2'],
    ['Background copy', 'Background copy'],
    ['DWAA compression', 'сжатие DWAA']
  ]
  for (const [source, russian] of cases) {
    assert.equal(imageText(ru, source), russian)
    assert.equal(imageText(en, source), source)
  }
})

test('Info values in Russian: units, flash modes and compass points; English as made', async () => {
  const { infoValue, stringsFor } = await import('../i18n')
  const ru = stringsFor('ru')
  const en = stringsFor('en')
  const cases: [string, string, string][] = [
    ['exposure', '1/8 s · f/2.8 · ISO 100 · +0.3 EV', '1/8 с · f/2.8 · ISO 100 · +0.3 EV'],
    ['focalLength', '86 mm (35 mm equivalent: 129 mm)', '86 мм (в пересчёте на 35 мм: 129 мм)'],
    ['flash', 'Did not fire, off', 'Не сработала, выключена'],
    ['latitude', '47° 57′ 30.63″ N', '47° 57′ 30.63″ с. ш.'],
    ['altitude', '602.4 m', '602.4 м'],
    ['compression', 'None', 'Нет'],
    ['colorSpace', 'BT.709 primaries, sRGB transfer, BT.601 matrix, full range', 'основные цвета BT.709, передаточная функция sRGB, матрица BT.601, полный диапазон'],
    ['camera', 'Test Camera', 'Test Camera']
  ]
  for (const [key, english, russian] of cases) {
    assert.equal(infoValue(ru, key, english), russian)
    assert.equal(infoValue(en, key, english), english)
  }
})
