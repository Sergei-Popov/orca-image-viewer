import { start } from './sync'

// Your editor's view. A library (a canvas, a diagram kit) goes here instead of the textarea:
// copy its ESM build into the plugin and import it by a relative path.
const text = document.createElement('textarea')
text.spellcheck = false
text.style.cssText =
  'box-sizing:border-box;width:100%;height:100vh;margin:0;padding:12px;border:0;resize:none;' +
  'font:13px ui-monospace,monospace;color:var(--orca-foreground);background:var(--orca-background)'
document.body.style.margin = '0'
document.body.append(text)

const doc = await start()
text.value = doc.value
text.readOnly = doc.readOnly
doc.onReplace((value) => {
  text.value = value
})
text.addEventListener('input', () => doc.change(text.value))
