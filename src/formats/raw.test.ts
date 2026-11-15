import { assert, test } from 'orca/testing'
import { inflate } from '../core/inflate'
import type { DocDesc } from '../core/model'
import { openDocument } from '../core/session'
import { miniJpeg, tiff, type TiffIfd, type TiffValue } from '../fixtures/tiff'
import { ByteWriter } from '../fixtures/writer'

/** Decodes JPEGs as a flat grey image of the size their header states. */
const platform = {
  inflate,
  decodeImage: async (data: Uint8Array) => {
    let p = 2
    while (p < data.length && !(data[p] === 0xff && data[p + 1] === 0xc0)) p += 2 + ((data[p + 2] << 8) | data[p + 3])
    const height = (data[p + 5] << 8) | data[p + 6]
    const width = (data[p + 7] << 8) | data[p + 8]
    return { width, height, data: new Uint8Array(width * height * 4).fill(128) }
  }
}

const item = (desc: DocDesc, section: string, key: string) => desc.info.find((s) => s.title === section)?.items.find((i) => i.key === key)?.value

const ascii = (s: string) => new TextEncoder().encode(s)
const concat = (...parts: Uint8Array[]) => {
  const w = new ByteWriter(false)
  for (const p of parts) w.bytes(p)
  return w.done()
}

test('RAW (Nikon layout): largest preview first, maker-note preview, orientation, sensor and lens details', async () => {
  const thumb = miniJpeg(160, 120)
  const big = miniJpeg(640, 424)
  const note = concat(
    ascii('Nikon\0'),
    new Uint8Array([2, 0x11, 0, 0]),
    tiff(
      [
        {
          entries: [
            { tag: 0x1d, text: '7654321' },
            { tag: 0x84, type: 5, values: [24, 1, 70, 1, 28, 10, 28, 10] },
            { tag: 0x11, ifd: { entries: [{ tag: 513, data: [big] }, { tag: 514, type: 4, values: [big.length] }] } }
          ]
        }
      ],
      { little: false }
    )
  )
  const file = tiff([
    {
      entries: [
        { tag: 254, type: 4, values: [1] },
        { tag: 271, text: 'NIKON CORPORATION' },
        { tag: 272, text: 'NIKON TEST' },
        { tag: 274, type: 3, values: [6] },
        { tag: 513, data: [thumb] },
        { tag: 514, type: 4, values: [thumb.length] },
        {
          tag: 34665,
          ifd: {
            entries: [
              { tag: 0x829a, type: 5, values: [1, 250] },
              { tag: 0x829d, type: 5, values: [28, 10] },
              { tag: 0x8827, type: 3, values: [200] },
              { tag: 0x927c, bytes: note }
            ]
          }
        },
        {
          tag: 330,
          ifds: [
            {
              entries: [
                { tag: 254, type: 4, values: [0] },
                { tag: 256, type: 4, values: [6048] },
                { tag: 257, type: 4, values: [4024] },
                { tag: 258, type: 3, values: [14] },
                { tag: 259, type: 3, values: [34713] },
                { tag: 262, type: 3, values: [32803] }
              ]
            }
          ]
        }
      ]
    }
  ])
  const doc = await openDocument(file, 'nef', platform)
  const d = doc.desc
  assert.equal(d.format, 'Nikon NEF')
  // Orientation 6 turns both previews a quarter.
  assert.deepEqual(
    d.images.map((i) => i.label),
    ['Largest preview · 424×640', 'Thumbnail · 120×160']
  )
  assert.deepEqual(
    d.notices.map((n) => [n.code, n.detail]),
    [['raw-preview', '424 × 640']]
  )
  assert.equal(item(d, 'image', 'sensor'), '6048 × 4024')
  assert.equal(item(d, 'image', 'bitDepth'), '14-bit')
  assert.equal(item(d, 'makernote', 'Lens'), '24–70 mm f/2.8')
  assert.equal(item(d, 'makernote', 'Serial number'), '7654321')
  assert.ok(item(d, 'camera', 'exposure')?.includes('1/250 s'))
  const r = await doc.decode(0)
  assert.equal(r.width, 424)
  assert.equal(r.height, 640)
  assert.equal(r.channels, 3)
})

