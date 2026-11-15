// The editor's side of decoding: requests go to the worker, or to an in-thread session when the
// frame cannot start one. Answers come back in any order, matched by id.

import { browserPlatform } from './browser'
import { type ErrorCode, ImageError } from './errors'
import type { DocDesc, Raster } from './model'
import { type Reply, type Request, serializeError, Session, type Thumbnail } from './protocol'

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }
type Body = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export class DecoderClient {
  private worker: Worker | null = null
  private local: Session | null = null
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private answered = false
  /** A copy of the bytes sent to the worker, kept until it first answers. */
  private openCopy: ArrayBuffer | null = null
  private readonly inflight = new Map<number, Request>()

  constructor() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (event: MessageEvent<Reply>) => this.receive(event.data)
      this.worker.onerror = (event) => {
        event.preventDefault()
        this.fallBack()
      }
    } catch {
      this.worker = null
    }
  }

  /** Whether decoding runs in a worker (false after a fallback). */
  get threaded(): boolean {
    return !!this.worker
  }

  open(bytes: ArrayBuffer, fileType?: string): Promise<DocDesc> {
    if (this.worker && !this.answered) this.openCopy = bytes.slice(0)
    return this.send({ type: 'open', bytes, fileType }) as Promise<DocDesc>
  }

  decode(image: number): Promise<Raster> {
    return this.send({ type: 'decode', image }) as Promise<Raster>
  }

  composite(visible: boolean[]): Promise<Raster> {
    return this.send({ type: 'composite', visible }) as Promise<Raster>
  }

  thumbnail(image: number, size: number): Promise<Thumbnail> {
    return this.send({ type: 'thumbnail', image, size }) as Promise<Thumbnail>
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    for (const p of this.pending.values()) p.reject(new ImageError('decode-failed', '', 'disposed'))
    this.pending.clear()
  }

  private send(body: Body): Promise<unknown> {
    const id = this.next++
    const request = { ...body, id } as Request
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.inflight.set(id, request)
      if (this.worker) {
        const transfer = request.type === 'open' ? [request.bytes] : []
        this.worker.postMessage(request, transfer)
      } else {
        this.runLocal(request)
      }
    })
  }

  private runLocal(request: Request): void {
    this.local ??= new Session(browserPlatform())
    this.local.handle(request).then(
      (value) => this.receive({ id: request.id, ok: true, value }),
      (error) => this.receive({ id: request.id, ok: false, ...serializeError(error) })
    )
  }

  /** The worker failed to start (a content policy, a load error): redo the requests in place. */
  private fallBack(): void {
    if (!this.worker || this.answered) return
    console.warn('[image-viewer] decode worker unavailable, decoding in the editor')
    this.worker.terminate()
    this.worker = null
    const requests = [...this.inflight.values()].sort((x, y) => x.id - y.id)
    for (const request of requests) {
      this.runLocal(request.type === 'open' && this.openCopy ? { ...request, bytes: this.openCopy } : request)
    }
  }

  private receive(reply: Reply): void {
    this.answered = true
    this.openCopy = null
    this.inflight.delete(reply.id)
    const p = this.pending.get(reply.id)
    if (!p) return
    this.pending.delete(reply.id)
    if (reply.ok) p.resolve(reply.value)
    else p.reject(new ImageError(reply.code as ErrorCode, reply.detail, reply.message))
  }
}
