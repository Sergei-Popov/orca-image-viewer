// The custom editor: Orca opens an image in a main editor tab here — from the file tree, a file
// link in a chat, or `orca file open` — and sends its bytes. Orca keeps files over about 50 MB out
// of custom editors and shows its own notice instead. The viewer never edits, so Orca never saves
// the tab; an outside write reopens the image.

import { stringsFor } from './i18n'
import { installStyles } from './styles'
import { ImageView } from './viewer/view'

const locale = globalThis.orca?.locale || navigator.language || 'en'
const strings = stringsFor(locale)
installStyles()
const view = new ImageView({
  strings,
  locale,
  saveAs: globalThis.orca?.files?.saveAs
})
document.body.append(view.root)
view.showLoading()

globalThis.orca?.on?.('theme', () => view.themeChanged())

const api = globalThis.orca?.document
if (!api) {
  view.showError(strings.errorTitle, strings.noHost)
} else {
  api.onDidChange((doc) => {
    if (doc.content.kind !== 'bytes') {
      view.showError(strings.errorTitle, strings.textContent)
      return
    }
    // A copy goes to the decode worker, so the document Orca handed over stays intact.
    void view.open(doc.content.bytes.slice(0), doc.fileType)
  })
}
