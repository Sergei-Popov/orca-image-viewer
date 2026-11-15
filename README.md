# Image Viewer for Orca

Image formats that [Orca](https://orca.dev) cannot show on its own, opened in its editor tabs: from
the file tree, a file link in an agent chat, or `orca file open`, like any picture. Without the
plugin Orca shows "Binary file — cannot display" for them.

| Files                                                                                                                                | What opens                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `.tif` `.tiff` `.psd` `.psb` `.exr` `.hdr` `.pic` `.tga` `.dds` `.qoi` `.icns` `.heic` `.heif` `.hif`                                | **Image Viewer**, the default view for these files  |
| `.dng` `.cr2` `.cr3` `.nef` `.nrw` `.arw` `.srf` `.sr2` `.raf` `.rw2` `.rwl` `.orf` `.ori` `.pef` `.srw` `.iiq` `.mos` `.erf` `.kdc` | **Image Viewer** with the camera's embedded preview |

PNG, JPEG, GIF, SVG, WebP, BMP, ICO and AVIF stay with Orca's own image view: the plugin does not
register them.

## What you can do

- **Look closely.** Zoom up to 128× with ⌘/Ctrl + wheel, a pinch, a double-click, the keys or
  the buttons; scroll or drag to pan; **Fit** or **1:1**. Transparent pixels sit on a
  checkerboard, and from 20× a pixel grid shows.
- **Read pixel values.** The status bar shows the position under the pointer and the pixel's
  values as stored in the file: 8 and 16-bit integers, half and full floats.
- **Pick what to see.** Pages, sub-images, layers, EXR parts, layers and MIP levels, DDS cube
  faces, array layers, MIP levels and volume slices, ICNS sizes, RAW previews and HEIF images each
  get a picker in the toolbar. The side pane lists the main kind with a thumbnail of each: TIFF
  pages, PSD layers, EXR parts or layers, DDS cube faces or array layers at the chosen MIP level
  (or the MIP levels when there is nothing else), ICNS sizes and RAW previews.
- **Channels.** Colour, red, green, blue, alpha or luminance, alone and in grey.
- **Exposure and tone.** Every image gets levels with **Auto** contrast and a reset. HDR images
  (EXR, Radiance HDR, float TIFF and PSD, BC6H and float DDS) get **Auto** exposure from the
  highlights instead and a tone curve (Clip, Reinhard, Filmic); they and 16-bit images also get an
  exposure slider in stops. A histogram follows what you see.
- **Details.** The side pane lists what the file says about itself: dimensions, bit depth, colour
  model, compression and layout; camera, lens, exposure, focal length, flash and the time taken;
  GPS position, altitude and direction; every EXIF tag; XMP properties (title, keywords, rating,
  rights…) with the raw XML; the ICC profile's name, class and version; the camera maker's notes
  for RAW files. Each value can be copied.
- **Save as PNG.** Saves what you see — the current image, layer or channel with its exposure —
  through Orca's save dialog. **Copy** puts it on the clipboard where the system allows it.

## Formats

- **TIFF** — every page and sub-IFD (reduced-resolution images), strips and tiles, chunky and
  planar, 1 to 32-bit integers, 16, 24, 32 and 64-bit floats; uncompressed, LZW, Deflate, PackBits,
  JPEG (with shared tables) and WebP; horizontal and floating-point predictors; RGB, grey,
  palette, CMYK, YCbCr, CIELAB, extra alpha channels; BigTIFF; EXIF, GPS, XMP, ICC and page names.
- **PSD and PSB** — the saved composite, every layer on its own, groups, visibility toggles, and
  a composite of the visible layers with blend modes, opacity, clipping and masks. When a file
  has no saved composite the layers are composited and a notice says so. Adjustment layers and
  layer effects are not drawn. RGB, grey, CMYK, Lab, indexed and bitmap, 8, 16 and 32-bit.
- **OpenEXR** — scanline and tiled images, multi-part files, layers (`diffuse.R` …), MIP and
  RIP levels, data and display windows; half, float and uint channels; NONE, RLE, ZIPS, ZIP, PIZ,
  PXR24, B44 and B44A compression. DWAA/DWAB and deep images are listed but not drawn.
- **Radiance HDR** (`.hdr`, `.pic`) — RGBE and XYZE, flat and run-length coded, every scan order.
- **TGA** — true colour, grey and colour-mapped, run-length coded or not, any origin, the TGA 2.0
  extension (author, software, date, alpha type).
- **DDS** — uncompressed formats, BC1–BC5 (DXT1–5, ATI1/2), BC6H and BC7; MIP chains, cube maps,
  texture arrays and volume slices; legacy and DX10 headers.
- **QOI** — all of it.
- **ICNS** — every size in the file (PNG, JPEG, ARGB and the old RLE icons with their masks).
  JPEG 2000 entries are listed as not supported.
- **HEIC and HEIF** — the primary image, other top-level images and thumbnails; grid images,
  rotation, mirroring and cropping; the alpha plane; depth and portrait mattes as grey images;
  EXIF and colour information. The plugin reads the HEIF container itself and hands the HEVC or
  AV1 data to the system's video decoder through WebCodecs. Orca decodes HEVC only with the
  graphics hardware: every Mac can; on Windows and Linux it depends on the graphics card and its
  driver (on Linux also on VA-API support). Where no HEVC decoder is available, the viewer says
  so, explains why, and still lists the file's details.
- **Camera RAW** — the largest **embedded preview** the camera saved in the file (usually a
  full-size JPEG), turned the way the camera was held, with the smaller previews, the EXIF data,
  the sensor size and RAW compression, and the maker's notes for Canon, Nikon, Sony, Fujifilm,
  OM System/Olympus, Panasonic, Pentax and Samsung. The viewer does **not** develop the RAW
  sensor data (no demosaicing), so what you see is the camera's own rendering, and a notice says
  so. Some cameras and digital backs embed only a small preview (IIQ and MOS files often carry
  about 300 pixels across, Epson ERF files 640); that is what you get for them. When the TIFF tags
  do not name the camera or give the exposure, they come from the file's XMP. A RAW file without a
  preview gets a message instead.

**Not supported:** JPEG XL (`.jxl`) — every practical decoder for it is WebAssembly, which this
plugin does not ship, so the type is not registered. RAW types whose files carry no rendered
preview (`.dcr` keeps only unprocessed sensor colours, `.gpr` none at all) or are usually larger
than Orca's 50 MiB limit (`.3fr`, `.fff`) are not registered either. Also not: developing RAW
sensor data, EXR DWA compression and deep data, PSD adjustment layers and layer effects, JPEG 2000
inside TIFF or ICNS.

## Limits

- **File size.** Orca hands a plugin editor at most about **50 MiB** of a file; for larger files
  it shows its own message and the plugin never sees them.
- **Image size.** One decoded image may have up to 120 megapixels and 768 MiB of samples;
  larger ones get a "too large" message (other images in the same file still open).
- Decoding runs in a worker, so a slow file never freezes the tab, and only the image on screen
  is kept decoded.
- A damaged or cut-off file shows what could be read and says what is missing; an empty file or
  a file of another kind gets a plain message.

## Privacy

Read-only and offline: the plugin asks for no capabilities, makes no network requests and never
changes the file. The file's bytes are decoded inside the tab.

The UI is in English or Russian, following Orca's language, and follows Orca's light and dark
themes.

## Keyboard

| Key                     | Action                                     |
| ----------------------- | ------------------------------------------ |
| `+` / `−`               | Zoom in / out                              |
| `0` / `1` / `2`         | Fit / 100% / 200%                          |
| Arrows                  | Pan                                        |
| `[` / `]`, PgUp / PgDn  | Previous / next page, layer or image       |
| `C` `R` `G` `B` `A` `L` | Colour, red, green, blue, alpha, luminance |
| `E` / `Shift+E`         | Exposure up / down half a stop             |
| `I`                     | Show or hide the details pane              |

## Install

From the catalog: Orca → Settings → Plugins → ⋯ → **Catalog sources…** → add
`https://github.com/Sergei-Popov/orca-plugin.git`, then install **Image Viewer**.

From source:

```sh
git clone https://github.com/Sergei-Popov/orca-image-viewer.git
orca plugin dev load ./orca-image-viewer   # prints the access it needs and an --approve fingerprint
```

## Develop

No build step: Orca transpiles the TypeScript in `src/` on load.

```sh
orca plugin dev watch . --check   # load, reload on save, stream logs
orca plugin test .                # unit tests (src/**/*.test.ts)
npx -p typescript tsc -p .        # type check (after `orca plugin types .`)
orca plugin check . && orca plugin validate .
orca plugin shot local.image-viewer --editor "$PWD/path/to/image.tif"   # PNG of the editor
```

- `src/editor.ts` — the custom editor entry: the file's bytes → the viewer.
- `src/core/` — the document model, the worker and its protocol, pixel conversion, the PNG
  writer, inflate (with the browser's `DecompressionStream`), WebCodecs and browser decoding.
- `src/formats/` — one reader per format (`tiff.ts`, `psd.ts`, `exr.ts`, `heif.ts`, `raw.ts` …),
  DOM-free and tested in Node with files built byte by byte in `src/fixtures/`.
- `src/codecs/` — LZW, PackBits, predictors, EXR PIZ/PXR24/B44 and the BC block decoders.
- `src/meta/` — EXIF/TIFF directories, XMP and ICC.
- `src/viewer/` — the view (`view.ts`), the tiled canvas with zoom and pan (`viewport.ts`) and
  the tone pipeline (`tone.ts`); `src/i18n.ts`, `src/styles.ts`, `src/icons.ts`.
- `tools/demo/` — generators for demo images: a small ray tracer
  (`scene.py`) and scripts that write its render as EXR, HDR, HEIC and DNG (`outputs.py`), a
  layered poster (`poster.py`), DDS textures and a terrain TIFF (`textures.py`), and the DNG and
  PSD containers (`containers.ts`). Everything they draw is made by them; the demo camera is
  fictional. Put the output in `.samples/` (git-ignored).
- `tools/rasterize-icons.sh` — the PNG icons from `icons/*.svg` and `images/icon.svg`.

## Trademarks

Independent; not affiliated with Adobe, Apple, Microsoft, the Academy Software Foundation
(OpenEXR), Canon, Nikon, Sony, Fujifilm, OM Digital Solutions (Olympus), Panasonic, Leica Camera,
Ricoh (Pentax), Samsung, Phase One (Leaf), Seiko Epson or Eastman Kodak. Their names appear only
to say which files the plugin reads.

## License

[MIT](LICENSE)
