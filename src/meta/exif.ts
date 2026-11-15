// EXIF: the camera summary (translated labels), every tag by its standard name, and GPS as text.
// Works on any TIFF-structured block: a TIFF or RAW file's IFD0, or the EXIF of a JPEG, HEIF, PNG
// or PSD (which starts at its own `II`/`MM` header).

import { hex } from '../core/bytes'
import type { InfoItem, InfoSection } from '../core/model'
import { type Ifd, type IfdEntry, Tiff, T } from './ifd'

const IFD0_NAMES: Record<number, string> = {
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation',
  0x011a: 'XResolution', 0x011b: 'YResolution', 0x0128: 'ResolutionUnit', 0x0131: 'Software',
  0x0132: 'DateTime', 0x013b: 'Artist', 0x013c: 'HostComputer', 0x013e: 'WhitePoint',
  0x013f: 'PrimaryChromaticities', 0x0211: 'YCbCrCoefficients', 0x0213: 'YCbCrPositioning',
  0x0214: 'ReferenceBlackWhite', 0x8298: 'Copyright', 0x4746: 'Rating', 0x4749: 'RatingPercent',
  0xc612: 'DNGVersion', 0xc613: 'DNGBackwardVersion', 0xc614: 'UniqueCameraModel',
  0xc615: 'LocalizedCameraModel', 0xc62f: 'CameraSerialNumber', 0xc630: 'DNGLensInfo',
  0xc65a: 'CalibrationIlluminant1', 0xc65b: 'CalibrationIlluminant2', 0xc628: 'AsShotNeutral',
  0xc68b: 'OriginalRawFileName', 0xc6f8: 'ProfileName', 0xc6f4: 'ProfileCalibrationSignature',
  0xc716: 'PreviewApplicationName', 0xc717: 'PreviewApplicationVersion', 0xc71b: 'PreviewDateTime',
  0x9c9b: 'XPTitle', 0x9c9c: 'XPComment', 0x9c9d: 'XPAuthor', 0x9c9e: 'XPKeywords', 0x9c9f: 'XPSubject'
}

const EXIF_NAMES: Record<number, string> = {
  0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram', 0x8824: 'SpectralSensitivity',
  0x8827: 'ISO', 0x8830: 'SensitivityType', 0x8832: 'RecommendedExposureIndex', 0x9000: 'ExifVersion',
  0x9003: 'DateTimeOriginal', 0x9004: 'CreateDate', 0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal',
  0x9012: 'OffsetTimeDigitized', 0x9101: 'ComponentsConfiguration', 0x9102: 'CompressedBitsPerPixel',
  0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9203: 'BrightnessValue',
  0x9204: 'ExposureCompensation', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance',
  0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash', 0x920a: 'FocalLength',
  0x9214: 'SubjectArea', 0x927c: 'MakerNote', 0x9286: 'UserComment', 0x9290: 'SubSecTime',
  0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized', 0xa000: 'FlashpixVersion',
  0xa001: 'ColorSpace', 0xa002: 'ExifImageWidth', 0xa003: 'ExifImageHeight', 0xa004: 'RelatedSoundFile',
  0xa20e: 'FocalPlaneXResolution', 0xa20f: 'FocalPlaneYResolution', 0xa210: 'FocalPlaneResolutionUnit',
  0xa215: 'ExposureIndex', 0xa217: 'SensingMethod', 0xa300: 'FileSource', 0xa301: 'SceneType',
  0xa302: 'CFAPattern', 0xa401: 'CustomRendered', 0xa402: 'ExposureMode', 0xa403: 'WhiteBalance',
  0xa404: 'DigitalZoomRatio', 0xa405: 'FocalLengthIn35mmFormat', 0xa406: 'SceneCaptureType',
  0xa407: 'GainControl', 0xa408: 'Contrast', 0xa409: 'Saturation', 0xa40a: 'Sharpness',
  0xa40c: 'SubjectDistanceRange', 0xa420: 'ImageUniqueID', 0xa430: 'OwnerName',
  0xa431: 'SerialNumber', 0xa432: 'LensInfo', 0xa433: 'LensMake', 0xa434: 'LensModel',
  0xa435: 'LensSerialNumber', 0xa460: 'CompositeImage', 0xa500: 'Gamma'
}

