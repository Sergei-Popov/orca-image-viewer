// The PNG writer behind "Save as PNG" and the tone pipeline that turns samples into screen pixels.

import { assert, test } from 'orca/testing'
import { autoTone, DEFAULT_TONE, formatFloat, histogram, initialTone, overview, pixelValues, renderRegion, type Tone, toneControls } from '../viewer/tone'
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
    ['exposure', '1/250 s · f/8 · ISO 100 · −0.33 EV', '1/250 с · f/8 · ISO 100 · −0.33 EV'],
    ['focalLength', '86 mm (35 mm equivalent: 129 mm)', '86 мм (в пересчёте на 35 мм: 129 мм)'],
    ['flash', 'Did not fire, off', 'Не сработала, выключена'],
    ['latitude', '47° 57′ 30.63″ N', '47° 57′ 30.63″ с. ш.'],
    ['altitude', '602.4 m', '602.4 м'],
    ['compression', 'None', 'Нет'],
    ['layers', '11 (2 groups)', '11 (2 группы)'],
    ['printSize', '11.11 × 6.94 in', '11.11 × 6.94 дюйм.'],
    ['resolution', '300 dpi', '300 пикс./дюйм'],
    ['subfile', 'reduced resolution', 'уменьшенное разрешение'],
    ['colorSpace', 'BT.709 primaries, sRGB transfer, BT.601 matrix, full range', 'основные цвета BT.709, передаточная функция sRGB, матрица BT.601, полный диапазон'],
    ['camera', 'Test Camera', 'Test Camera']
  ]
  for (const [key, english, russian] of cases) {
    assert.equal(infoValue(ru, key, english), russian)
    assert.equal(infoValue(en, key, english), english)
  }
})

test('Error details in Russian: phrases, patterns and damaged parts; English as made', async () => {
  const { errorDetail, stringsFor } = await import('../i18n')
  const ru = stringsFor('ru')
  const en = stringsFor('en')
  const cases: [string, string][] = [
    ['a RAW file without an embedded preview', 'RAW-файл без встроенного превью'],
    ['12-bit CMYK', '12-битный CMYK'],
    ['HEVC: the system decoder gave no picture for 20 s', 'HEVC: системный декодер не выдал изображение за 20 с'],
    ['TIFF header', 'заголовок TIFF'],
    ['EXR image data', 'данные изображения EXR'],
    ['BigTIFF offset size', 'размер смещений BigTIFF'],
    ['ic04 data', 'данные ic04'],
    ['JPEG XL', 'JPEG XL'],
    ['PIZ code table', 'таблица кодов PIZ']
  ]
  for (const [detail, russian] of cases) {
    assert.equal(errorDetail(ru, detail), russian)
    assert.equal(errorDetail(en, detail), detail)
  }
})

test('Error details in Russian: every detail a reader puts in a damaged error has a Russian form', async () => {
  const { errorDetail, stringsFor } = await import('../i18n')
  const ru = stringsFor('ru')
  // Every damaged(…) detail in src (grep "damaged(" outside the tests), with sample values for
  // the ones built from the file.
  const details = [
    'av1C', 'B44 data', 'BigTIFF offset size', 'DDS data', 'DDS DX10 header', 'DDS header', 'DDS image count', 'DDS image', 'DDS size',
    'DEFLATE', 'EXR channel list', 'EXR chunk count', 'EXR data window', 'EXR header', 'EXR image count', 'EXR image data', 'EXR image',
    'EXR part count', 'EXR RLE data', 'EXR signature', 'HEIF derivation depth', 'HEIF grid tiles', 'HEIF idat', 'HEIF identity item',
    'HEIF image', 'HEIF item data past the end', 'HEIF item data', 'HEIF meta box', 'HEIF primary image', 'hvcC', 'ICNS entries',
    'ICNS entry', 'ICNS header', 'IFD entry count', 'IFD offset', 'JPEG data', 'Lab without three channels', 'PIZ bitmap',
    'PIZ code length', 'PIZ code table', 'PIZ code', 'PIZ data length', 'PIZ data', 'PIZ run', 'PSD colour table', 'PSD header',
    'PSD image data', 'PSD layer channels', 'PSD layer count', 'PSD layer record', 'PSD layer', 'PSD signature', 'PXR24 data',
    'QOI signature', 'Radiance header', 'Radiance resolution', 'Radiance run', 'Radiance scanline width', 'Radiance scanline',
    'Radiance signature', 'RGB with fewer than 3 samples', 'TGA colour map', 'TGA header', 'TIFF bits per sample', 'TIFF byte order',
    'TIFF colour map', 'TIFF has no images', 'TIFF header', 'TIFF image data', 'TIFF image size', 'TIFF page', 'TIFF samples per pixel',
    'TIFF strip offsets', 'TIFF tile size', 'YCbCr subsampling',
    'ic04 data', 'EXR attribute dataWindow', 'HEIF hvcC', 'HEIF av1C', 'iloc field size 9', 'PSD version 3', 'QOI channels 5', 'size 0×0'
  ]
  const missing = details.filter((d) => !/[а-яё]/i.test(errorDetail(ru, d)))
  assert.deepEqual(missing, [])
  assert.equal(errorDetail(ru, 'DDS image count'), 'число изображений DDS')
  assert.equal(errorDetail(ru, 'EXR image count'), 'число изображений EXR')
})

