// TIFF predictors, undone in place on decompressed rows. Predictor 2 adds each sample to the one a
// pixel before it (8-, 16-, 32- and 64-bit integers); predictor 3 (floating point) differences the
// bytes of a row after splitting every value into byte planes, most significant first.

import { unsupportedFeature } from '../core/errors'

export function undoHorizontal(buf: Uint8Array, rows: number, rowBytes: number, width: number, spp: number, bps: number, little: boolean): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = width * spp
  for (let y = 0; y < rows; y++) {
    const row = y * rowBytes
    if (row + rowBytes > buf.length) return
    if (bps === 8) {
      for (let i = spp; i < count; i++) buf[row + i] = (buf[row + i] + buf[row + i - spp]) & 255
    } else if (bps === 16) {
      for (let i = spp; i < count; i++) {
        const at = row + i * 2
        view.setUint16(at, view.getUint16(at, little) + view.getUint16(at - spp * 2, little), little)
      }
    } else if (bps === 32) {
      for (let i = spp; i < count; i++) {
        const at = row + i * 4
        view.setUint32(at, (view.getUint32(at, little) + view.getUint32(at - spp * 4, little)) >>> 0, little)
      }
    } else if (bps === 64) {
      for (let i = spp; i < count; i++) {
        const at = row + i * 8
        view.setBigUint64(at, BigInt.asUintN(64, view.getBigUint64(at, little) + view.getBigUint64(at - spp * 8, little)), little)
      }
    } else {
      throw unsupportedFeature(`horizontal predictor with ${bps}-bit samples`)
    }
  }
}

/** Undoes predictor 3; the values come out big-endian, whatever the file's byte order. */
export function undoFloatingPoint(buf: Uint8Array, rows: number, rowBytes: number, width: number, spp: number, bps: number): void {
  const bytes = bps / 8
  const count = width * spp
  const len = count * bytes
  const tmp = new Uint8Array(len)
  for (let y = 0; y < rows; y++) {
    const row = y * rowBytes
    if (row + len > buf.length) return
    for (let i = spp; i < len; i++) buf[row + i] = (buf[row + i] + buf[row + i - spp]) & 255
    tmp.set(buf.subarray(row, row + len))
    for (let i = 0; i < count; i++) {
      for (let b = 0; b < bytes; b++) buf[row + i * bytes + b] = tmp[b * count + i]
    }
  }
}

/** Predictor 2 forwards, for test fixtures (8- and 16-bit). */
export function applyHorizontal(buf: Uint8Array, rows: number, rowBytes: number, width: number, spp: number, bps: number, little: boolean): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = width * spp
  for (let y = 0; y < rows; y++) {
    const row = y * rowBytes
    for (let i = count - 1; i >= spp; i--) {
      if (bps === 8) buf[row + i] = (buf[row + i] - buf[row + i - spp]) & 255
      else {
        const at = row + i * 2
        view.setUint16(at, (view.getUint16(at, little) - view.getUint16(at - spp * 2, little)) & 0xffff, little)
      }
    }
  }
}

/** Predictor 3 forwards from big-endian values, for test fixtures. */
export function applyFloatingPoint(buf: Uint8Array, rows: number, rowBytes: number, width: number, spp: number, bps: number): void {
  const bytes = bps / 8
  const count = width * spp
  const len = count * bytes
  for (let y = 0; y < rows; y++) {
    const row = y * rowBytes
    const tmp = new Uint8Array(len)
    for (let i = 0; i < count; i++) for (let b = 0; b < bytes; b++) tmp[b * count + i] = buf[row + i * bytes + b]
    for (let i = len - 1; i >= spp; i--) tmp[i] = (tmp[i] - tmp[i - spp]) & 255
    buf.set(tmp, row)
  }
}