test('RAW (Fujifilm RAF): the JPEG carries EXIF, its own orientation and the maker note', async () => {
  // A maker note: "FUJIFILM", the IFD offset (12), then an IFD with offsets from the note's start.
  const fujiTiff = tiff([{ entries: [{ tag: 0x1000, text: 'NORMAL' }, { tag: 0x10, text: 'FF02TEST' }] }], { pad: 4 })
  const fuji = fujiTiff.slice()
  fuji.set(ascii('FUJIFILM'), 0)
  fuji.set([12, 0, 0, 0], 8)
  const exif = tiff([
    {
      entries: [
        { tag: 271, text: 'FUJIFILM' },
        { tag: 272, text: 'X-TEST' },
        { tag: 274, type: 3, values: [8] },
        { tag: 34665, ifd: { entries: [{ tag: 0x927c, bytes: fuji }] } }
      ]
    }
  ])
  const jpeg = miniJpeg(300, 200, exif)
  const header = new ByteWriter(false).ascii('FUJIFILMCCD-RAW 0201FF383501').ascii('X-TEST').zeros(50).done()
  const w = new ByteWriter(false).bytes(header.subarray(0, 84))
  w.u32(100).u32(jpeg.length).zeros(8).bytes(jpeg)
  const doc = await openDocument(w.done(), 'raf', platform)
  const d = doc.desc
  assert.equal(d.format, 'Fujifilm RAF')
  // The browser turns a JPEG with its own orientation, so the size stays as stored.
  assert.deepEqual(
    d.images.map((i) => `${i.width}×${i.height}`),
    ['300×200']
  )
  assert.equal(item(d, 'makernote', 'Quality'), 'NORMAL')
  assert.equal(item(d, 'makernote', 'Internal serial number'), 'FF02TEST')
  assert.equal(item(d, 'image', 'model'), 'X-TEST')
})

/** An ISO BMFF box. */
function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const data = concat(...body)
  return new ByteWriter(false)
    .u32(data.length + 8)
    .ascii(type)
    .bytes(data)
    .done()
}

test('RAW (Canon CR3): EXIF from the CMT boxes, previews from the media data', async () => {
  const uuid = new Uint8Array([0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48])
  const cmt1 = tiff([{ entries: [{ tag: 271, text: 'Canon' }, { tag: 272, text: 'Canon EOS TEST' }, { tag: 274, type: 3, values: [1] }] }])
  const cmt2 = tiff([{ entries: [{ tag: 0x829a, type: 5, values: [1, 20] }] }])
  const cmt3 = tiff([{ entries: [{ tag: 0x95, text: 'RF50mm F1.4' }, { tag: 0x7, text: 'Firmware Version 1.0.0' }] }])
  const file = concat(
    box('ftyp', ascii('crx '), new Uint8Array(4), ascii('crx isom')),
    box('moov', box('uuid', uuid, box('CMT1', cmt1), box('CMT2', cmt2), box('CMT3', cmt3))),
    box('mdat', miniJpeg(600, 400), new Uint8Array(64), miniJpeg(160, 120))
  )
  const doc = await openDocument(file, 'cr3', platform)
  const d = doc.desc
  assert.equal(d.format, 'Canon CR3')
  assert.deepEqual(
    d.images.map((i) => i.label),
    ['Largest preview · 600×400', 'Thumbnail · 160×120']
  )
  assert.equal(item(d, 'makernote', 'Lens model'), 'RF50mm F1.4')
  assert.ok(item(d, 'camera', 'camera')?.includes('Canon EOS TEST'))
  assert.ok(item(d, 'camera', 'exposure')?.includes('1/20 s'))
})