const GPS_NAMES: Record<number, string> = {
  0: 'GPSVersionID', 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef', 4: 'GPSLongitude',
  5: 'GPSAltitudeRef', 6: 'GPSAltitude', 7: 'GPSTimeStamp', 8: 'GPSSatellites', 9: 'GPSStatus',
  10: 'GPSMeasureMode', 11: 'GPSDOP', 12: 'GPSSpeedRef', 13: 'GPSSpeed', 14: 'GPSTrackRef',
  15: 'GPSTrack', 16: 'GPSImgDirectionRef', 17: 'GPSImgDirection', 18: 'GPSMapDatum',
  19: 'GPSDestLatitudeRef', 20: 'GPSDestLatitude', 21: 'GPSDestLongitudeRef', 22: 'GPSDestLongitude',
  23: 'GPSDestBearingRef', 24: 'GPSDestBearing', 25: 'GPSDestDistanceRef', 26: 'GPSDestDistance',
  27: 'GPSProcessingMethod', 28: 'GPSAreaInformation', 29: 'GPSDateStamp', 30: 'GPSDifferential',
  31: 'GPSHPositioningError'
}

const ENUMS: Record<string, Record<number, string>> = {
  Orientation: {
    1: 'Normal', 2: 'Mirrored horizontally', 3: 'Rotated 180°', 4: 'Mirrored vertically',
    5: 'Mirrored, rotated 90° CCW', 6: 'Rotated 90° CW', 7: 'Mirrored, rotated 90° CW', 8: 'Rotated 90° CCW'
  },
  ResolutionUnit: { 1: 'None', 2: 'inches', 3: 'cm' },
  FocalPlaneResolutionUnit: { 1: 'None', 2: 'inches', 3: 'cm', 4: 'mm', 5: 'µm' },
  YCbCrPositioning: { 1: 'Centered', 2: 'Co-sited' },
  ExposureProgram: {
    0: 'Not defined', 1: 'Manual', 2: 'Program AE', 3: 'Aperture priority', 4: 'Shutter priority',
    5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape', 9: 'Bulb'
  },
  MeteringMode: {
    0: 'Unknown', 1: 'Average', 2: 'Center-weighted average', 3: 'Spot', 4: 'Multi-spot',
    5: 'Multi-segment', 6: 'Partial', 255: 'Other'
  },
  LightSource: {
    0: 'Unknown', 1: 'Daylight', 2: 'Fluorescent', 3: 'Tungsten', 4: 'Flash', 9: 'Fine weather',
    10: 'Cloudy', 11: 'Shade', 12: 'Daylight fluorescent', 13: 'Day white fluorescent',
    14: 'Cool white fluorescent', 15: 'White fluorescent', 17: 'Standard light A', 18: 'Standard light B',
    19: 'Standard light C', 20: 'D55', 21: 'D65', 22: 'D75', 23: 'D50', 24: 'ISO studio tungsten', 255: 'Other'
  },
  ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 0xffff: 'Uncalibrated', 0xfffd: 'Wide Gamut RGB', 0xfffe: 'ICC Profile' },
  SensingMethod: {
    1: 'Not defined', 2: 'One-chip color area', 3: 'Two-chip color area', 4: 'Three-chip color area',
    5: 'Color sequential area', 7: 'Trilinear', 8: 'Color sequential linear'
  },
  CustomRendered: { 0: 'Normal', 1: 'Custom', 2: 'HDR (no original saved)', 3: 'HDR (original saved)', 4: 'Original (for HDR)', 6: 'Panorama', 7: 'Portrait HDR', 8: 'Portrait' },
  ExposureMode: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' },
  WhiteBalance: { 0: 'Auto', 1: 'Manual' },
  SceneCaptureType: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night', 4: 'Other' },
  GainControl: { 0: 'None', 1: 'Low gain up', 2: 'High gain up', 3: 'Low gain down', 4: 'High gain down' },
  Contrast: { 0: 'Normal', 1: 'Low', 2: 'High' },
  Saturation: { 0: 'Normal', 1: 'Low', 2: 'High' },
  Sharpness: { 0: 'Normal', 1: 'Soft', 2: 'Hard' },
  SubjectDistanceRange: { 0: 'Unknown', 1: 'Macro', 2: 'Close', 3: 'Distant' },
  SensitivityType: {
    0: 'Unknown', 1: 'Standard output sensitivity', 2: 'Recommended exposure index', 3: 'ISO speed',
    4: 'SOS and REI', 5: 'SOS and ISO speed', 6: 'REI and ISO speed', 7: 'SOS, REI and ISO speed'
  },
  FileSource: { 1: 'Film scanner', 2: 'Reflection print scanner', 3: 'Digital camera' },
  SceneType: { 1: 'Directly photographed' },
  CompositeImage: { 0: 'Unknown', 1: 'Not a composite', 2: 'General composite', 3: 'Composite captured when shooting' },
  GPSAltitudeRef: { 0: 'Above sea level', 1: 'Below sea level' },
  GPSDifferential: { 0: 'No correction', 1: 'Differential corrected' }
}
ENUMS.CalibrationIlluminant1 = ENUMS.LightSource
ENUMS.CalibrationIlluminant2 = ENUMS.LightSource

