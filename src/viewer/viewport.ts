// The image on screen: a canvas the size of the stage that draws a small overview of the image when
// zoomed out and full-resolution tiles, rendered on demand, when zoomed in. Pans with a drag, the
// scroll wheel or a trackpad; zooms with ⌘/Ctrl + wheel, a pinch, double-click and the keys the view
// passes in. A checkerboard shows under transparent pixels and a pixel grid at high zoom.

import type { Raster } from '../core/model'
import { overview, renderRegion, type Tone } from './tone'

const OVERVIEW_SIDE = 2048
const TILE = 512
const MAX_TILES = 96
const MIN_SCALE = 1 / 64
const MAX_SCALE = 128

interface Tile {
  canvas: HTMLCanvasElement
  used: number
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

export interface ViewportEvents {
  hover(x: number, y: number, inside: boolean): void
  zoom(scale: number, fit: boolean): void
}

export class Viewport {
  readonly el: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private raster: Raster | null = null
  private tone: Tone | null = null
  private over: { raster: Raster; scale: number; canvas: HTMLCanvasElement } | null = null
  private tiles = new Map<string, Tile>()
  private queue: string[] = []
  private frame = 0
  private clock = 0
  private width = 0
  private height = 0
  private dpr = 1
  /** CSS pixels per image pixel. */
  scale = 1
  private cx = 0
  private cy = 0
  fitted = true
  private drag: { x: number; y: number; cx: number; cy: number; id: number } | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private pinch: { distance: number; scale: number } | null = null
  private lastHover: { x: number; y: number } | null = null
  private checker: CanvasPattern | null = null
  private checkerKey = ''