test('RAW (DNG): an uncompressed RGB thumbnail is a preview too', async () => {
  const w = 40
  const h = 32
  const strip = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) strip.set([200, 100, 50], i * 3)
  const file = tiff([
    {
      entries: [
        { tag: 254, type: 4, values: [1] },
        { tag: 256, type: 3, values: [w] },
        { tag: 257, type: 3, values: [h] },
        { tag: 258, type: 3, values: [8, 8, 8] },
        { tag: 259, type: 3, values: [1] },
        { tag: 262, type: 3, values: [2] },
        { tag: 273, data: [strip] },
        { tag: 277, type: 3, values: [3] },
        { tag: 278, type: 3, values: [h] },
        { tag: 279, type: 4, values: [strip.length] },
        { tag: 50706, type: 1, values: [1, 4, 0, 0] }
      ]
    }
  ])
  const doc = await openDocument(file, 'dng', platform)
  assert.equal(doc.desc.format, 'DNG 1.4.0.0')
  const r = await doc.decode(0)
  assert.equal(r.width, w)
  assert.deepEqual(Array.from(r.data.subarray(0, 3)), [200, 100, 50])
})

test('RAW damaged: no preview at all, and a cut-off file keeps the previews before the cut', async () => {
  const bare = tiff([{ entries: [{ tag: 271, text: 'NIKON CORPORATION' }] }])
  await assert.rejects(
    () => openDocument(bare, 'nef', platform),
    (e: unknown) => (e as { code?: string }).code === 'unsupported-feature'
  )
  const thumb = miniJpeg(160, 120)
  const big = miniJpeg(640, 480)
  const file = tiff([
    { entries: [{ tag: 513, data: [thumb] }, { tag: 514, type: 4, values: [thumb.length] }] },
    { entries: [{ tag: 513, data: [big] }, { tag: 514, type: 4, values: [big.length] }] }
  ])
  const cut = file.subarray(0, file.length - 10)
  const doc = await openDocument(cut, 'nef', platform)
  assert.deepEqual(
    doc.desc.images.map((i) => i.label),
    ['Largest preview · 160×120']
  )
})

// ---------------------------------------------------------------- more TIFF-based RAW layouts

/** An uncompressed 8-bit RGB thumbnail IFD filled with one colour. */
function rgbThumb(w: number, h: number, rgb: number[], extra: TiffValue[] = []): TiffIfd {
  const strip = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) strip.set(rgb, i * 3)
  return {
    entries: [
      { tag: 254, type: 4, values: [1] },
      { tag: 256, type: 3, values: [w] },
      { tag: 257, type: 3, values: [h] },
      { tag: 258, type: 3, values: [8, 8, 8] },
      { tag: 259, type: 3, values: [1] },
      { tag: 262, type: 3, values: [2] },
      { tag: 273, data: [strip] },
      { tag: 277, type: 3, values: [3] },
      { tag: 278, type: 3, values: [h] },
      { tag: 279, type: 4, values: [strip.length] },
      ...extra
    ]
  }
}

/** A colour-filter-array sensor IFD (no data: only its description is read). */
function sensorIfd(w: number, h: number, bits: number, compression: number): TiffIfd {
  return {
    entries: [
      { tag: 254, type: 4, values: [0] },
      { tag: 256, type: 4, values: [w] },
      { tag: 257, type: 4, values: [h] },
      { tag: 258, type: 3, values: [bits] },
      { tag: 259, type: 3, values: [compression] },
      { tag: 262, type: 3, values: [32803] },
      { tag: 277, type: 3, values: [1] }
    ]
  }
}

const camera = (make: string, model: string): TiffValue[] => [
  { tag: 271, text: make },
  { tag: 272, text: model }
]

test('RAW (Sony SR2): the IFD0 JPEG preview and the sensor in a sub-IFD', async () => {
  const big = miniJpeg(640, 424)
  const file = tiff([
    {
      entries: [
        ...camera('SONY', 'DSC-R1'),
        { tag: 513, data: [big] },
        { tag: 514, type: 4, values: [big.length] },
        { tag: 330, ifds: [sensorIfd(3984, 2608, 16, 1)] }
      ]
    }
  ])
  const doc = await openDocument(file, 'sr2', platform)
  assert.equal(doc.desc.format, 'Sony SR2')
  assert.equal(doc.desc.images[0].label, 'Largest preview · 640×424')
  assert.equal(item(doc.desc, 'image', 'sensor'), '3984 × 2608')
  assert.equal(item(doc.desc, 'camera', 'camera'), 'SONY DSC-R1')
})