export const ORIENTATION_NAMES = ENUMS.Orientation

export function flashText(v: number): string {
  const parts = [v & 1 ? 'Fired' : 'Did not fire']
  const mode = (v >> 3) & 3
  if (mode === 1) parts.push('compulsory')
  else if (mode === 2) parts.push('off')
  else if (mode === 3) parts.push('auto')
  if (v & 0x40) parts.push('red-eye reduction')
  if (v & 0x20) parts.push('no flash function')
  return parts.join(', ')
}

const trimNum = (n: number, digits = 2) => {
  if (!Number.isFinite(n)) return String(n)
  return Number(n.toFixed(digits)).toString()
}

export function exposureText(seconds: number): string {
  if (!(seconds > 0)) return String(seconds)
  if (seconds >= 1) return `${trimNum(seconds, 1)} s`
  const inv = 1 / seconds
  return `1/${inv >= 10 ? Math.round(inv) : trimNum(inv, 1)} s`
}

function versionText(bytes: Uint8Array): string {
  const s = String.fromCharCode(...bytes.subarray(0, 4))
  if (/^\d{4}$/.test(s)) return `${Number(s.slice(0, 2))}.${s.slice(2).replace(/0$/, '') || '0'}`
  return Array.from(bytes.subarray(0, 4)).join('.')
}

function userComment(bytes: Uint8Array): string {
  if (bytes.length < 8) return ''
  const code = String.fromCharCode(...bytes.subarray(0, 8)).replace(/\0+$/, '')
  const body = bytes.subarray(8)
  if (code === 'UNICODE') {
    const little = body.length > 1 && body[1] === 0 && body[0] !== 0
    return new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(body).replace(/\0+$/, '').trim()
  }
  return new TextDecoder().decode(body).replace(/\0+$/, '').trim()
}

/** XP* tags hold UTF-16LE text in BYTE arrays. */
function xpText(bytes: Uint8Array): string {
  return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '').trim()
}

function dms(values: number[], ref: string): string {
  if (values.length < 3) return ''
  const [d, m, s] = values
  return `${Math.floor(d)}° ${Math.floor(m)}′ ${trimNum(s, 2)}″ ${ref}`.trim()
}

function decimalDegrees(values: number[], ref: string): number | null {
  if (values.length < 3 || values.some((v) => !Number.isFinite(v))) return null
  const deg = values[0] + values[1] / 60 + values[2] / 3600
  return ref === 'S' || ref === 'W' ? -deg : deg
}

