// Wraps demo pixels made by the Python scripts into containers with the test fixture writers:
// a DNG (previews, a Bayer mosaic, EXIF, GPS, XMP) and a layered PSD. The camera is fictional.
//
//   npx esbuild tools/demo/containers.ts --bundle --platform=node --format=esm --outfile=<tmp>.mjs
//   node <tmp>.mjs dng <dir> | psd <dir>

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { psd, type PsdLayerSpec } from '../../src/fixtures/psd'
import { tiff, type TiffValue } from '../../src/fixtures/tiff'

const SHORT = 3
const LONG = 4
const RATIONAL = 5
const SRATIONAL = 10

function dng(dir: string): void {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  const preview = new Uint8Array(readFileSync(join(dir, 'preview.jpg')))
  const small = new Uint8Array(readFileSync(join(dir, 'preview-small.jpg')))
  const thumb = new Uint8Array(readFileSync(join(dir, 'thumbnail.rgb')))
  const mosaic = new Uint8Array(readFileSync(join(dir, 'mosaic.u16')))
  const [tw, th] = meta.thumb
  const xmp = [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:Rating="4" xmp:CreatorTool="Image Viewer demo">',
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Spheres on the salt plain at sunset</rdf:li></rdf:Alt></dc:title>',
    '<dc:subject><rdf:Bag><rdf:li>sunset</rdf:li><rdf:li>render</rdf:li><rdf:li>demo</rdf:li></rdf:Bag></dc:subject>',
    '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">CC0 1.0</rdf:li></rdf:Alt></dc:rights>',
    '</rdf:Description></rdf:RDF></x:xmpmeta>',
    '<?xpacket end="w"?>'
  ].join('')
  const ascii = (tag: number, text: string): TiffValue => ({ tag, text })
  const exif: TiffValue[] = [
    { tag: 0x829a, type: RATIONAL, values: [1, 250] },
    { tag: 0x829d, type: RATIONAL, values: [8, 1] },
    { tag: 0x8822, type: SHORT, values: [3] },
    { tag: 0x8827, type: SHORT, values: [100] },
    { tag: 0x9000, bytes: new TextEncoder().encode('0232') },
    ascii(0x9003, '2026:09:21 19:42:10'),
    ascii(0x9004, '2026:09:21 19:42:10'),
    ascii(0x9011, '-06:00'),
    { tag: 0x9204, type: SRATIONAL, values: [-1, 3] },
    { tag: 0x9207, type: SHORT, values: [5] },
    { tag: 0x9209, type: SHORT, values: [16] },
    { tag: 0x920a, type: RATIONAL, values: [35, 1] },
    { tag: 0xa001, type: SHORT, values: [1] },
    { tag: 0xa002, type: LONG, values: [meta.width] },
    { tag: 0xa003, type: LONG, values: [meta.height] },
    { tag: 0xa403, type: SHORT, values: [0] },
    { tag: 0xa405, type: SHORT, values: [35] },
    ascii(0xa431, 'DC1-000042'),
    { tag: 0xa432, type: RATIONAL, values: [24, 1, 70, 1, 28, 10, 28, 10] },
    ascii(0xa433, 'Demo Camera Works'),
    ascii(0xa434, 'DC 24-70mm F2.8')
  ]
  const gps: TiffValue[] = [
    { tag: 0, type: 1, values: [2, 3, 0, 0] },
    ascii(1, 'N'),
    { tag: 2, type: RATIONAL, values: [40, 1, 45, 1, 3600, 100] },
    ascii(3, 'W'),
    { tag: 4, type: RATIONAL, values: [113, 1, 53, 1, 2400, 100] },
    { tag: 5, type: 1, values: [0] },
    { tag: 6, type: RATIONAL, values: [1290, 1] },
    ascii(16, 'T'),
    { tag: 17, type: RATIONAL, values: [252, 1] }
  ]
  const file = tiff([
    {
      entries: [
        { tag: 254, type: LONG, values: [1] },
        { tag: 256, type: LONG, values: [tw] },
        { tag: 257, type: LONG, values: [th] },
        { tag: 258, type: SHORT, values: [8, 8, 8] },
        { tag: 259, type: SHORT, values: [1] },
        { tag: 262, type: SHORT, values: [2] },
        ascii(271, 'Demo Camera Works'),
        ascii(272, 'DC-1'),
        { tag: 273, data: [thumb] },
        { tag: 274, type: SHORT, values: [1] },
        { tag: 277, type: SHORT, values: [3] },
        { tag: 278, type: LONG, values: [th] },
        { tag: 279, type: LONG, values: [thumb.length] },
        ascii(305, 'Image Viewer demo'),
        ascii(306, '2026:09:21 19:42:10'),
        { tag: 700, type: 1, bytes: new TextEncoder().encode(xmp) },
        {
          tag: 330,
          ifds: [
            {
              entries: [
                { tag: 254, type: LONG, values: [0] },
                { tag: 256, type: LONG, values: [meta.width] },
                { tag: 257, type: LONG, values: [meta.height] },
                { tag: 258, type: SHORT, values: [16] },
                { tag: 259, type: SHORT, values: [1] },
                { tag: 262, type: SHORT, values: [32803] },
                { tag: 273, data: [mosaic] },
                { tag: 277, type: SHORT, values: [1] },
                { tag: 278, type: LONG, values: [meta.height] },
                { tag: 279, type: LONG, values: [mosaic.length] },
                { tag: 33421, type: SHORT, values: [2, 2] },
                { tag: 33422, type: 1, values: [0, 1, 1, 2] },
                { tag: 50710, type: 1, values: [0, 1, 2] },
                { tag: 50711, type: SHORT, values: [1] },
                { tag: 50714, type: LONG, values: [meta.black] },
                { tag: 50717, type: LONG, values: [meta.white] }
              ]
            },
            {
              entries: [
                { tag: 254, type: LONG, values: [1] },
                { tag: 256, type: LONG, values: [meta.width] },
                { tag: 257, type: LONG, values: [meta.height] },
                { tag: 258, type: SHORT, values: [8, 8, 8] },
                { tag: 259, type: SHORT, values: [7] },
                { tag: 262, type: SHORT, values: [6] },
                { tag: 273, data: [preview] },
                { tag: 277, type: SHORT, values: [3] },
                { tag: 278, type: LONG, values: [meta.height] },
                { tag: 279, type: LONG, values: [preview.length] },
                { tag: 50970, type: LONG, values: [2] }
              ]
            },
            {
              entries: [
                { tag: 254, type: LONG, values: [1] },
                { tag: 256, type: LONG, values: [meta.width / 4] },
                { tag: 257, type: LONG, values: [meta.height / 4] },
                { tag: 258, type: SHORT, values: [8, 8, 8] },
                { tag: 259, type: SHORT, values: [7] },
                { tag: 262, type: SHORT, values: [6] },
                { tag: 273, data: [small] },
                { tag: 277, type: SHORT, values: [3] },
                { tag: 278, type: LONG, values: [meta.height / 4] },
                { tag: 279, type: LONG, values: [small.length] }
              ]
            }
          ]
        },
        { tag: 34665, ifd: { entries: exif } },
        { tag: 34853, ifd: { entries: gps } },
        { tag: 50706, type: 1, values: [1, 4, 0, 0] },
        { tag: 50707, type: 1, values: [1, 1, 0, 0] },
        ascii(50708, 'Demo Camera Works DC-1')
      ]
    }
  ])
  writeFileSync(join(dir, '..', 'sunset.dng'), file)
}