test('RAW (Olympus ORI): the "IIRO" header, a preview found by scanning, turned by the orientation tag', async () => {
  const file = concat(tiff([{ entries: [...camera('OLYMPUS IMAGING CORP.', 'E-M5MarkII'), { tag: 274, type: 3, values: [6] }] }], { magic: 0x4f52 }), miniJpeg(320, 240))
  const doc = await openDocument(file, 'ori', platform)
  assert.equal(doc.desc.format, 'Olympus ORI')
  assert.equal(doc.desc.images[0].label, 'Largest preview · 240×320')
  const r = await doc.decode(0)
  assert.deepEqual([r.width, r.height], [240, 320])
})

test('RAW (Leica RWL): the "IIU" header and the JPEG in IFD0 tag 0x2e', async () => {
  const jpeg = miniJpeg(1920, 1080)
  const file = tiff([{ entries: [...camera('LEICA', 'D-LUX 5'), { tag: 0x2e, bytes: jpeg }] }], { magic: 0x55 })
  const doc = await openDocument(file, 'rwl', platform)
  assert.equal(doc.desc.format, 'Leica RWL')
  assert.equal(doc.desc.images[0].label, 'Largest preview · 1920×1080')
  assert.equal(item(doc.desc, 'camera', 'camera'), 'LEICA D-LUX 5')
})

test('RAW (Phase One IIQ): an uncompressed RGB preview in IFD0, turned by the orientation tag', async () => {
  const file = tiff([rgbThumb(40, 32, [10, 20, 30], [...camera('Phase One A/S', 'P40+'), { tag: 274, type: 3, values: [6] }])])
  const doc = await openDocument(file, 'iiq', platform)
  assert.equal(doc.desc.format, 'Phase One IIQ')
  assert.equal(doc.desc.images[0].label, 'Largest preview · 32×40')
  assert.equal(item(doc.desc, 'camera', 'camera'), 'Phase One A/S P40+')
  const r = await doc.decode(0)
  assert.deepEqual([r.width, r.height], [32, 40])
  assert.deepEqual(Array.from(r.data.subarray(0, 3)), [10, 20, 30])
})

test('RAW (Epson ERF): big-endian, an RGB thumbnail, a packed 12-bit sensor, an Olympus-style maker note', async () => {
  // "EPSON", a version, then an IFD in the file's byte order with one short text tag held inline.
  const note = new ByteWriter(false).ascii('EPSON').u8(0).u16(0x0100).u16(1).u16(0x020d).u16(2).u32(4).ascii('SS3').u8(0).u32(0).done()
  const exif: TiffValue = { tag: 34665, ifd: { entries: [{ tag: 0x927c, bytes: note }] } }
  const file = tiff([rgbThumb(48, 36, [200, 150, 100], [...camera('SEIKO EPSON CORP.', 'R-D1'), exif, { tag: 330, ifds: [sensorIfd(3040, 2024, 12, 32769)] }])], { little: false })
  const doc = await openDocument(file, 'erf', platform)
  assert.equal(doc.desc.format, 'Epson ERF')
  assert.equal(item(doc.desc, 'image', 'sensor'), '3040 × 2024')
  assert.equal(item(doc.desc, 'image', 'bitDepth'), '12-bit')
  assert.equal(item(doc.desc, 'image', 'compression'), 'Packed')
  assert.equal(item(doc.desc, 'makernote', 'Maker'), 'Epson')
  assert.equal(item(doc.desc, 'makernote', 'Tag 0x020D'), 'SS3')
  const r = await doc.decode(0)
  assert.deepEqual(Array.from(r.data.subarray(0, 3)), [200, 150, 100])
})

test('RAW (Kodak KDC): a JPEG-compressed IFD0 that points at a full-size JPEG', async () => {
  const big = miniJpeg(3264, 2448)
  const file = tiff([
    {
      entries: [
        ...camera('EASTMAN KODAK COMPANY', 'KODAK P880 ZOOM DIGITAL CAMERA'),
        { tag: 259, type: 3, values: [7] },
        { tag: 262, type: 3, values: [6] },
        { tag: 513, data: [big] },
        { tag: 514, type: 4, values: [big.length] }
      ]
    }
  ])
  const doc = await openDocument(file, 'kdc', platform)
  assert.equal(doc.desc.format, 'Kodak KDC')
  assert.equal(doc.desc.images[0].label, 'Largest preview · 3264×2448')
})

