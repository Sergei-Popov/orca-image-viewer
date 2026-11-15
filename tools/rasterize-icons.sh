#!/bin/sh
# Rasterizes the icon SVGs to 256×256 PNG with headless Chrome (macOS path; set CHROME elsewhere).
set -eu
cd "$(dirname "$0")/.."
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
for svg in icons/image.svg icons/raw.svg images/icon.svg; do
  png="${svg%.svg}.png"
  tmp=$(mktemp -d)
  printf '<html><body style="margin:0;background:transparent"><img src="file://%s" width="256" height="256" style="display:block"></body></html>' \
    "$PWD/$svg" > "$tmp/page.html"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size=256,256 --screenshot="$PWD/$png" "file://$tmp/page.html" >/dev/null 2>&1
  rm -rf "$tmp"
  echo "$png"
done