test('No HEVC decoder: a plain message naming the codec, and a hint for HEVC only', async () => {
  const { errorHint, fill, stringsFor } = await import('../i18n')
  for (const t of [stringsFor('en'), stringsFor('ru')]) {
    const message = fill(t.errors['no-video-decoder'], { detail: 'HEVC' })
    assert.ok(message.includes('HEVC') && !message.includes('{'))
    assert.equal(errorHint(t, 'no-video-decoder', 'HEVC'), t.hevcHint)
    assert.ok(/Windows/.test(t.hevcHint) && /Linux/.test(t.hevcHint) && /Mac/.test(t.hevcHint))
    assert.equal(errorHint(t, 'no-video-decoder', 'AV1'), '')
    assert.equal(errorHint(t, 'decode-failed', 'HEVC'), '')
  }
})

test('Thumbnails: a new version of the file drops the thumbnails of the old one', async () => {
  const { ThumbCache } = await import('../viewer/thumbs')
  const cache = new ThumbCache<string>()
  cache.set(1, 0, 'red page 1')
  cache.set(1, 1, 'green page 2')
  assert.equal(cache.get(1, 1), 'green page 2')
  // Orca sends the file again after an outside write: the same ids, another generation.
  assert.equal(cache.get(2, 0), undefined)
  assert.equal(cache.get(2, 1), undefined)
  assert.equal(cache.size, 0)
  cache.set(2, 0, 'yellow page 1')
  assert.equal(cache.get(2, 0), 'yellow page 1')
})

test('Side list: one row per position on the list axis, where the current image stands, in one pass', async () => {
  const { listEntries } = await import('../viewer/list')
  // 4 parts × 3 levels: the list axis is the part (0), the level (1) follows the current image.
  const images = Array.from({ length: 12 }, (_, id) => ({ id, width: 1, height: 1, at: [Math.floor(id / 3), id % 3], label: `${id}`, info: [] }))
  assert.deepEqual(listEntries(images, 0, null).map((i) => i.id), [0, 3, 6, 9])
  assert.deepEqual(listEntries(images, 0, images[5]).map((i) => i.id), [2, 5, 8, 11])
  assert.deepEqual(listEntries(images, 1, images[7]).map((i) => i.id), [6, 7, 8])
  assert.deepEqual(listEntries(images, -1, images[7]).length, 12)
  // Positions of different lengths are not on one axis: nothing to list.
  assert.deepEqual(listEntries([...images, { id: 12, width: 1, height: 1, at: [4], label: '12', info: [] }], 0, null), [])

  // 8192 images (1024 layers × 8 mips) read each image's position a few times, not 8192 times:
  // the old filter compared every image with every other one on each click.
  let reads = 0
  const many = Array.from({ length: 8192 }, (_, id) => {
    const at = [Math.floor(id / 8), id % 8]
    return { id, width: 1, height: 1, label: '', info: [], get at() { reads++; return at } }
  })
  const rows = listEntries(many, 0, many[8191 - 4])
  assert.equal(rows.length, 1024)
  assert.ok(rows.every((r) => r.at[1] === 3))
  assert.ok(reads < 8192 * 8, `${reads} reads of image positions`)
})

