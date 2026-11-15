// Inline 16×16 icons drawn with `currentColor`, so they follow the theme.

const paths = {
  zoomIn: '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.35 3.35M5 7h4M7 5v4"/>',
  zoomOut: '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.35 3.35M5 7h4"/>',
  fit: '<path d="M2.25 5.5V3c0-.41.34-.75.75-.75h2.5M10.5 2.25H13c.41 0 .75.34.75.75v2.5M13.75 10.5V13c0 .41-.34.75-.75.75h-2.5M5.5 13.75H3a.75.75 0 0 1-.75-.75v-2.5"/>',
  save: '<path d="M8 2v8.25M4.75 7 8 10.25 11.25 7M2.5 11.5v1.75c0 .41.34.75.75.75h9.5c.41 0 .75-.34.75-.75V11.5"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25"/><path d="M10.75 5.25V3.5c0-.69-.56-1.25-1.25-1.25H3.5c-.69 0-1.25.56-1.25 1.25v6c0 .69.56 1.25 1.25 1.25h1.75"/>',
  panel: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25"/><path d="M10 2.75v10.5"/>',
  eye: '<path d="M1.5 8s2.4-4.25 6.5-4.25S14.5 8 14.5 8 12.1 12.25 8 12.25 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>',
  eyeOff: '<path d="M2.5 2.5l11 11M6.6 4.05A6.6 6.6 0 0 1 8 3.75C12.1 3.75 14.5 8 14.5 8a11.6 11.6 0 0 1-1.9 2.45M4.4 5.1A11.4 11.4 0 0 0 1.5 8s2.4 4.25 6.5 4.25a6.2 6.2 0 0 0 2.95-.75"/>',
  folder: '<path d="M1.75 4.25c0-.55.45-1 1-1h3.4l1.5 1.6h5.6c.55 0 1 .45 1 1v6.4c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z"/>',
  text: '<path d="M3.5 3.5h9M8 3.5v9.25M6.25 12.75h3.5"/>',
  adjust: '<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25v11.5A5.75 5.75 0 0 0 8 2.25z" fill="currentColor"/>',
  image: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25"/><circle cx="5.5" cy="6.25" r="1.25"/><path d="m2.25 12 3.6-3.6 2.4 2.4 2.1-2.1 3.4 3.4"/>',
  warning: '<path d="M8 1.75 1.5 13.25h13z"/><path d="M8 6.25v3.5M8 11.5v.25"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.25v4M8 5v.25"/>',
  broken: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25"/><path d="m6 6.5 4 4M10 6.5l-4 4"/>',
  reset: '<path d="M3 8a5 5 0 1 0 1.5-3.55L3 6"/><path d="M3 2.75V6h3.25"/>',
  sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.25M8 13.25v1.25M14.5 8h-1.25M2.75 8H1.5M12.6 3.4l-.9.9M4.3 11.7l-.9.9M12.6 12.6l-.9-.9M4.3 4.3l-.9-.9"/>'
}

export type IconName = keyof typeof paths

export function icon(name: IconName, className = ''): string {
  return `<svg class="iv-icon ${className}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`
}