  constructor(private readonly events: ViewportEvents) {
    this.el = document.createElement('div')
    this.el.className = 'iv-stage'
    this.el.tabIndex = 0
    this.canvas = makeCanvas(1, 1)
    this.canvas.className = 'iv-canvas'
    this.el.append(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('no 2D canvas')
    this.ctx = ctx
    new ResizeObserver(() => this.resize()).observe(this.el)
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.el.addEventListener('pointerdown', (e) => this.onDown(e))
    this.el.addEventListener('pointermove', (e) => this.onMove(e))
    this.el.addEventListener('pointerup', (e) => this.onUp(e))
    this.el.addEventListener('pointercancel', (e) => this.onUp(e))
    this.el.addEventListener('pointerleave', () => {
      this.lastHover = null
      this.events.hover(0, 0, false)
    })
    this.el.addEventListener('dblclick', (e) => {
      const p = this.local(e)
      if (this.fitted || Math.abs(this.scale - this.fitScale()) < 1e-6) this.zoomTo(1, p.x, p.y)
      else this.fit()
    })
  }

  get image(): Raster | null {
    return this.raster
  }

  /** Shows a raster; `keepView` keeps zoom and position when the size matches (a new page). */
  setImage(r: Raster, tone: Tone, keepView = false): void {
    const same = keepView && this.raster && this.raster.width === r.width && this.raster.height === r.height
    this.raster = r
    this.tone = tone
    this.dropTiles()
    this.buildOverview()
    if (!same) {
      this.cx = r.width / 2
      this.cy = r.height / 2
      this.fitted = true
    }
    if (this.fitted) this.scale = this.fitScale()
    this.events.zoom(this.scale, this.fitted)
    this.schedule()
  }

  clear(): void {
    this.raster = null
    this.over = null
    this.dropTiles()
    this.schedule()
  }

  setTone(tone: Tone): void {
    this.tone = tone
    this.dropTiles()
    if (this.over && this.raster) this.paintOverview()
    this.schedule()
  }

  fit(): void {
    if (!this.raster) return
    this.fitted = true
    this.cx = this.raster.width / 2
    this.cy = this.raster.height / 2
    this.scale = this.fitScale()
    this.events.zoom(this.scale, true)
    this.schedule()
  }

  /** Zooms to `scale`, keeping the image point under (`ax`, `ay`) in place (stage centre by default). */
  zoomTo(scale: number, ax = this.width / 2, ay = this.height / 2): void {
    if (!this.raster) return
    const next = Math.min(MAX_SCALE, Math.max(Math.min(MIN_SCALE, this.fitScale()), scale))
    const ix = this.cx + (ax - this.width / 2) / this.scale
    const iy = this.cy + (ay - this.height / 2) / this.scale
    this.scale = next
    this.cx = ix - (ax - this.width / 2) / next
    this.cy = iy - (ay - this.height / 2) / next
    this.fitted = false
    this.clampCentre()
    this.events.zoom(this.scale, false)
    this.schedule()
  }

  /** One step up or down a ladder of zoom levels. */
  zoomStep(direction: 1 | -1): void {
    const ladder = [1 / 32, 1 / 16, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128]
    const s = this.scale
    const next = direction > 0 ? ladder.find((v) => v > s * 1.001) : [...ladder].reverse().find((v) => v < s / 1.001)
    this.zoomTo(next ?? s)
  }

  pan(dx: number, dy: number): void {
    if (!this.raster) return
    this.cx += dx / this.scale
    this.cy += dy / this.scale
    this.fitted = false
    this.clampCentre()
    this.schedule()
  }

  /** The scale that fits the image in the stage; small images grow by whole steps, to stay crisp. */
  fitScale(): number {
    if (!this.raster || !this.width || !this.height) return 1
    const pad = 24
    const s = Math.min((this.width - pad) / this.raster.width, (this.height - pad) / this.raster.height)
    if (s >= 1) {
      const big = Math.max(this.raster.width, this.raster.height) >= 256
      return big ? 1 : Math.max(1, Math.min(8, Math.floor(s)))
    }
    return Math.max(MIN_SCALE / 4, s)
  }

  private clampCentre(): void {
    if (!this.raster) return
    this.cx = Math.min(this.raster.width, Math.max(0, this.cx))
    this.cy = Math.min(this.raster.height, Math.max(0, this.cy))
  }

  private resize(): void {
    const rect = this.el.getBoundingClientRect()
    this.width = Math.max(1, Math.round(rect.width))
    this.height = Math.max(1, Math.round(rect.height))
    this.dpr = Math.max(1, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this.width * this.dpr)
    this.canvas.height = Math.round(this.height * this.dpr)
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`
    if (this.fitted && this.raster) {
      this.scale = this.fitScale()
      this.events.zoom(this.scale, true)
    }
    this.draw()
  }

  private buildOverview(): void {
    const r = this.raster
    if (!r) return
    const small = Math.max(r.width, r.height) <= OVERVIEW_SIDE
    const o = small ? { raster: r, scale: 1 } : overview(r, OVERVIEW_SIDE)
    this.over = { ...o, canvas: makeCanvas(o.raster.width, o.raster.height) }
    this.paintOverview()
  }

  private paintOverview(): void {
    const o = this.over
    if (!o || !this.tone) return
    const ctx = o.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    const img = ctx.createImageData(o.raster.width, o.raster.height)
    renderRegion(o.raster, this.tone, 0, 0, o.raster.width, o.raster.height, img.data)
    ctx.putImageData(img, 0, 0)
  }

  /** The overview canvas as it is drawn now, for histograms. */
  overviewPixels(): ImageData | null {
    const o = this.over
    const ctx = o?.canvas.getContext('2d', { willReadFrequently: true })
    return o && ctx ? ctx.getImageData(0, 0, o.raster.width, o.raster.height) : null
  }

  private dropTiles(): void {
    this.tiles.clear()
    this.queue = []
  }

  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  private checkerPattern(): CanvasPattern | null {
    const style = getComputedStyle(this.el)
    const a = style.getPropertyValue('--check-a').trim() || '#fff'
    const b = style.getPropertyValue('--check-b').trim() || '#ddd'
    const key = `${a}|${b}|${this.dpr}`
    if (this.checker && key === this.checkerKey) return this.checker
    const size = Math.round(8 * this.dpr)
    const c = makeCanvas(size * 2, size * 2)
    const g = c.getContext('2d')
    if (!g) return null
    g.fillStyle = a
    g.fillRect(0, 0, size * 2, size * 2)
    g.fillStyle = b
    g.fillRect(0, 0, size, size)
    g.fillRect(size, size, size, size)
    this.checker = this.ctx.createPattern(c, 'repeat')
    this.checkerKey = key
    return this.checker
  }

  private draw(): void {
    const ctx = this.ctx
    const dpr = this.dpr
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const r = this.raster
    const o = this.over
    if (!r || !o) return
    const s = this.scale * dpr
    // Image rectangle in device pixels.
    const left = (this.width / 2 - this.cx * this.scale) * dpr
    const top = (this.height / 2 - this.cy * this.scale) * dpr
    const w = r.width * s
    const h = r.height * s
    const vx0 = Math.max(0, left)
    const vy0 = Math.max(0, top)
    const vx1 = Math.min(this.canvas.width, left + w)
    const vy1 = Math.min(this.canvas.height, top + h)
    if (vx1 <= vx0 || vy1 <= vy0) return
    if (r.alpha || this.tone?.channel === 'a') {
      const pattern = this.checkerPattern()
      if (pattern && r.alpha && this.tone?.channel !== 'a' && this.tone?.channel !== 'r' && this.tone?.channel !== 'g' && this.tone?.channel !== 'b') {
        ctx.fillStyle = pattern
        ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0)
      }
    }
    ctx.imageSmoothingEnabled = s < 1
    ctx.imageSmoothingQuality = 'high'
    // The overview covers the whole image; tiles replace it where it would be enlarged.
    ctx.drawImage(o.canvas, left, top, w, h)
    const needTiles = o.scale < 1 && s > o.scale * 1.05
    if (needTiles) this.drawTiles(left, top, s, vx0, vy0, vx1, vy1)
    if (s >= 20) this.drawGrid(left, top, s, vx0, vy0, vx1, vy1)
  }

  private drawTiles(left: number, top: number, s: number, vx0: number, vy0: number, vx1: number, vy1: number): void {
    const r = this.raster
    if (!r || !this.tone) return
    const ix0 = Math.max(0, Math.floor((vx0 - left) / s))
    const iy0 = Math.max(0, Math.floor((vy0 - top) / s))
    const ix1 = Math.min(r.width, Math.ceil((vx1 - left) / s))
    const iy1 = Math.min(r.height, Math.ceil((vy1 - top) / s))
    const missing: string[] = []
    const now = ++this.clock
    for (let ty = Math.floor(iy0 / TILE); ty * TILE < iy1; ty++) {
      for (let tx = Math.floor(ix0 / TILE); tx * TILE < ix1; tx++) {
        const key = `${tx},${ty}`
        const tile = this.tiles.get(key)
        if (!tile) {
          missing.push(key)
          continue
        }
        tile.used = now
        const x = tx * TILE
        const y = ty * TILE
        this.ctx.drawImage(tile.canvas, left + x * s, top + y * s, tile.canvas.width * s, tile.canvas.height * s)
      }
    }
    if (missing.length) {
      this.queue = missing
      setTimeout(() => this.renderQueued(), 0)
    }
  }

  private renderQueued(): void {
    const r = this.raster
    const tone = this.tone
    if (!r || !tone || !this.queue.length) return
    const start = performance.now()
    while (this.queue.length && performance.now() - start < 24) {
      const key = this.queue.shift() as string
      if (this.tiles.has(key)) continue
      const [tx, ty] = key.split(',').map(Number)
      const x = tx * TILE
      const y = ty * TILE
      const w = Math.min(TILE, r.width - x)
      const h = Math.min(TILE, r.height - y)
      const canvas = makeCanvas(w, h)
      const g = canvas.getContext('2d')
      if (!g) continue
      const img = g.createImageData(w, h)
      renderRegion(r, tone, x, y, w, h, img.data)
      g.putImageData(img, 0, 0)
      this.tiles.set(key, { canvas, used: this.clock })
    }
    if (this.tiles.size > MAX_TILES) {
      const old = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used)
      for (const [key] of old.slice(0, this.tiles.size - MAX_TILES)) this.tiles.delete(key)
    }
    this.schedule()
  }

  private drawGrid(left: number, top: number, s: number, vx0: number, vy0: number, vx1: number, vy1: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = 'rgba(128,128,128,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    const x0 = Math.ceil((vx0 - left) / s)
    const x1 = Math.floor((vx1 - left) / s)
    for (let x = x0; x <= x1; x++) {
      const px = Math.round(left + x * s) + 0.5
      ctx.moveTo(px, vy0)
      ctx.lineTo(px, vy1)
    }
    const y0 = Math.ceil((vy0 - top) / s)
    const y1 = Math.floor((vy1 - top) / s)
    for (let y = y0; y <= y1; y++) {
      const py = Math.round(top + y * s) + 0.5
      ctx.moveTo(vx0, py)
      ctx.lineTo(vx1, py)
    }
    ctx.stroke()
    ctx.restore()
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** The image pixel under a stage point. */
  pixelAt(x: number, y: number): { x: number; y: number; inside: boolean } {
    const ix = Math.floor(this.cx + (x - this.width / 2) / this.scale)
    const iy = Math.floor(this.cy + (y - this.height / 2) / this.scale)
    const r = this.raster
    return { x: ix, y: iy, inside: !!r && ix >= 0 && iy >= 0 && ix < r.width && iy < r.height }
  }

  /** Re-reports the pixel under the pointer (after the image or tone changed). */
  refreshHover(): void {
    if (!this.lastHover) return
    const p = this.pixelAt(this.lastHover.x, this.lastHover.y)
    this.events.hover(p.x, p.y, p.inside)
  }

  private onWheel(e: WheelEvent): void {
    if (!this.raster) return
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1
    const p = this.local(e)
    if (e.ctrlKey || e.metaKey) {
      // Pinch on a trackpad arrives as a wheel with ctrlKey and small deltas.
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002))
      this.zoomTo(this.scale * factor, p.x, p.y)
    } else {
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit
      const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit
      this.pan(dx, dy)
    }
  }

  private onDown(e: PointerEvent): void {
    if (!this.raster || (e.pointerType === 'mouse' && e.button !== 0)) return
    this.el.focus({ preventScroll: true })
    this.el.setPointerCapture(e.pointerId)
    const p = this.local(e)
    this.pointers.set(e.pointerId, p)
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale }
      this.drag = null
    } else {
      this.drag = { x: p.x, y: p.y, cx: this.cx, cy: this.cy, id: e.pointerId }
      this.el.classList.add('iv-grabbing')
    }
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e)
    this.lastHover = p
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p)
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (this.pinch.distance > 0) this.zoomTo((this.pinch.scale * d) / this.pinch.distance, (a.x + b.x) / 2, (a.y + b.y) / 2)
    } else if (this.drag && this.drag.id === e.pointerId) {
      this.cx = this.drag.cx - (p.x - this.drag.x) / this.scale
      this.cy = this.drag.cy - (p.y - this.drag.y) / this.scale
      this.fitted = false
      this.clampCentre()
      this.schedule()
    }
    const px = this.pixelAt(p.x, p.y)
    this.events.hover(px.x, px.y, px.inside)
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId)
    if (this.pointers.size < 2) this.pinch = null
    if (this.drag?.id === e.pointerId) this.drag = null
    this.el.classList.remove('iv-grabbing')
  }
}
