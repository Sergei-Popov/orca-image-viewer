// The side list's rows: one image per position on the list axis (parts, layers, faces, mip
// levels), taken where the other axes stand for the current image.

import type { ImageDesc } from '../core/model'

/**
 * The images the side list shows, in order. `axis` is the list axis' index in `at` (−1: every
 * image). Images whose positions have another length than the rest are not on the axis, and then
 * nothing is listed. One pass over the images: files may hold thousands of them.
 */
export function listEntries(images: readonly ImageDesc[], axis: number, current: ImageDesc | null): ImageDesc[] {
  if (axis >= 0) {
    const length = images.length ? images[0].at.length : 0
    if (!images.every((img) => img.at.length === length)) return []
  }
  const where = current?.at
  const matches = (img: ImageDesc) => !where || img.at.every((v, k) => k === axis || v === where[k])
  const shown = new Map<number, { img: ImageDesc; matches: boolean }>()
  for (const img of images) {
    const key = axis >= 0 ? img.at[axis] : img.id
    const prev = shown.get(key)
    if (prev?.matches) continue
    const ok = matches(img)
    if (!prev || ok) shown.set(key, { img, matches: ok })
  }
  return [...shown.values()].map((e) => e.img)
}
