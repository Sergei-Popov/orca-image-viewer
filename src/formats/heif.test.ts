import { assert, test } from 'orca/testing'
import { inflate } from '../core/inflate'
import type { CodedImage, DocDesc, Raster } from '../core/model'
import { openDocument } from '../core/session'
import { auxC, clap, gridData, heif, hvcC, imir, irot, ispe, nclx, pixi } from '../fixtures/heif'
import { tiff } from '../fixtures/tiff'
import { ByteWriter } from '../fixtures/writer'
import { av1Codec } from './heif'

const item = (desc: DocDesc, section: string, key: string) => desc.info.find((s) => s.title === section)?.items.find((i) => i.key === key)?.value

const codeOf = (e: unknown) => (e as { code?: string }).code

const pixel = (r: Raster, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * r.channels, (y * r.width + x + 1) * r.channels))

/** Stands in for WebCodecs: a coded image's first three bytes are its flat colour. */
const video = {
  calls: [] as string[],
  supported: async () => true,
  decode: async (codec: string, _description: Uint8Array, images: readonly CodedImage[], _color: unknown, plane: 'rgba' | 'luma') => {
    video.calls.push(codec)
    return images.map((im) => {
      if (plane === 'luma') return new Uint8Array(im.width * im.height).fill(im.data[0])
      const out = new Uint8Array(im.width * im.height * 4)
      for (let i = 0; i < im.width * im.height; i++) out.set([im.data[0], im.data[1], im.data[2], 255], i * 4)
      return out
    })
  }
}
const platform = { inflate, decodeVideo: video }

const coded = (r: number, g: number, b: number) => new Uint8Array([r, g, b, 0, 0, 0, 1])

test('HEIC grid: tiles placed and cropped, rotation, thumbnail, EXIF, colour and codec details', async () => {
  const exif = new ByteWriter(false)
    .u32(0)
    .bytes(tiff([{ entries: [{ tag: 271, text: 'Test Phone Co' }, { tag: 272, text: 'Phone 12' }] }], { little: false }))
    .done()
  const tile = (id: number, colour: number) => ({ id, type: 'hvc1', hidden: true, data: coded(colour, 0, 0), props: [hvcC(), ispe(2, 2)] })
  const file = heif({
    primary: 1,
    items: [
      { id: 1, type: 'grid', idat: true, data: gridData(2, 2, 3, 3), props: [ispe(3, 3), nclx(1, 13, 6, true), pixi([8, 8, 8]), irot(1)] },
      tile(2, 10),
      tile(3, 20),
      tile(4, 30),
      tile(5, 40),
      { id: 6, type: 'hvc1', data: coded(0, 99, 0), props: [hvcC(), ispe(2, 2)] },
      { id: 7, type: 'Exif', data: exif }
    ],
    refs: [
      { type: 'dimg', from: 1, to: [2, 3, 4, 5] },
      { type: 'thmb', from: 6, to: [1] },
      { type: 'cdsc', from: 7, to: [1] }
    ]
  })
  const doc = await openDocument(file, 'heic', platform)
  const d = doc.desc
  assert.equal(d.format, 'HEIC')
  assert.deepEqual(
    d.images.map((i) => i.label),
    ['Primary image', 'Thumbnail 2×2']
  )
  assert.equal(item(d, 'image', 'codec'), 'hvc1.1.6.L93.B0')
  assert.equal(item(d, 'image', 'grid'), '2 × 2 tiles of 2 × 2')
  assert.equal(item(d, 'image', 'colorSpace'), 'BT.709 primaries, sRGB transfer, BT.601 matrix, full range')
  assert.equal(item(d, 'image', 'rotation'), '90° CCW')
  assert.equal(item(d, 'file', 'thumbnails'), '1')
  assert.ok(item(d, 'camera', 'camera')?.includes('Phone 12'))

  const r = await doc.decode(0)
  assert.deepEqual([r.width, r.height, r.channels], [3, 3, 3])
  // Before the turn: tile 10 top left, 20 top right, 30 bottom left, 40 bottom right (cropped to
  // 3 × 3). A quarter turn anticlockwise brings the top-right tile to the top left.
  assert.equal(pixel(r, 0, 0)[0], 20)
  assert.equal(pixel(r, 2, 0)[0], 40)
  assert.equal(pixel(r, 0, 2)[0], 10)
  assert.equal(pixel(r, 2, 2)[0], 30)
  assert.deepEqual(pixel(await doc.decode(1), 1, 1), [0, 99, 0])
})

