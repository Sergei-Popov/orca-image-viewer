// The editor's UI: a toolbar (pickers for pages, mips, faces and sizes; channel; exposure and tone
// controls; zoom; Save as PNG), the image stage, a side pane with the file's details, its layers or
// its images as thumbnails, and a status bar with the pixel under the pointer.

import { DecoderClient } from '../core/client'
import { ImageError } from '../core/errors'
import type { DocDesc, ImageDesc, InfoSection, LayerDesc, Raster } from '../core/model'
import { encodePng } from '../core/png'
import type { Thumbnail } from '../core/protocol'
import { append, h, svg } from '../dom'
import { fill, formatSize, imageText, infoValue, label, type Strings, valueText } from '../i18n'
import { icon, type IconName } from '../icons'
import {
  autoTone,
  type ChannelView,
  formatFloat,
  histogram,
  initialTone,
  isHighRange,
  pixelValues,
  renderRegion,
  type Tone,
  type ToneMap
} from './tone'
import { Viewport } from './viewport'

type SaveAs = (options: { suggestedName?: string; mimeType?: string; data: ArrayBuffer }) => Promise<{ status: 'saved' | 'cancelled' }>

export interface ViewOptions {
  strings: Strings
  locale: string
  saveAs?: SaveAs
}

const SAVE_LIMIT = 64 * 1024 * 1024
const THUMB = 88

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be off in a frame; the preference just does not stick.
  }
}

export function describeError(error: unknown, t: Strings): string {
  if (error instanceof ImageError) {
    const template = (t.errors as Record<string, string>)[error.code] ?? t.errors['decode-failed']
    const detail = error.detail || (error.code === 'damaged' ? '…' : '')
    return fill(template, { detail }).replace(' ()', '').replace(' (…)', '')
  }
  return fill(t.errors['decode-failed'], { detail: error instanceof Error ? error.message : String(error) })
}

/** Layer kinds as shown; the values table translates them. */
const LAYER_KINDS: Record<LayerDesc['kind'], string> = { pixel: 'Pixels', group: 'Group', text: 'Text', adjustment: 'Adjustment', smart: 'Smart object', fill: 'Fill', empty: 'Empty' }

type Mode = { kind: 'image' } | { kind: 'layers' } | { kind: 'layer'; layer: number }

export class ImageView {
  readonly root: HTMLDivElement
  private readonly t: Strings
  private readonly locale: string
  private readonly saveAs: SaveAs | undefined
  private client: DecoderClient | null = null
  private desc: DocDesc | null = null
  private image: ImageDesc | null = null
  private raster: Raster | null = null
  private tone: Tone | null = null
  private mode: Mode = { kind: 'image' }
  private visible: boolean[] = []
  private generation = 0
  private decodeToken = 0
  private tab: 'info' | 'layers' | 'list' = 'info'
  private sideOpen = storageGet('image-viewer.side') !== '0'
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private histTimer: ReturnType<typeof setTimeout> | undefined
  private thumbObserver: IntersectionObserver | null = null
  private readonly mac = /Mac|iPhone|iPad/.test(navigator.platform)

  private readonly app: HTMLDivElement
  private readonly bar: HTMLDivElement
  private readonly badge: HTMLSpanElement
  private readonly summary: HTMLSpanElement
  private readonly pickers: HTMLDivElement
  private readonly channelGroup: HTMLDivElement
  private readonly toneGroup: HTMLDivElement
  private readonly zoomText: HTMLButtonElement
  private readonly saveButton: HTMLButtonElement
  private readonly copyButton: HTMLButtonElement
  private readonly sideButton: HTMLButtonElement
  private readonly notice: HTMLDivElement
  private readonly main: HTMLDivElement
  private readonly viewport: Viewport
  private readonly overlay: HTMLDivElement
  private readonly side: HTMLDivElement
  private readonly tabs: HTMLDivElement
  private readonly pane: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly toast: HTMLDivElement

