// The page's CSS, built on the `--orca-*` theme variables so it follows Orca's light and dark
// themes; Orca updates the variables in place and toggles `light`/`dark` on <html>.

export const css = String.raw`
:root {
  --bg: var(--orca-background, #ffffff);
  --fg: var(--orca-foreground, #0a0a0a);
  --card: var(--orca-card, #ffffff);
  --muted: var(--orca-muted, #f5f5f5);
  --muted-fg: var(--orca-muted-foreground, #737373);
  --accent: var(--orca-accent, #f5f5f5);
  --accent-fg: var(--orca-accent-foreground, #171717);
  --border: var(--orca-border, #e5e5e5);
  --input: var(--orca-input, #e5e5e5);
  --primary: var(--orca-primary, #171717);
  --primary-fg: var(--orca-primary-foreground, #fafafa);
  --ring: var(--orca-ring, #a3a3a3);
  --destructive: var(--orca-destructive, #dc2626);
  --popover: var(--orca-popover, #ffffff);
  --popover-fg: var(--orca-popover-foreground, #0a0a0a);
  --radius: var(--orca-radius, 6px);
  --select: color-mix(in srgb, var(--primary) 10%, transparent);
  --select-strong: color-mix(in srgb, var(--primary) 16%, transparent);
  --stage: color-mix(in srgb, var(--muted) 55%, var(--bg));
  --warn: #b7791f;
  --check-a: #ffffff;
  --check-b: #e6e6e6;
  --hist-r: #e5484d;
  --hist-g: #30a46c;
  --hist-b: #3e63dd;
  --ui-font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono-font: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
:root.dark {
  --bg: var(--orca-background, #0a0a0a);
  --fg: var(--orca-foreground, #fafafa);
  --card: var(--orca-card, #0a0a0a);
  --muted: var(--orca-muted, #262626);
  --muted-fg: var(--orca-muted-foreground, #a3a3a3);
  --accent: var(--orca-accent, #262626);
  --accent-fg: var(--orca-accent-foreground, #fafafa);
  --border: var(--orca-border, #2e2e2e);
  --input: var(--orca-input, #2e2e2e);
  --primary: var(--orca-primary, #fafafa);
  --primary-fg: var(--orca-primary-foreground, #171717);
  --ring: var(--orca-ring, #737373);
  --destructive: var(--orca-destructive, #f87171);
  --popover: var(--orca-popover, #171717);
  --popover-fg: var(--orca-popover-foreground, #fafafa);
  --stage: color-mix(in srgb, var(--bg) 70%, #000);
  --warn: #e0a84a;
  --check-a: #2a2a2a;
  --check-b: #3a3a3a;
  --hist-r: #ff6369;
  --hist-g: #3dd68c;
  --hist-b: #7b9bff;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 12px/1.4 var(--ui-font);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
button, select, input { font: inherit; color: inherit; }
[hidden] { display: none !important; }
.iv-icon { width: 14px; height: 14px; display: block; flex: none; }
.iv-root { height: 100%; }
.iv-app { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }

/* Toolbar */
.iv-bar {
  display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap;
  padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg); min-height: 40px;
}
.iv-group { display: flex; align-items: center; gap: 4px; }
.iv-sep { width: 1px; align-self: stretch; margin: 2px 0; background: var(--border); }
.iv-badge {
  font-size: 10.5px; font-weight: 600; letter-spacing: .02em; padding: 1px 7px; border-radius: 999px;
  background: var(--muted); color: var(--fg); border: 1px solid var(--border); white-space: nowrap;
}
.iv-summary { color: var(--muted-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; font-variant-numeric: tabular-nums; }
.iv-spacer { flex: 1; }
.iv-field { display: flex; align-items: center; gap: 5px; color: var(--muted-fg); white-space: nowrap; }
.iv-select {
  height: 26px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--bg); color: var(--fg);
  padding: 0 6px; max-width: 220px;
}
.iv-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px;
  border: 1px solid var(--input); border-radius: var(--radius); background: var(--bg); color: var(--fg); cursor: pointer; white-space: nowrap;
}
.iv-btn:hover:not(:disabled) { background: var(--accent); color: var(--accent-fg); }
.iv-btn:disabled { opacity: .5; cursor: default; }
.iv-btn.iv-square { width: 26px; padding: 0; justify-content: center; }
.iv-btn[aria-pressed="true"] { background: var(--select-strong); }
.iv-btn.iv-primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
.iv-btn.iv-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--primary) 88%, var(--bg)); color: var(--primary-fg); }
.iv-select:focus-visible, .iv-btn:focus-visible, .iv-seg button:focus-visible, .iv-range:focus-visible, .iv-tab:focus-visible {
  outline: 2px solid var(--ring); outline-offset: 1px;
}
.iv-seg { display: inline-flex; border: 1px solid var(--input); border-radius: var(--radius); overflow: hidden; height: 26px; }
.iv-seg button {
  border: 0; background: var(--bg); padding: 0 8px; cursor: pointer; color: var(--muted-fg); min-width: 26px;
  border-right: 1px solid var(--input); font-weight: 500;
}
.iv-seg button:last-child { border-right: 0; }
.iv-seg button:hover { background: var(--accent); color: var(--accent-fg); }
.iv-seg button[aria-pressed="true"] { background: var(--select-strong); color: var(--fg); }
.iv-zoom { min-width: 52px; text-align: center; font-variant-numeric: tabular-nums; }
.iv-range { width: 120px; accent-color: var(--primary); }
.iv-ev { min-width: 54px; font-variant-numeric: tabular-nums; color: var(--fg); text-align: right; }

.iv-notice {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px; color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent); border-bottom: 1px solid var(--border);
}
.iv-notice span { color: var(--fg); }
.iv-notice.iv-info { color: var(--muted-fg); background: var(--muted); }

/* Stage and side pane */
.iv-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 5px var(--side, 300px); }
.iv-main.iv-noside { grid-template-columns: minmax(0, 1fr); }
.iv-main.iv-noside .iv-split, .iv-main.iv-noside .iv-side { display: none; }
.iv-split { cursor: col-resize; background: var(--border); background-clip: content-box; padding: 0 2px; }
.iv-split:hover, .iv-split.iv-dragging { background-color: var(--ring); }
@media (max-width: 640px) {
  .iv-main { grid-template-columns: 1fr; grid-template-rows: minmax(200px, 1fr) 1px minmax(0, 40%); }
  .iv-split { cursor: default; padding: 0; pointer-events: none; }
}
.iv-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: var(--stage); outline: none; cursor: grab; touch-action: none; }
.iv-stage.iv-grabbing { cursor: grabbing; }
.iv-stage:focus-visible { box-shadow: inset 0 0 0 1px var(--ring); }
.iv-canvas { position: absolute; inset: 0; display: block; }
.iv-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.iv-overlay .iv-pill {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; pointer-events: auto;
  background: var(--popover); color: var(--popover-fg); border: 1px solid var(--border); box-shadow: 0 4px 16px rgb(0 0 0 / .14);
}
.iv-side { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.iv-tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--border); }
.iv-tab {
  border: 0; background: none; padding: 5px 10px 6px; cursor: pointer; color: var(--muted-fg);
  border-bottom: 2px solid transparent; margin-bottom: -1px; font-weight: 500;
}
.iv-tab:hover { color: var(--fg); }
.iv-tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--fg); }
.iv-pane { flex: 1; min-height: 0; overflow: auto; }

/* Info */
.iv-sec { padding: 10px 14px 12px; border-bottom: 1px solid var(--border); }
.iv-sec:last-child { border-bottom: 0; }
.iv-sec h3 { margin: 0 0 7px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted-fg); }
.iv-meta { display: grid; grid-template-columns: minmax(80px, max-content) minmax(0, 1fr); gap: 3px 12px; margin: 0; }
.iv-meta dt { color: var(--muted-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iv-meta dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; user-select: text; white-space: pre-wrap; }
.iv-meta .iv-mono { font-family: var(--mono-font); font-size: 11px; }
.iv-raw dt { font-family: var(--mono-font); font-size: 11px; }
.iv-packet {
  margin: 8px 0 0; padding: 8px 10px; border-radius: var(--radius); background: var(--muted); max-height: 260px; overflow: auto;
  font: 11px/1.45 var(--mono-font); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
}
.iv-more { margin-top: 6px; border: 0; background: none; color: var(--muted-fg); cursor: pointer; padding: 2px 0; text-decoration: underline; text-underline-offset: 2px; }
.iv-more:hover { color: var(--fg); }
.iv-hist { display: block; width: 100%; height: 72px; border-radius: 4px; background: var(--muted); }

/* Layer and image lists */
.iv-list { display: flex; flex-direction: column; padding: 4px 0; }
.iv-item {
  display: grid; grid-template-columns: auto 44px minmax(0, 1fr); align-items: center; gap: 8px;
  padding: 4px 10px; cursor: pointer; border: 0; background: none; text-align: left; width: 100%; color: inherit;
}
.iv-item.iv-noeye { grid-template-columns: 44px minmax(0, 1fr); }
.iv-item:hover { background: var(--accent); }
.iv-item[aria-selected="true"] { background: var(--select-strong); }
.iv-item:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.iv-thumb {
  width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 4px; overflow: hidden;
  background: repeating-conic-gradient(var(--check-a) 0% 25%, var(--check-b) 0% 50%) 50% / 8px 8px; box-shadow: 0 0 0 1px var(--border);
}
.iv-thumb canvas { max-width: 100%; max-height: 100%; display: block; image-rendering: auto; }
.iv-thumb .iv-icon { color: var(--muted-fg); width: 18px; height: 18px; }
.iv-thumb.iv-plain { background: var(--muted); }
.iv-name { display: flex; flex-direction: column; min-width: 0; }
.iv-name b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iv-name small { color: var(--muted-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.iv-item.iv-off .iv-name b { color: var(--muted-fg); }
.iv-eye {
  width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 4px;
  border: 0; background: none; cursor: pointer; color: var(--muted-fg); padding: 0;
}
.iv-eye:hover { background: var(--muted); color: var(--fg); }
.iv-eye[aria-pressed="true"] { color: var(--fg); }

/* Status bar */
.iv-status {
  display: flex; align-items: center; gap: 14px; padding: 0 10px; height: 26px; border-top: 1px solid var(--border);
  color: var(--muted-fg); font: 11px/1 var(--mono-font); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums;
}
.iv-status .iv-swatch { width: 12px; height: 12px; border-radius: 3px; box-shadow: 0 0 0 1px var(--border); flex: none; }
.iv-status b { color: var(--fg); font-weight: 500; }
.iv-status .iv-values { display: flex; gap: 10px; overflow: hidden; }

/* Messages */
.iv-center { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; color: var(--muted-fg); }
.iv-center h2 { margin: 0; font-size: 14px; color: var(--fg); }
.iv-center p { margin: 0; max-width: 480px; }
.iv-center .iv-icon { width: 32px; height: 32px; stroke-width: 1; }
.iv-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--fg); animation: iv-spin .8s linear infinite; flex: none; }
@keyframes iv-spin { to { transform: rotate(360deg); } }
.iv-toast {
  position: absolute; right: 14px; bottom: 40px; padding: 6px 10px; border-radius: var(--radius); max-width: 420px;
  background: var(--popover); color: var(--popover-fg); border: 1px solid var(--border);
  box-shadow: 0 4px 16px rgb(0 0 0 / .18); opacity: 0; transform: translateY(4px); transition: opacity .15s, transform .15s; pointer-events: none;
}
.iv-toast.iv-show { opacity: 1; transform: none; }
`

export function installStyles(): void {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
}