test('HEIF alpha and depth: alpha merged into the image, depth listed as its own grey image', async () => {
  const file = heif({
    major: 'mif1',
    brands: ['mif1'],
    primary: 1,
    items: [
      { id: 1, type: 'hvc1', data: coded(200, 100, 50), props: [hvcC(), ispe(4, 2), imir(0)] },
      { id: 2, type: 'hvc1', hidden: true, data: coded(128, 0, 0), props: [hvcC(), ispe(4, 2), auxC('urn:mpeg:hevc:2015:auxid:1')] },
      { id: 3, type: 'hvc1', hidden: true, data: coded(77, 0, 0), props: [hvcC(), ispe(4, 2), auxC('urn:com:apple:photo:2018:aux:portraiteffectsmatte')] }
    ],
    refs: [{ type: 'auxl', from: 2, to: [1] }, { type: 'auxl', from: 3, to: [1] }]
  })
  const doc = await openDocument(file, 'heif', platform)
  const d = doc.desc
  assert.equal(d.format, 'HEIF')
  assert.deepEqual(
    d.images.map((i) => i.label),
    ['Primary image', 'Portrait matte']
  )
  assert.equal(item(d, 'image', 'channels'), 'YCbCr + alpha')
  assert.equal(item(d, 'image', 'mirror'), 'Yes')
  assert.equal(item(d, 'file', 'auxiliary'), 'Alpha, Portrait matte')
  const r = await doc.decode(0)
  assert.ok(r.alpha)
  assert.deepEqual(pixel(r, 3, 1), [200, 100, 50, 128])
  const matte = await doc.decode(1)
  assert.deepEqual([matte.channels, matte.color, matte.data[0]], [1, 'gray', 77])
})

test('HEIF clean aperture, codec strings, and no decoder for the codec', async () => {
  const file = heif({ primary: 1, items: [{ id: 1, type: 'hvc1', data: coded(5, 6, 7), props: [hvcC(), ispe(4, 4), clap(2, 2)] }] })
  const doc = await openDocument(file, 'heic', platform)
  assert.deepEqual([doc.desc.images[0].width, doc.desc.images[0].height], [2, 2])
  const r = await doc.decode(0)
  assert.deepEqual([r.width, r.height], [2, 2])
  assert.equal(av1Codec(new Uint8Array([0x81, 0x08, 0x0c, 0])), 'av01.0.08M.08')

  const without = await openDocument(file, 'heic', { inflate })
  await assert.rejects(
    () => without.decode(0),
    (e: unknown) => codeOf(e) === 'no-video-decoder' && (e as { detail: string }).detail === 'HEVC'
  )
  const refusing = await openDocument(file, 'heic', { inflate, decodeVideo: { ...video, supported: async () => false } })
  await assert.rejects(
    () => refusing.decode(0),
    (e: unknown) => codeOf(e) === 'no-video-decoder' && (e as { detail: string }).detail === 'HEVC'
  )
})

test('HEIF damaged: no meta box, no primary image, item data past the end', async () => {
  const ftypOnly = new ByteWriter(false).u32(16).ascii('ftyp').ascii('heic').u32(0).done()
  await assert.rejects(
    () => openDocument(ftypOnly, 'heic', platform),
    (e: unknown) => codeOf(e) === 'damaged'
  )
  await assert.rejects(
    () => openDocument(heif({ primary: 9, items: [{ id: 1, type: 'Exif', data: new Uint8Array(8) }] }), 'heic', platform),
    (e: unknown) => codeOf(e) === 'damaged'
  )
  const file = heif({ primary: 1, items: [{ id: 1, type: 'hvc1', data: coded(1, 2, 3), props: [hvcC(), ispe(2, 2)] }] })
  const cut = await openDocument(file.subarray(0, file.length - 4), 'heic', platform)
  await assert.rejects(
    () => cut.decode(0),
    (e: unknown) => codeOf(e) === 'damaged'
  )
})

test('HEIF damaged: a coded image whose ispe size is past the limits is too large before decoding', async () => {
  const file = heif({ primary: 1, items: [{ id: 1, type: 'hvc1', data: coded(5, 6, 7), props: [hvcC(), ispe(16318468, 2)] }] })
  let decoded = false
  const doc = await openDocument(file, 'heic', { inflate, decodeVideo: { ...video, decode: async (...args: Parameters<typeof video.decode>) => ((decoded = true), video.decode(...args)) } })
  await assert.rejects(
    () => doc.decode(0),
    (e: unknown) => codeOf(e) === 'too-large'
  )
  assert.equal(decoded, false)
})