/** One tag's value as text. */
function formatValue(tiff: Tiff, name: string, e: IfdEntry): string {
  const raw = () => tiff.raw(e, 256)
  switch (name) {
    case 'ExposureTime':
      return exposureText(tiff.value(e))
    case 'FNumber':
    case 'ApertureValue':
    case 'MaxApertureValue': {
      const v = tiff.value(e)
      const f = name === 'FNumber' ? v : Math.SQRT2 ** v
      return `f/${trimNum(f, 1)}`
    }
    case 'ShutterSpeedValue':
      return exposureText(2 ** -tiff.value(e))
    case 'FocalLength':
      return `${trimNum(tiff.value(e), 1)} mm`
    case 'FocalLengthIn35mmFormat':
      return `${tiff.value(e)} mm`
    case 'ExposureCompensation': {
      const v = tiff.value(e)
      return `${v > 0 ? '+' : ''}${trimNum(v, 2)} EV`
    }
    case 'SubjectDistance':
      return `${trimNum(tiff.value(e), 2)} m`
    case 'Flash':
      return flashText(tiff.value(e))
    case 'ExifVersion':
    case 'FlashpixVersion':
      return versionText(raw())
    case 'UserComment':
      return userComment(tiff.raw(e, 4096))
    case 'MakerNote':
      return `${e.count.toLocaleString('en')} bytes`
    case 'ComponentsConfiguration':
      return Array.from(raw().subarray(0, 4), (c) => ['-', 'Y', 'Cb', 'Cr', 'R', 'G', 'B'][c] ?? '?').join(' ')
    case 'CFAPattern':
      return `${e.count} bytes`
    case 'FileSource':
    case 'SceneType':
      return ENUMS[name][raw()[0]] ?? String(raw()[0])
    case 'LensInfo':
    case 'DNGLensInfo': {
      const [a, b, c, d] = tiff.values(e, 4)
      const focal = a === b ? `${trimNum(a, 1)} mm` : `${trimNum(a, 1)}–${trimNum(b, 1)} mm`
      const f = !c ? '' : c === d || !d ? ` f/${trimNum(c, 1)}` : ` f/${trimNum(c, 1)}–${trimNum(d, 1)}`
      return focal + f
    }
    case 'GPSVersionID':
    case 'DNGVersion':
    case 'DNGBackwardVersion':
      return tiff.values(e, 4).join('.')
    case 'GPSLatitude':
    case 'GPSLongitude':
    case 'GPSDestLatitude':
    case 'GPSDestLongitude':
      return dms(tiff.values(e, 3), '')
    case 'GPSTimeStamp': {
      const [h, m, s] = tiff.values(e, 3)
      const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')
      return `${pad(h)}:${pad(m)}:${pad(s)} UTC`
    }
    case 'GPSAltitude':
    case 'GPSHPositioningError':
      return `${trimNum(tiff.value(e), 1)} m`
    case 'GPSProcessingMethod':
    case 'GPSAreaInformation':
      return userComment(tiff.raw(e, 1024)) || new TextDecoder().decode(tiff.raw(e, 1024)).replace(/\0/g, '')
    case 'XPTitle':
    case 'XPComment':
    case 'XPAuthor':
    case 'XPKeywords':
    case 'XPSubject':
      return xpText(tiff.raw(e, 4096))
    case 'ExifImageWidth':
    case 'ExifImageHeight':
      return String(tiff.value(e))
  }
  if (ENUMS[name]) {
    const v = tiff.value(e)
    return ENUMS[name][v] ?? String(v)
  }
  return genericValue(tiff, e)
}

export function genericValue(tiff: Tiff, e: IfdEntry): string {
  if (e.type === 2) return tiff.string(e)
  if (e.type === 7 || e.type === 1) {
    const bytes = tiff.raw(e, 64)
    if (e.count <= 16) return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
    return `${e.count.toLocaleString('en')} bytes`
  }
  const values = tiff.values(e, 17)
  const shown = values.slice(0, 16).map((v) => trimNum(v, 4)).join(', ')
  return e.count > 16 ? `${shown}, … (${e.count})` : shown
}

/** Tag directories found from an IFD0. */
export interface ExifDirs {
  ifd0: Ifd | null
  exif: Ifd | null
  gps: Ifd | null
  interop: Ifd | null
}

