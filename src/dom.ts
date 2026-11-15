// A tiny element builder: text goes in as text nodes, never as HTML, because file names come
// from the file. Only the static icon strings in icons.ts are inserted as markup.

type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue
    if (key === 'className') el.className = String(value)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  append(el, ...children)
  return el
}

export function append(el: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

/** One of the static SVG icons from icons.ts as an element. */
export function svg(markup: string): Element {
  const template = document.createElement('template')
  template.innerHTML = markup
  const el = template.content.firstElementChild
  if (!el) throw new Error('empty icon')
  return el
}
