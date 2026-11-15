// The decode worker: parses and decodes off the editor's thread, so a large TIFF or EXR never
// freezes the tab. One worker per open document.

import { browserPlatform } from './browser'
import { type Reply, type Request, serializeError, Session, transferOf } from './protocol'

const session = new Session(browserPlatform())
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null
  postMessage(message: Reply, transfer: Transferable[]): void
}

scope.onmessage = (event) => {
  const request = event.data
  session.handle(request).then(
    (value) => scope.postMessage({ id: request.id, ok: true, value }, transferOf(value)),
    (error) => scope.postMessage({ id: request.id, ok: false, ...serializeError(error) }, [])
  )
}
