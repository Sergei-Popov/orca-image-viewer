# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). `scripts/release-plugin.sh` in the hub turns
`[Unreleased]` into the released version.

## [Unreleased]

### Added

- Image Viewer, the default editor for `.tif`, `.tiff`, `.psd`, `.psb`, `.exr`, `.hdr`, `.pic`,
  `.tga`, `.dds`, `.qoi`, `.icns`, `.heic`, `.heif` and `.hif`, and for the camera RAW files
  `.dng`, `.cr2`, `.cr3`, `.nef`, `.nrw`, `.arw`, `.srf`, `.sr2`, `.raf`, `.rw2`, `.rwl`, `.orf`,
  `.ori`, `.pef`, `.srw`, `.iiq`, `.mos`, `.erf` and `.kdc`.
- TIFF: pages and reduced-resolution sub-images, strips and tiles, chunky and planar, 1–32-bit
  integers and 16–64-bit floats, LZW, Deflate, PackBits, JPEG and WebP, predictors, RGB, grey,
  palette, CMYK, YCbCr and CIELAB, BigTIFF.
- PSD and PSB: the saved composite, each layer, groups, layer visibility and a composite of the
  visible layers (blend modes, opacity, clipping, masks); layers composited with a notice when the
  file has no composite.
- OpenEXR: scanline and tiled, multi-part, layers, MIP and RIP levels, half/float/uint channels,
  NONE, RLE, ZIPS, ZIP, PIZ, PXR24, B44 and B44A.
- Radiance HDR, TGA (with the 2.0 extension), QOI, and ICNS with every icon size (JPEG 2000
  entries listed as not supported).
- DDS: uncompressed formats, BC1–BC7 including BC6H, MIP levels, cube faces, array layers and
  volume slices.
- HEIC and HEIF: own container reader with grids, rotation, mirroring, cropping, alpha, depth and
  matte images, thumbnails; HEVC and AV1 decoded by the system through WebCodecs, and a plain
  explanation with the file's details where the system has no HEVC decoder.
- Camera RAW: the largest embedded preview and the smaller ones, EXIF, sensor details and maker
  notes for eight makers, the camera name from XMP when the TIFF tags lack it; no RAW development,
  said in a notice.
- Zoom and pan, Fit and 1:1, checkerboard and pixel grid, pixel values under the pointer, image
  pickers with thumbnails, channel views, histogram, exposure and tone curves for HDR, levels and
  auto contrast, keyboard shortcuts.
- Details pane: image and file details, camera and GPS summaries, all EXIF tags, XMP with the raw
  XML, ICC profile, maker notes; values can be copied.
- Save as PNG through Orca's save dialog, and copy to the clipboard.
- Decoding in a worker with size limits, clear messages for empty, damaged, cut-off and
  unsupported files.
- English and Russian UI following Orca's language; Orca's light and dark themes; plugin and tab
  icons.