test('Tone controls: 8-bit images get levels, Auto contrast and reset; exposure only past 8-bit display values', () => {
  const u8 = raster(2, 1, 3, 'u8', new Uint8Array(6))
  assert.deepEqual(toneControls(u8), { exposure: false, curve: false, auto: 'contrast' })
  const u16 = raster(2, 1, 3, 'u16', new Uint16Array(6))
  assert.deepEqual(toneControls(u16), { exposure: true, curve: false, auto: 'contrast' })
  const hdr = raster(2, 1, 3, 'f32', new Float32Array(6), { transfer: 'linear' })
  assert.deepEqual(toneControls(hdr), { exposure: true, curve: true, auto: 'exposure' })
  const dem = raster(2, 1, 1, 'f32', new Float32Array(2), { transfer: 'data' })
  assert.deepEqual(toneControls(dem), { exposure: false, curve: false, auto: 'contrast' })
  // Auto contrast on an 8-bit image renders with stretched levels.
  const ramp = raster(3, 1, 1, 'u8', Uint8Array.from([50, 125, 200]))
  const out = new Uint8ClampedArray(12)
  renderRegion(ramp, autoTone(ramp, DEFAULT_TONE), 0, 0, 3, 1, out)
  assert.deepEqual([out[0], out[8]], [0, 255])
})

test('Overview: boxes stay inside the image when one side is shorter than the factor', () => {
  // 1 × 1000: the factor is 100, so each output pixel averages 100 rows of the one column.
  const tall = raster(1, 1000, 1, 'u8', Uint8Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0 : 255)))
  const o = overview(tall, 10)
  assert.deepEqual([o.raster.width, o.raster.height], [1, 10])
  assert.deepEqual(Array.from(o.raster.data), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1])
  // A million-row strip finishes in about the time of its pixel count, not factor² per pixel.
  const strip = raster(1, 1 << 20, 1, 'u8', new Uint8Array(1 << 20).fill(9))
  const started = Date.now()
  overview(strip, 88)
  assert.ok(Date.now() - started < 2000, 'linear in the pixel count')
})

test('Errors: only a failed allocation is "too large", and a missing detail leaves no empty parenthesis', async () => {
  const { serializeError } = await import('./protocol')
  const { ImageError } = await import('./errors')
  const { describeError, stringsFor } = await import('../i18n')
  assert.equal(serializeError(new RangeError('Array buffer allocation failed')).code, 'too-large')
  assert.equal(serializeError(new RangeError('Invalid typed array length: 4294967296')).code, 'too-large')
  assert.equal(serializeError(new RangeError('Maximum call stack size exceeded')).code, 'decode-failed')
  const en = stringsFor('en')
  const ru = stringsFor('ru')
  assert.equal(describeError(new ImageError('too-large'), en), 'The image is too large to decode in a tab.')
  assert.equal(describeError(new ImageError('too-large'), ru), 'Изображение слишком большое для вкладки.')
  assert.equal(describeError(new ImageError('too-large', '130,000'), en), 'The image is too large to decode in a tab (130,000 pixels).')
  assert.equal(describeError(new ImageError('decode-failed'), en), 'The image data could not be decoded.')
  assert.equal(describeError(new ImageError('damaged'), en), 'The file is damaged.')
})

test('Translations: only the tables’ own entries, and text from the file is never translated', async () => {
  const { infoValue, label, sectionTitle, stringsFor, valueText } = await import('../i18n')
  for (const t of [stringsFor('en'), stringsFor('ru')]) {
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      assert.equal(valueText(t, word), word)
      assert.equal(infoValue(t, 'description', word), word)
      assert.equal(infoValue(t, 'colorMode', word), word)
      assert.equal(label(t, word), word)
      assert.equal(sectionTitle(t, word), word)
    }
  }
  const ru = stringsFor('ru')
  // A layer named like a blend mode or a layer kind keeps its name; the blend mode itself is translated.
  assert.equal(infoValue(ru, 'name', 'Overlay'), 'Overlay')
  assert.equal(infoValue(ru, 'name', 'Text'), 'Text')
  assert.equal(infoValue(ru, 'artist', 'Normal'), 'Normal')
  assert.equal(infoValue(ru, 'blend', 'Overlay'), 'Перекрытие')
})

test('Text file: the hint names the view toggle’s Source button as Orca labels it in each language', async () => {
  const { describeError, stringsFor } = await import('../i18n')
  const { ImageError } = await import('./errors')
  assert.ok(describeError(new ImageError('text-file'), stringsFor('en')).includes('Switch to Source in the view toggle'))
  // Orca's Russian UI calls the toggle's Source button «Исходный текст».
  const ru = describeError(new ImageError('text-file'), stringsFor('ru'))
  assert.ok(ru.includes('«Исходный текст»'), ru)
  assert.ok(!/Source/.test(ru))
})