test('RAW (Leaf MOS): a preview found by scanning, the camera named only in XMP', async () => {
  const xmp = ascii(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/">' +
      '<tiff:Make>Leaf</tiff:Make><tiff:Model>Leaf Aptus 22(LF00000    )/Mamiya 645 AFD</tiff:Model>' +
      '</rdf:Description></rdf:RDF></x:xmpmeta>'
  )
  const sensor: TiffIfd = {
    entries: [
      { tag: 256, type: 4, values: [5344] },
      { tag: 257, type: 4, values: [4008] },
      { tag: 258, type: 3, values: [16] },
      { tag: 259, type: 3, values: [99] },
      { tag: 262, type: 3, values: [1] },
      { tag: 305, text: 'Camera Library' },
      { tag: 700, type: 1, bytes: xmp }
    ]
  }
  const file = concat(tiff([sensor], { little: false }), miniJpeg(332, 244))
  const doc = await openDocument(file, 'mos', platform)
  assert.equal(doc.desc.format, 'Leaf MOS')
  assert.equal(doc.desc.images[0].label, 'Largest preview · 332×244')
  assert.equal(item(doc.desc, 'camera', 'camera'), 'Leaf Aptus 22(LF00000)/Mamiya 645 AFD')
})

test('RAW details in Russian: sensor, orientation and EXIF named values translated; byte counts in Russian format', async () => {
  const { englishLeft } = await import('../fixtures/russian')
  const { infoValue, stringsFor } = await import('../i18n')
  const sensor = sensorIfd(4000, 3000, 16, 7)
  sensor.entries.push({ tag: 50717, type: 3, values: [4095] })
  const file = tiff([
    {
      entries: [
        ...rgbThumb(48, 36, [10, 20, 30]).entries,
        ...camera('Test Camera Co', 'TC-1'),
        { tag: 274, type: 3, values: [8] },
        { tag: 50706, type: 1, values: [1, 4, 0, 0] },
        {
          tag: 34665,
          ifd: {
            entries: [
              { tag: 0x829a, type: 5, values: [1, 250] },
              { tag: 0x8822, type: 3, values: [3] },
              { tag: 0x9207, type: 3, values: [5] },
              { tag: 0x9208, type: 3, values: [0] },
              { tag: 0x9209, type: 3, values: [16] },
              { tag: 0x920a, type: 5, values: [35, 1] },
              { tag: 0xa402, type: 3, values: [2] },
              { tag: 0xa403, type: 3, values: [0] },
              { tag: 0xa406, type: 3, values: [1] },
              { tag: 0xa40a, type: 3, values: [1] },
              { tag: 0x927c, bytes: new Uint8Array(1234) },
              { tag: 0xa430, text: 'Normal' }
            ]
          }
        },
        { tag: 330, ifds: [sensor] }
      ]
    }
  ])
  const doc = await openDocument(file, 'dng', platform)
  assert.deepEqual(englishLeft(doc.desc), [])
  const exif = doc.desc.info.find((s) => s.title === 'exif')?.items ?? []
  const ru = stringsFor('ru')
  const shown = (key: string) => {
    const i = exif.find((x) => x.key === key)
    return i && (i.term ? infoValue(ru, i.key, i.value) : i.value)
  }
  assert.equal(shown('ExposureProgram'), 'Приоритет диафрагмы')
  assert.equal(shown('MeteringMode'), 'Матричный')
  assert.equal(shown('Flash'), 'Не сработала, выключена')
  assert.equal(shown('FocalLength'), '35 мм')
  // Russian groups digits with a no-break space.
  assert.equal(shown('MakerNote'), '1\u00a0234 байта')
  // Text from the file stays as written, even a word the tables know.
  assert.equal(shown('OwnerName'), 'Normal')
  assert.equal(infoValue(stringsFor('en'), 'MakerNote', '1234 bytes'), '1,234 bytes')
})