export function exifDirs(tiff: Tiff, ifd0: Ifd | null): ExifDirs {
  const sub = (tag: number, from: Ifd | null): Ifd | null => {
    const e = from?.entries.get(tag)
    if (!e) return null
    const at = tiff.value(e)
    try {
      return at ? tiff.readIfd(at) : null
    } catch {
      return null
    }
  }
  const exif = sub(T.ExifIFD, ifd0)
  return { ifd0, exif, gps: sub(T.GPSIFD, ifd0), interop: sub(T.InteropIFD, exif) }
}

export interface ExifSummary {
  sections: InfoSection[]
  orientation: number
  make: string
  model: string
  /** The maker note's bytes, for vendor decoders. */
  makerNote: Uint8Array | null
  /** Where the maker note starts in the TIFF bytes (some vendors count offsets from there). */
  makerNoteAt: number
}

function list(tiff: Tiff, ifd: Ifd | null, names: Record<number, string>, onlyKnown: boolean): InfoItem[] {
  if (!ifd) return []
  const items: InfoItem[] = []
  for (const e of ifd.entries.values()) {
    const name = names[e.tag]
    if (!name && onlyKnown) continue
    let value: string
    try {
      value = name ? formatValue(tiff, name, e) : genericValue(tiff, e)
    } catch {
      continue
    }
    if (value === '') continue
    items.push({ key: name ?? `Tag ${hex(e.tag)}`, value: value.slice(0, 2000) })
  }
  return items
}

/** EXIF, camera and GPS sections from the IFDs of a TIFF-structured block. */
export function exifSummary(tiff: Tiff, dirs: ExifDirs, options: { imageTags: boolean } = { imageTags: true }): ExifSummary {
  const { ifd0, exif, gps } = dirs
  const get = (ifd: Ifd | null, tag: number) => ifd?.entries.get(tag)
  const str = (ifd: Ifd | null, tag: number) => {
    try {
      return tiff.string(get(ifd, tag))
    } catch {
      return ''
    }
  }
  const num = (ifd: Ifd | null, tag: number) => {
    const e = get(ifd, tag)
    try {
      return e ? tiff.value(e) : undefined
    } catch {
      return undefined
    }
  }

  const make = str(ifd0, 0x010f)
  const model = str(ifd0, 0x0110)
  const camera: InfoItem[] = []
  if (make || model) {
    const shown = model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? model : `${make} ${model}`.trim()
    camera.push({ key: 'camera', value: shown })
  }
  const lens = str(exif, 0xa434) || str(exif, 0xa433)
  if (lens) camera.push({ key: 'lens', value: lens })
  const parts: string[] = []
  const t = num(exif, 0x829a)
  if (t) parts.push(exposureText(t))
  const f = num(exif, 0x829d)
  if (f) parts.push(`f/${trimNum(f, 1)}`)
  const iso = num(exif, 0x8827)
  if (iso) parts.push(`ISO ${iso}`)
  const bias = num(exif, 0x9204)
  if (bias) parts.push(`${bias > 0 ? '+' : ''}${trimNum(bias, 2)} EV`)
  if (parts.length) camera.push({ key: 'exposure', value: parts.join(' · ') })
  const focal = num(exif, 0x920a)
  const focal35 = num(exif, 0xa405)
  if (focal) camera.push({ key: 'focalLength', value: `${trimNum(focal, 1)} mm${focal35 && focal35 !== Math.round(focal) ? ` (35 mm equivalent: ${focal35} mm)` : ''}` })
  const flash = num(exif, 0x9209)
  if (flash !== undefined) camera.push({ key: 'flash', value: flashText(flash) })
  // DateTime (0x0132) is when the file was changed; it stands in only for a camera's photo.
  const taken = str(exif, 0x9003) || (camera.length ? str(ifd0, 0x0132) : '')
  if (taken) {
    const offset = str(exif, 0x9011)
    camera.push({ key: 'taken', value: exifDate(taken) + (/^[+-]\d{2}:\d{2}$/.test(offset) ? ` ${offset}` : '') })
  }
  const serial = str(exif, 0xa431)
  if (serial) camera.push({ key: 'serial', value: serial })
  for (const [tag, key] of [[0x0131, 'software'], [0x013b, 'artist'], [0x8298, 'copyright'], [0x010e, 'description']] as const) {
    const v = str(ifd0, tag)
    if (v) camera.push({ key, value: v })
  }

  const sections: InfoSection[] = []
  if (camera.length) sections.push({ title: 'camera', items: camera })

  const gpsItems = gpsSection(tiff, gps)
  if (gpsItems.length) sections.push({ title: 'gps', items: gpsItems })

  const all = [
    ...(options.imageTags ? list(tiff, ifd0, IFD0_NAMES, true) : []),
    ...list(tiff, exif, EXIF_NAMES, false),
    ...list(tiff, gps, GPS_NAMES, false)
  ]
  if (all.length) sections.push({ title: 'exif', items: all, raw: true })

  const orientation = num(ifd0, T.Orientation) ?? 1
  const note = get(exif, 0x927c)
  return {
    sections,
    orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
    make,
    model,
    makerNote: note ? tiff.raw(note) : null,
    makerNoteAt: note?.at ?? 0
  }
}