  constructor(options: ViewOptions) {
    const t = (this.t = options.strings)
    this.locale = options.locale
    this.saveAs = options.saveAs
    this.root = h('div', { className: 'iv-root' })
    this.badge = h('span', { className: 'iv-badge' })
    this.summary = h('span', { className: 'iv-summary' })
    this.pickers = h('div', { className: 'iv-group' })
    this.channelGroup = h('div', { className: 'iv-group' })
    this.toneGroup = h('div', { className: 'iv-group' })
    this.zoomText = h('button', { className: 'iv-btn iv-zoom', type: 'button', title: t.fitHint }, '100%')
    this.zoomText.addEventListener('click', () => (this.viewport.fitted ? this.viewport.zoomTo(1) : this.viewport.fit()))
    const zoomOut = this.iconButton('zoomOut', t.zoomOut, () => this.viewport.zoomStep(-1))
    const zoomIn = this.iconButton('zoomIn', t.zoomIn, () => this.viewport.zoomStep(1))
    const fitButton = this.textButton(t.fit, t.fitHint, () => this.viewport.fit())
    const actual = this.textButton(t.actual, t.actualHint, () => this.viewport.zoomTo(1))
    this.saveButton = this.textButton(t.save, t.saveHint, () => void this.save(), 'save')
    this.saveButton.hidden = !this.saveAs
    this.copyButton = this.iconButton('copy', t.copyHint, () => void this.copy())
    this.copyButton.hidden = typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write
    this.sideButton = this.iconButton('panel', t.detailsHint, () => this.toggleSide())
    this.sideButton.setAttribute('aria-pressed', String(this.sideOpen))
    this.bar = h(
      'div',
      { className: 'iv-bar', role: 'toolbar' },
      this.badge,
      this.summary,
      this.pickers,
      this.channelGroup,
      this.toneGroup,
      h('div', { className: 'iv-spacer' }),
      h('div', { className: 'iv-group' }, zoomOut, this.zoomText, zoomIn, fitButton, actual),
      h('div', { className: 'iv-group' }, this.saveButton, this.copyButton, this.sideButton)
    )
    this.notice = h('div', { className: 'iv-notice', hidden: true })
    this.viewport = new Viewport({
      hover: (x, y, inside) => this.showPixel(x, y, inside),
      zoom: (scale, fit) => {
        this.zoomText.textContent = `${scale >= 10 ? Math.round(scale * 100) : Number((scale * 100).toFixed(scale < 0.1 ? 1 : 0))}%`
        this.zoomText.setAttribute('aria-pressed', String(fit))
      }
    })
    this.overlay = h('div', { className: 'iv-overlay', hidden: true })
    this.viewport.el.append(this.overlay)
    this.tabs = h('div', { className: 'iv-tabs', role: 'tablist' })
    this.pane = h('div', { className: 'iv-pane' })
    this.side = h('div', { className: 'iv-side' }, this.tabs, this.pane)
    const split = h('div', { className: 'iv-split', role: 'separator', 'aria-orientation': 'vertical' })
    this.main = h('div', { className: 'iv-main' }, this.viewport.el, split, this.side)
    this.main.classList.toggle('iv-noside', !this.sideOpen)
    const width = Number(storageGet('image-viewer.sideWidth'))
    if (width >= 220 && width <= 900) this.main.style.setProperty('--side', `${width}px`)
    this.status = h('div', { className: 'iv-status' })
    this.toast = h('div', { className: 'iv-toast', role: 'status' })
    this.app = h('div', { className: 'iv-app' }, this.bar, this.notice, this.main, this.status, this.toast)
    this.initSplit(split)
    document.addEventListener('keydown', (e) => this.onKey(e))
  }

  // ---------------------------------------------------------------- states

  showLoading(text = this.t.loading): void {
    this.root.replaceChildren(h('div', { className: 'iv-center' }, h('div', { className: 'iv-spinner' }), h('p', {}, text)))
  }

  showError(title: string, message: string): void {
    this.root.replaceChildren(
      h('div', { className: 'iv-center', role: 'alert' }, svg(icon('broken')), h('h2', {}, title), h('p', {}, message))
    )
  }

  /** Opens new file bytes; earlier documents are dropped. */
  async open(bytes: ArrayBuffer, fileType: string | undefined): Promise<void> {
    const generation = ++this.generation
    this.client?.dispose()
    const client = new DecoderClient()
    this.client = client
    let desc: DocDesc
    try {
      desc = await client.open(bytes, fileType)
    } catch (error) {
      if (generation !== this.generation) return
      console.warn('[image-viewer] cannot open the image', error)
      this.showError(this.t.errorTitle, describeError(error, this.t))
      return
    }
    if (generation !== this.generation) return
    this.desc = desc
    this.raster = null
    this.image = null
    this.mode = { kind: 'image' }
    this.visible = (desc.layers ?? []).map((l) => l.visible)
    if (this.tab !== 'info' && !(this.tab === 'layers' && desc.layers?.length) && !(this.tab === 'list' && desc.list)) this.tab = 'info'
    this.root.replaceChildren(this.app)
    this.badge.textContent = desc.format
    this.buildPickers()
    this.buildTabs()
    const first = desc.images.find((i) => i.id === desc.primary) ?? desc.images[0]
    if (!first) {
      this.showError(this.t.errorTitle, this.t.errors['unknown-format'])
      return
    }
    await this.select(first)
  }

  // ---------------------------------------------------------------- selection and decoding

  private async select(image: ImageDesc, mode: Mode = { kind: 'image' }, keepView = false): Promise<void> {
    const desc = this.desc
    const client = this.client
    if (!desc || !client) return
    this.image = image
    this.mode = mode
    this.syncPickers()
    this.syncLists()
    const token = ++this.decodeToken
    if (image.unsupported && mode.kind === 'image') {
      this.raster = null
      this.viewport.clear()
      this.showOverlay(fill(this.t.unsupportedImage, { detail: imageText(this.t, image.unsupported) }), false)
      this.updateSummary()
      this.renderInfo()
      this.buildChannels()
      this.buildTone()
      return
    }
    this.showOverlay(this.t.decoding, true)
    let r: Raster
    try {
      if (mode.kind === 'layers') r = await client.composite(this.visible)
      else if (mode.kind === 'layer') r = await client.decode(this.layerImage(mode.layer))
      else r = await client.decode(image.id)
    } catch (error) {
      if (token !== this.decodeToken) return
      console.warn('[image-viewer] cannot decode', error)
      this.raster = null
      this.viewport.clear()
      this.showOverlay(describeError(error, this.t), false)
      this.renderInfo()
      return
    }
    if (token !== this.decodeToken) return
    this.hideOverlay()
    const sameKind = this.raster && this.raster.transfer === r.transfer && this.raster.kind === r.kind && this.raster.channels === r.channels
    this.raster = r
    if (!this.tone || !sameKind) this.tone = initialTone(r)
    else if (r.transfer === 'data') this.tone = { ...initialTone(r), channel: this.tone.channel }
    if (!this.channelOptions(r).includes(this.tone.channel)) this.tone = { ...this.tone, channel: 'rgb' }
    this.viewport.setImage(r, this.tone, keepView)
    this.buildChannels()
    this.buildTone()
    this.updateSummary()
    this.updateNotice()
    this.renderInfo()
    this.viewport.refreshHover()
    this.scheduleHistogram()
  }

