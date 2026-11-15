import { assert, test } from 'orca/testing'
import { inflate } from '../core/inflate'
import type { DocDesc } from '../core/model'
import { openDocument } from '../core/session'
import { miniJpeg, tiff } from '../fixtures/tiff'
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