interface LayerFile {
  name: string
  left: number
  top: number
  width: number
  height: number
  file: string
  blend?: string
  opacity?: number
  hidden?: boolean
  section?: number
  marker?: string
  clipping?: boolean
}

function layeredPsd(dir: string): void {
  const spec = JSON.parse(readFileSync(join(dir, 'layers.json'), 'utf8')) as { width: number; height: number; composite: string; out: string; layers: LayerFile[] }
  const planes = (file: string, n: number, channels: number) => {
    const rgba = new Uint8Array(readFileSync(join(dir, file)))
    return Array.from({ length: channels }, (_, k) => {
      const p = new Uint8Array(n)
      for (let i = 0; i < n; i++) p[i] = rgba[i * 4 + k]
      return p
    })
  }
  const layers: PsdLayerSpec[] = spec.layers.map((l) => {
    if (l.section === 3 || !l.file) return { name: l.name, width: 0, height: 0, section: l.section, hidden: l.hidden }
    const n = l.width * l.height
    const [r, g, b, a] = planes(l.file, n, 4)
    return {
      name: l.name,
      left: l.left,
      top: l.top,
      width: l.width,
      height: l.height,
      channels: { [-1]: a, 0: r, 1: g, 2: b },
      blend: l.blend,
      opacity: l.opacity,
      hidden: l.hidden,
      section: l.section,
      marker: l.marker,
      clipping: l.clipping
    }
  })
  const file = psd({
    width: spec.width,
    height: spec.height,
    planes: planes(spec.composite, spec.width * spec.height, 3),
    realMerged: true,
    resolution: 144,
    writer: 'Image Viewer demo',
    xmp: [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Image Viewer demo">',
      '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Desert Light: open-air cinema poster</rdf:li></rdf:Alt></dc:title>',
      '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">CC0 1.0</rdf:li></rdf:Alt></dc:rights>',
      '</rdf:Description></rdf:RDF></x:xmpmeta>'
    ].join(''),
    layers
  })
  writeFileSync(join(dir, '..', spec.out), file)
}

const [what, dir] = process.argv.slice(2)
if (what === 'dng') dng(dir)
else if (what === 'psd') layeredPsd(dir)
else throw new Error('usage: dng <dir> | psd <dir>')