  private layerImage(layer: number): number {
    return this.desc?.layers?.find((l) => l.id === layer)?.image ?? -1
  }

  // ---------------------------------------------------------------- toolbar

  private iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
    const b = h('button', { className: 'iv-btn iv-square', type: 'button', title, 'aria-label': title }, svg(icon(name)))
    b.addEventListener('click', onClick)
    return b
  }

  private textButton(text: string, title: string, onClick: () => void, iconName?: IconName): HTMLButtonElement {
    const b = h('button', { className: 'iv-btn', type: 'button', title }, iconName ? svg(icon(iconName)) : null, text)
    b.addEventListener('click', onClick)
    return b
  }

  private buildPickers(): void {
    const desc = this.desc
    this.pickers.replaceChildren()
    if (!desc) return
    desc.axes.forEach((axis, index) => {
      if (axis.labels.length < 2) return
      const select = h('select', { className: 'iv-select', 'aria-label': this.t.axes[axis.key] })
      axis.labels.forEach((text, i) => select.append(h('option', { value: String(i) }, imageText(this.t, text))))
      select.dataset.axis = String(index)
      select.addEventListener('change', () => this.pickAxis(index, Number(select.value)))
      this.pickers.append(h('label', { className: 'iv-field' }, this.t.axes[axis.key], select))
    })
  }

  private syncPickers(): void {
    const image = this.image
    if (!image) return
    for (const select of Array.from(this.pickers.querySelectorAll('select'))) {
      const axis = Number(select.dataset.axis)
      select.value = String(image.at[axis] ?? 0)
      select.disabled = this.mode.kind !== 'image'
    }
  }

  /** Picks a position along one axis, keeping the others where they can stay. */
  private pickAxis(axis: number, value: number): void {
    const desc = this.desc
    const current = this.image
    if (!desc || !current) return
    const want = current.at.slice()
    want[axis] = value
    let best: ImageDesc | null = null
    let bestScore = -1
    for (const image of desc.images) {
      if (image.at[axis] !== value) continue
      let score = 0
      for (let k = 0; k < want.length; k++) if (image.at[k] === want[k]) score++
      if (score > bestScore) {
        best = image
        bestScore = score
      }
    }
    if (best) void this.select(best, { kind: 'image' }, this.keepViewFor(best))
  }

  private keepViewFor(next: ImageDesc): boolean {
    const r = this.raster
    return !!r && r.width === next.width && r.height === next.height
  }

  private step(direction: 1 | -1): void {
    const desc = this.desc
    const image = this.image
    if (!desc || !image) return
    if (this.mode.kind === 'layer' && desc.layers) {
      const pixels = desc.layers.filter((l) => l.image >= 0)
      const i = pixels.findIndex((l) => this.mode.kind === 'layer' && l.id === this.mode.layer)
      const next = pixels[i + direction]
      if (next) void this.select(image, { kind: 'layer', layer: next.id })
      return
    }
    const axis = desc.axes.findIndex((a) => a.labels.length > 1)
    if (axis < 0) return
    const value = (image.at[axis] ?? 0) + direction
    if (value >= 0 && value < desc.axes[axis].labels.length) this.pickAxis(axis, value)
  }

  private channelOptions(r: Raster): ChannelView[] {
    const list: ChannelView[] = r.color === 'rgb' ? ['rgb', 'r', 'g', 'b'] : ['rgb']
    if (r.alpha) list.push('a')
    if (r.color === 'rgb') list.push('luma')
    return list
  }

  private buildChannels(): void {
    const r = this.raster
    this.channelGroup.replaceChildren()
    if (!r || !this.tone) return
    const options = this.channelOptions(r)
    if (options.length < 2) return
    const seg = h('div', { className: 'iv-seg', role: 'group', 'aria-label': this.t.channel })
    const short: Record<ChannelView, string> = { rgb: r.color === 'rgb' ? 'RGB' : 'Y', r: 'R', g: 'G', b: 'B', a: 'A', luma: 'L' }
    for (const c of options) {
      const name = c === 'rgb' && r.color === 'gray' ? this.t.channels.gray : this.t.channels[c]
      const keyHint = { rgb: 'C', r: 'R', g: 'G', b: 'B', a: 'A', luma: 'L' }[c]
      const b = h('button', { type: 'button', title: `${name} (${keyHint})`, 'aria-pressed': String(this.tone.channel === c) }, short[c])
      b.addEventListener('click', () => this.setChannel(c))
      seg.append(b)
    }
    this.channelGroup.append(seg)
  }

  private setChannel(c: ChannelView): void {
    if (!this.raster || !this.tone || !this.channelOptions(this.raster).includes(c)) return
    this.applyTone({ ...this.tone, channel: c })
    this.buildChannels()
  }

  private buildTone(): void {
    const r = this.raster
    const tone = this.tone
    this.toneGroup.replaceChildren()
    if (!r || !tone || !isHighRange(r)) return
    const t = this.t
    if (r.transfer !== 'data') {
      const range = h('input', {
        type: 'range',
        className: 'iv-range',
        min: '-10',
        max: '10',
        step: '0.1',
        value: String(tone.exposure),
        'aria-label': t.exposure,
        title: t.exposureHint
      })
      const ev = h('span', { className: 'iv-ev' }, evText(tone.exposure))
      range.addEventListener('input', () => {
        const v = Number(range.value)
        ev.textContent = evText(v)
        if (this.tone) this.applyTone({ ...this.tone, exposure: v })
      })
      this.toneGroup.append(h('label', { className: 'iv-field', title: t.exposureHint }, svg(icon('sun')), range), ev)
    }
    if (r.transfer === 'linear') {
      const select = h('select', { className: 'iv-select', 'aria-label': t.toneMap, title: t.toneMapHint })
      for (const m of ['aces', 'reinhard', 'clip'] as ToneMap[]) select.append(h('option', { value: m }, t.toneMaps[m]))
      select.value = tone.map
      select.addEventListener('change', () => this.tone && this.applyTone({ ...this.tone, map: select.value as ToneMap }))
      this.toneGroup.append(select)
    }
    if (r.transfer === 'data' || tone.black !== 0 || tone.white !== 1) {
      const lo = r.transfer === 'data' ? formatFloat(tone.black) : String(Math.round(tone.black * 1000) / 1000)
      const hi = r.transfer === 'data' ? formatFloat(tone.white) : String(Math.round(tone.white * 1000) / 1000)
      this.toneGroup.append(h('span', { className: 'iv-field' }, `${t.levels} ${lo} – ${hi}`))
    }
    const auto = this.textButton(t.auto, r.transfer === 'linear' ? t.autoExposureHint : t.autoContrastHint, () => {
      if (!this.raster || !this.tone) return
      this.applyTone(autoTone(this.raster, this.tone))
      this.buildTone()
    })
    const reset = this.iconButton('reset', t.resetHint, () => {
      if (!this.raster || !this.tone) return
      this.applyTone({ ...initialTone(this.raster), channel: this.tone.channel })
      this.buildTone()
    })
    this.toneGroup.append(auto, reset)
  }

  private applyTone(tone: Tone): void {
    this.tone = tone
    this.viewport.setTone(tone)
    this.scheduleHistogram()
  }

  private nudgeExposure(delta: number): void {
    const r = this.raster
    if (!r || !this.tone || !isHighRange(r) || r.transfer === 'data') return
    this.applyTone({ ...this.tone, exposure: Math.max(-10, Math.min(10, Math.round((this.tone.exposure + delta) * 10) / 10)) })
    this.buildTone()
  }

  private updateSummary(): void {
    const r = this.raster
    const image = this.image
    if (!image) {
      this.summary.textContent = ''
      return
    }
    const parts = [`${image.width.toLocaleString(this.locale)} × ${image.height.toLocaleString(this.locale)}`]
    if (r) {
      const t = this.t
      const float = r.kind === 'f16' || (r.kind === 'f32' && r.bits === 32)
      const kind = fill(float ? t.bitsFloat : t.bitsInt, { n: String(r.kind === 'f16' ? 16 : r.bits) })
      const names = r.names.slice(0, r.channels).join('')
      parts.push(kind, names.length <= 5 ? names : fill(t.channelCount, { n: String(r.channels) }))
    }
    this.summary.textContent = parts.join(' · ')
  }

  private updateNotice(): void {
    const desc = this.desc
    if (!desc) return
    const notices = [...desc.notices]
    if (this.raster?.partial) notices.unshift({ code: 'damaged-partial' })
    if (this.raster?.notices) notices.push(...this.raster.notices)
    if (this.mode.kind === 'layers' && !desc.notices.some((n) => n.code === 'psd-no-composite')) notices.push({ code: 'psd-composite-simple' })
    if (!notices.length) {
      this.notice.hidden = true
      return
    }
    const text = notices.map((n) => fill(this.t.notices[n.code], { detail: n.detail ?? '' })).join(' ')
    this.notice.replaceChildren(svg(icon(notices.some((n) => n.code === 'damaged-partial') ? 'warning' : 'info')), h('span', {}, text))
    this.notice.classList.toggle('iv-info', !notices.some((n) => n.code === 'damaged-partial' || n.code === 'psd-no-composite'))
    this.notice.hidden = false
  }

  private showOverlay(text: string, busy: boolean): void {
    this.overlay.replaceChildren(h('div', { className: 'iv-pill' }, busy ? h('div', { className: 'iv-spinner' }) : svg(icon('warning')), h('span', {}, text)))
    this.overlay.hidden = false
  }

  private hideOverlay(): void {
    this.overlay.hidden = true
  }

  // ---------------------------------------------------------------- side pane

  private toggleSide(): void {
    this.sideOpen = !this.sideOpen
    storageSet('image-viewer.side', this.sideOpen ? '1' : '0')
    this.main.classList.toggle('iv-noside', !this.sideOpen)
    this.sideButton.setAttribute('aria-pressed', String(this.sideOpen))
  }

  private initSplit(split: HTMLElement): void {
    split.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      split.setPointerCapture(e.pointerId)
      split.classList.add('iv-dragging')
      const rect = this.main.getBoundingClientRect()
      const move = (ev: PointerEvent) => {
        const width = Math.round(Math.min(900, Math.max(220, rect.right - ev.clientX)))
        this.main.style.setProperty('--side', `${width}px`)
        storageSet('image-viewer.sideWidth', String(width))
      }
      const up = () => {
        split.classList.remove('iv-dragging')
        split.removeEventListener('pointermove', move)
        split.removeEventListener('pointerup', up)
      }
      split.addEventListener('pointermove', move)
      split.addEventListener('pointerup', up)
    })
  }

  private buildTabs(): void {
    const desc = this.desc
    this.tabs.replaceChildren()
    if (!desc) return
    const tabs: ('info' | 'layers' | 'list')[] = ['info']
    if (desc.layers?.length) tabs.push('layers')
    if (desc.list) tabs.push('list')
    if (tabs.length === 1) this.tab = 'info'
    for (const key of tabs) {
      const name = key === 'list' && desc.list ? this.listTitle(desc.list) : this.t.tabs[key]
      const b = h('button', { className: 'iv-tab', type: 'button', role: 'tab', 'aria-selected': String(this.tab === key) }, name)
      b.addEventListener('click', () => {
        this.tab = key
        for (const other of Array.from(this.tabs.children)) other.setAttribute('aria-selected', String(other === b))
        this.renderPane()
      })
      this.tabs.append(b)
    }
    this.tabs.hidden = tabs.length === 1
    this.renderPane()
  }

  private listTitle(key: DocDesc['list']): string {
    if (key === 'page') return this.t.labels.pages
    if (key === 'size') return this.t.labels.sizes
    if (key === 'mip') return this.t.labels.mipmaps
    if (key === 'face') return this.t.labels.faces
    return this.t.tabs.list
  }

  private renderPane(): void {
    this.thumbObserver?.disconnect()
    this.thumbObserver = null
    if (this.tab === 'layers') this.renderLayers()
    else if (this.tab === 'list') this.renderList()
    else this.renderInfo()
  }

  private renderInfo(): void {
    if (this.tab !== 'info') return
    const desc = this.desc
    if (!desc) return
    const t = this.t
    const scroll = this.pane.scrollTop
    const sections: HTMLElement[] = []
    const hist = h('canvas', { className: 'iv-hist', width: '512', height: '144', 'aria-label': t.histogram })
    const first: InfoSection = desc.info.find((s) => s.title === 'image') ?? { title: 'image', items: [] }
    const extra: InfoSection[] = []
    const image = this.image
    if (image && image.info.length && (desc.images.length > 1 || this.mode.kind !== 'image')) {
      extra.push({ title: 'selected', items: [{ key: 'name', value: imageText(t, image.label) }, ...image.info] })
    }
    if (this.mode.kind === 'layer' && desc.layers) {
      const layer = desc.layers.find((l) => this.mode.kind === 'layer' && l.id === this.mode.layer)
      if (layer) extra.push({ title: 'layer', items: this.layerItems(layer) })
    }
    sections.push(this.section(first, hist))
    for (const s of extra) sections.push(this.section(s))
    for (const s of desc.info) if (s !== first) sections.push(this.section(s))
    this.pane.replaceChildren(...sections)
    this.pane.scrollTop = scroll
    this.histCanvas = hist
    this.drawHistogram()
  }

  private histCanvas: HTMLCanvasElement | null = null

  private section(s: InfoSection, top?: HTMLElement): HTMLElement {
    const t = this.t
    const title = (t.sections as Record<string, string>)[s.title] ?? s.title
    const dl = h('dl', { className: `iv-meta${s.raw ? ' iv-raw' : ''}` })
    const limit = 40
    const add = (items: typeof s.items) => {
      for (const item of items) {
        const key = s.raw ? item.key : label(t, item.key)
        const value = s.raw
          ? valueText(t, item.value)
          : item.key === 'fileSize' && /^\d+$/.test(item.value)
            ? formatSize(Number(item.value), this.locale, t.units)
            : infoValue(t, item.key, item.value)
        dl.append(h('dt', { title: key }, key), h('dd', { className: item.mono ? 'iv-mono' : '' }, value))
      }
    }
    add(s.items.slice(0, limit))
    const el = h('section', { className: 'iv-sec' }, h('h3', {}, title), top ?? null, s.items.length ? dl : null)
    if (s.items.length > limit) {
      const more = h('button', { className: 'iv-more', type: 'button' }, `+${s.items.length - limit}`)
      more.addEventListener('click', () => {
        add(s.items.slice(limit))
        more.remove()
      })
      el.append(more)
    }
    if (s.text) {
      const pre = h('pre', { className: 'iv-packet', hidden: true }, s.text)
      const toggle = h('button', { className: 'iv-more', type: 'button' }, 'XML')
      toggle.addEventListener('click', () => (pre.hidden = !pre.hidden))
      el.append(toggle, pre)
    }
    if (top) top.style.marginBottom = '8px'
    return el
  }

  private layerItems(layer: LayerDesc): { key: string; value: string }[] {
    const items = [
      { key: 'name', value: layer.name },
      { key: 'kind', value: LAYER_KINDS[layer.kind] },
      { key: 'blend', value: layer.blend },
      { key: 'opacity', value: `${Math.round(layer.opacity * 100)}%` }
    ]
    if (layer.width && layer.height) items.push({ key: 'bounds', value: `${layer.width} × ${layer.height} @ ${layer.left}, ${layer.top}` })
    items.push({ key: 'visible', value: layer.visible ? 'Visible' : 'Hidden' })
    return items
  }

  private scheduleHistogram(): void {
    clearTimeout(this.histTimer)
    this.histTimer = setTimeout(() => this.drawHistogram(), 120)
  }

  private drawHistogram(): void {
    const canvas = this.histCanvas
    if (!canvas || !canvas.isConnected) return
    const ctx = canvas.getContext('2d')
    const pixels = this.viewport.overviewPixels()
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!pixels || !this.raster) return
    const hist = histogram(pixels.data)
    const style = getComputedStyle(this.root)
    const gray = this.raster.color === 'gray' || (this.tone && this.tone.channel !== 'rgb')
    const series = gray ? [[hist.l, style.getPropertyValue('--muted-fg')]] : [[hist.r, style.getPropertyValue('--hist-r')], [hist.g, style.getPropertyValue('--hist-g')], [hist.b, style.getPropertyValue('--hist-b')]]
    let max = 1
    for (const [bins] of series as [Uint32Array, string][]) {
      // Ignore the two ends when scaling, so clipped black or white does not flatten the rest.
      for (let i = 1; i < 255; i++) max = Math.max(max, bins[i])
    }
    ctx.globalCompositeOperation = gray ? 'source-over' : 'lighter'
    for (const [bins, colour] of series as [Uint32Array, string][]) {
      ctx.fillStyle = colour.trim() || '#888'
      ctx.globalAlpha = gray ? 0.8 : 0.75
      ctx.beginPath()
      ctx.moveTo(0, canvas.height)
      for (let i = 0; i < 256; i++) {
        const v = Math.min(1, bins[i] / max)
        ctx.lineTo((i / 255) * canvas.width, canvas.height - v * (canvas.height - 4))
      }
      ctx.lineTo(canvas.width, canvas.height)
      ctx.closePath()
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  private renderLayers(): void {
    const desc = this.desc
    const client = this.client
    if (!desc?.layers || !client) return
    const t = this.t
    const list = h('div', { className: 'iv-list', role: 'listbox', 'aria-label': t.tabs.layers })
    const primary = desc.images.find((i) => i.id === desc.primary)
    const compositeRow = h(
      'button',
      { className: 'iv-item iv-noeye', type: 'button', role: 'option', 'aria-selected': String(this.mode.kind !== 'layer') },
      this.thumbBox(primary ? primary.id : -1, 'image'),
      h('span', { className: 'iv-name' }, h('b', {}, t.composite), h('small', {}, this.compositeChanged() ? t.compositeLayers : t.compositeSaved))
    )
    compositeRow.addEventListener('click', () => this.showComposite())
    list.append(compositeRow)
    for (const layer of desc.layers) {
      const on = this.visible[layer.id] ?? layer.visible
      const eye = h('span', { className: 'iv-eye', role: 'checkbox', 'aria-checked': String(on), title: t.showLayer, 'aria-pressed': String(on) }, svg(icon(on ? 'eye' : 'eyeOff')))
      const kindIcon: IconName = layer.kind === 'group' ? 'folder' : layer.kind === 'text' ? 'text' : layer.kind === 'adjustment' || layer.kind === 'fill' ? 'adjust' : 'image'
      const thumb = layer.image >= 0 ? this.thumbBox(layer.image, kindIcon) : h('span', { className: 'iv-thumb iv-plain' }, svg(icon(kindIcon)))
      const tagged = layer.kind === 'text' || layer.kind === 'smart' || layer.kind === 'adjustment' || layer.kind === 'fill' ? `${valueText(t, LAYER_KINDS[layer.kind])} · ` : ''
      const meta = layer.kind === 'group' ? t.group : layer.image >= 0 ? `${tagged}${valueText(t, layer.blend)} · ${Math.round(layer.opacity * 100)}% · ${layer.width}×${layer.height}` : t.noPixels
      const row = h(
        'button',
        {
          className: `iv-item${on ? '' : ' iv-off'}`,
          type: 'button',
          role: 'option',
          'aria-selected': String(this.mode.kind === 'layer' && this.mode.layer === layer.id)
        },
        eye,
        thumb,
        h('span', { className: 'iv-name', style: `padding-left:${layer.depth * 12}px` }, h('b', { title: layer.name }, layer.name || '—'), h('small', {}, meta))
      )
      eye.addEventListener('click', (e) => {
        e.stopPropagation()
        this.visible[layer.id] = !on
        this.renderLayers()
        if (this.mode.kind !== 'layer') this.showComposite()
      })
      row.addEventListener('click', () => {
        if (layer.image >= 0 && this.image) void this.select(this.image, { kind: 'layer', layer: layer.id })
      })
      list.append(row)
    }
    const scroll = this.pane.scrollTop
    this.pane.replaceChildren(list)
    this.pane.scrollTop = scroll
  }

  private compositeChanged(): boolean {
    return (this.desc?.layers ?? []).some((l) => (this.visible[l.id] ?? l.visible) !== l.visible) || !!this.desc?.notices.some((n) => n.code === 'psd-no-composite')
  }

  private showComposite(): void {
    const desc = this.desc
    if (!desc) return
    const primary = desc.images.find((i) => i.id === desc.primary)
    if (!primary) return
    const keep = this.mode.kind !== 'layer'
    void this.select(primary, this.compositeChanged() && desc.layers ? { kind: 'layers' } : { kind: 'image' }, keep).then(() => {
      if (this.tab === 'layers') this.renderLayers()
    })
  }

  private renderList(): void {
    const desc = this.desc
    if (!desc?.list) return
    const axis = desc.axes.findIndex((a) => a.key === desc.list)
    const list = h('div', { className: 'iv-list', role: 'listbox' })
    const images = desc.images.filter((img) => axis < 0 || desc.images.every((o) => o.at.length === img.at.length))
    // One entry per position on the list axis, with the other axes where the current image is.
    const shown = new Map<number, ImageDesc>()
    for (const img of images) {
      const key = axis >= 0 ? img.at[axis] : img.id
      const current = this.image
      const prev = shown.get(key)
      const matches = (i: ImageDesc) => !current || i.at.every((v, k) => k === axis || v === current.at[k])
      if (!prev || (!matches(prev) && matches(img))) shown.set(key, img)
    }
    for (const img of shown.values()) {
      const row = h(
        'button',
        { className: 'iv-item iv-noeye', type: 'button', role: 'option', 'aria-selected': String(this.image?.id === img.id) },
        img.unsupported ? h('span', { className: 'iv-thumb iv-plain' }, svg(icon('broken'))) : this.thumbBox(img.id, 'image'),
        h('span', { className: 'iv-name' }, h('b', {}, imageText(this.t, img.label)), h('small', {}, img.unsupported ? imageText(this.t, img.unsupported) : `${img.width} × ${img.height}`))
      )
      row.addEventListener('click', () => void this.select(img, { kind: 'image' }, this.keepViewFor(img)))
      list.append(row)
    }
    const scroll = this.pane.scrollTop
    this.pane.replaceChildren(list)
    this.pane.scrollTop = scroll
  }

  private syncLists(): void {
    if (this.tab === 'list') this.renderList()
    else if (this.tab === 'layers') this.renderLayers()
  }

  private thumbCache = new Map<number, Thumbnail | 'failed'>()

  private thumbBox(image: number, fallback: IconName): HTMLElement {
    const box = h('span', { className: 'iv-thumb' })
    const cached = this.thumbCache.get(image)
    const paint = (thumb: Thumbnail | 'failed') => {
      if (thumb === 'failed') {
        box.classList.add('iv-plain')
        box.replaceChildren(svg(icon(fallback)))
        return
      }
      const canvas = h('canvas', { width: String(thumb.width), height: String(thumb.height) })
      const ctx = canvas.getContext('2d')
      ctx?.putImageData(new ImageData(new Uint8ClampedArray(thumb.data), thumb.width, thumb.height), 0, 0)
      box.replaceChildren(canvas)
    }
    if (image < 0) {
      paint('failed')
      return box
    }
    if (cached) {
      paint(cached)
      return box
    }
    box.classList.add('iv-plain')
    this.thumbObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target as HTMLElement
        this.thumbObserver?.unobserve(el)
        el.dispatchEvent(new Event('iv-visible'))
      }
    })
    box.addEventListener('iv-visible', () => {
      const client = this.client
      if (!client) return
      const generation = this.generation
      client.thumbnail(image, THUMB).then(
        (thumb) => {
          if (generation !== this.generation) return
          this.thumbCache.set(image, thumb)
          box.classList.remove('iv-plain')
          paint(thumb)
        },
        () => {
          if (generation !== this.generation) return
          this.thumbCache.set(image, 'failed')
          paint('failed')
        }
      )
    })
    this.thumbObserver.observe(box)
    return box
  }

  // ---------------------------------------------------------------- status bar

  private showPixel(x: number, y: number, inside: boolean): void {
    const r = this.raster
    if (!r || !inside) {
      this.status.replaceChildren(r ? h('span', {}, `${r.width} × ${r.height}`) : '')
      return
    }
    const values = pixelValues(r, x, y)
    const swatch = h('span', { className: 'iv-swatch' })
    if (this.tone) {
      const px = new Uint8ClampedArray(4)
      renderRegion(r, this.tone, x, y, 1, 1, px)
      swatch.style.background = `rgba(${px[0]}, ${px[1]}, ${px[2]}, ${px[3] / 255})`
    }
    this.status.replaceChildren(
      h('span', {}, `${x}, ${y}`),
      swatch,
      h('span', { className: 'iv-values' }, ...values.map((v) => h('span', {}, `${v.name} `, h('b', {}, v.value))))
    )
  }

  // ---------------------------------------------------------------- keyboard

  private onKey(e: KeyboardEvent): void {
    if (!this.desc || e.defaultPrevented) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key
    let handled = true
    const pan = 80
    if (k === '+' || k === '=') this.viewport.zoomStep(1)
    else if (k === '-' || k === '_') this.viewport.zoomStep(-1)
    else if (k === '0') this.viewport.fit()
    else if (k === '1') this.viewport.zoomTo(1)
    else if (k === '2') this.viewport.zoomTo(2)
    else if (k === 'ArrowLeft') this.viewport.pan(-pan, 0)
    else if (k === 'ArrowRight') this.viewport.pan(pan, 0)
    else if (k === 'ArrowUp') this.viewport.pan(0, -pan)
    else if (k === 'ArrowDown') this.viewport.pan(0, pan)
    else if (k === 'PageDown' || k === ']') this.step(1)
    else if (k === 'PageUp' || k === '[') this.step(-1)
    else if (k === 'c' || k === 'C') this.setChannel('rgb')
    else if (k === 'r' || k === 'R') this.setChannel('r')
    else if (k === 'g' || k === 'G') this.setChannel('g')
    else if (k === 'b' || k === 'B') this.setChannel('b')
    else if (k === 'a' || k === 'A') this.setChannel('a')
    else if (k === 'l' || k === 'L') this.setChannel('luma')
    else if (k === 'e') this.nudgeExposure(0.5)
    else if (k === 'E') this.nudgeExposure(-0.5)
    else if (k === 'i' || k === 'I') this.toggleSide()
    else handled = false
    if (handled) e.preventDefault()
  }

  // ---------------------------------------------------------------- save and copy

  private fileName(): string {
    const image = this.image
    const desc = this.desc
    let name = 'image'
    if (this.mode.kind === 'layer' && desc?.layers) {
      const layer = desc.layers.find((l) => this.mode.kind === 'layer' && l.id === this.mode.layer)
      if (layer) name += `-${layer.name}`
    } else if (image && desc && desc.images.length > 1) {
      name += `-${image.label}`
    }
    if (this.tone && this.tone.channel !== 'rgb') name += `-${this.tone.channel}`
    return (
      name
        .replace(/[\\/:*?"<>|\s·×]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100) + '.png'
    )
  }

  private async encodeCurrent(): Promise<Uint8Array> {
    const r = this.raster
    const tone = this.tone
    if (!r || !tone) throw new ImageError('decode-failed')
    const rgba = new Uint8ClampedArray(r.width * r.height * 4)
    const band = 256
    for (let y = 0; y < r.height; y += band) {
      const hgt = Math.min(band, r.height - y)
      const part = new Uint8ClampedArray(rgba.buffer, y * r.width * 4, hgt * r.width * 4)
      renderRegion(r, tone, 0, y, r.width, hgt, part)
    }
    return encodePng(r.width, r.height, rgba)
  }

  private async save(): Promise<void> {
    const saveAs = this.saveAs
    if (!saveAs || !this.raster) return
    const started = performance.now()
    this.showToast(this.t.saving, 60000)
    let png: Uint8Array
    try {
      png = await this.encodeCurrent()
    } catch (error) {
      console.warn('[image-viewer] cannot encode PNG', error)
      this.showToast(this.t.saveFailed)
      return
    }
    if (png.length > SAVE_LIMIT) {
      this.showToast(this.t.saveTooBig, 5000)
      return
    }
    const data = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
    const run = async () => {
      try {
        const result = await saveAs({ suggestedName: this.fileName(), mimeType: 'image/png', data })
        if (result.status === 'saved') this.showToast(`${this.t.saved} · ${formatSize(png.length, this.locale, this.t.units)}`)
        else this.hideToast()
      } catch (error) {
        console.warn('[image-viewer] save failed', error)
        this.showToast(this.t.saveFailed)
      }
    }
    // The save dialog needs a recent press; after a long encode, ask for one more.
    if (performance.now() - started < 2500) {
      await run()
      return
    }
    const again = h('button', { className: 'iv-btn iv-primary', type: 'button', style: 'pointer-events:auto' }, this.t.save)
    again.addEventListener('click', () => void run())
    this.toast.replaceChildren(again)
    this.toast.style.pointerEvents = 'auto'
    this.toast.classList.add('iv-show')
  }

  private async copy(): Promise<void> {
    if (!this.raster) return
    try {
      const blob = this.encodeCurrent().then((png) => new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      this.showToast(this.t.copied)
    } catch (error) {
      console.warn('[image-viewer] copy failed', error)
      this.showToast(this.t.copyFailed, 4000)
    }
  }

  private showToast(text: string, ms = 1800): void {
    this.toast.style.pointerEvents = ''
    this.toast.textContent = text
    this.toast.classList.add('iv-show')
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => this.hideToast(), ms)
  }

  private hideToast(): void {
    this.toast.classList.remove('iv-show')
    this.toast.style.pointerEvents = ''
  }

  /** Re-reads theme colours (checkerboard, histogram) after Orca switches theme. */
  themeChanged(): void {
    this.viewport.setTone(this.tone ?? initialTone(this.raster ?? ({} as Raster)))
    this.drawHistogram()
  }

  get keyHint(): string {
    return this.mac ? '⌘' : 'Ctrl'
  }
}

function evText(v: number): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} EV`
}

export { append }