function gpsSection(tiff: Tiff, gps: Ifd | null): InfoItem[] {
  if (!gps) return []
  const e = (tag: number) => gps.entries.get(tag)
  const ref = (tag: number) => {
    try {
      return tiff.string(e(tag)).slice(0, 1).toUpperCase()
    } catch {
      return ''
    }
  }
  const items: InfoItem[] = []
  try {
    const lat = tiff.values(e(2), 3)
    const lon = tiff.values(e(4), 3)
    const latRef = ref(1) || 'N'
    const lonRef = ref(3) || 'E'
    const la = decimalDegrees(lat, latRef)
    const lo = decimalDegrees(lon, lonRef)
    if (la !== null && lo !== null) {
      items.push({ key: 'position', value: `${la.toFixed(6)}, ${lo.toFixed(6)}`, mono: true })
      items.push({ key: 'latitude', value: dms(lat, latRef) })
      items.push({ key: 'longitude', value: dms(lon, lonRef) })
    }
    const alt = e(6)
    if (alt) {
      const below = tiff.value(e(5)) === 1
      items.push({ key: 'altitude', value: `${below ? '−' : ''}${trimNum(tiff.value(alt), 1)} m` })
    }
    const dir = e(17)
    if (dir) items.push({ key: 'direction', value: `${trimNum(tiff.value(dir), 1)}°${ref(16) === 'M' ? ' magnetic' : ''}` })
    const speed = e(13)
    if (speed) {
      const unit = { K: 'km/h', M: 'mph', N: 'knots' }[ref(12) || 'K'] ?? ''
      items.push({ key: 'speed', value: `${trimNum(tiff.value(speed), 1)} ${unit}` })
    }
    const date = tiff.string(e(29))
    const time = e(7) ? formatValue(tiff, 'GPSTimeStamp', e(7) as IfdEntry) : ''
    if (date || time) items.push({ key: 'gpsTime', value: `${date.replace(/:/g, '-')} ${time}`.trim() })
  } catch {
    // A damaged GPS block: the raw tags still show in the EXIF list.
  }
  return items
}

/** `2024:05:01 13:45:10` → `2024-05-01 13:45:10`. */
export function exifDate(s: string): string {
  return s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
}

/** EXIF from an `Exif\0\0`-prefixed or bare TIFF block (JPEG APP1, HEIF Exif item, PNG eXIf). */
export function exifFromBlock(block: Uint8Array): ExifSummary | null {
  let start = 0
  if (block.length >= 6 && block[0] === 0x45 && block[1] === 0x78 && block[2] === 0x69 && block[3] === 0x66) start = 6
  // Some writers put a few bytes before the header: find `II*\0` or `MM\0*` close to the start.
  if (!Tiff.is(block, start)) {
    let found = -1
    for (let i = 0; i < Math.min(block.length - 8, 64); i++) {
      if (Tiff.is(block, i)) {
        found = i
        break
      }
    }
    if (found < 0) return null
    start = found
  }
  try {
    const tiff = new Tiff(block.subarray(start))
    const ifd0 = tiff.readIfd(tiff.first)
    return exifSummary(tiff, exifDirs(tiff, ifd0))
  } catch {
    return null
  }
}
