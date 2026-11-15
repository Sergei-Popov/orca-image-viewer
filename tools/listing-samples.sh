#!/bin/sh
# Builds the listing demo files into .orca/listing/samples/ (git-ignored) with the generators in
# tools/demo: a ray-traced sunset scene as EXR, HDR, PNG, HEIC and DNG, a layered PSD poster, DDS
# textures and a terrain TIFF. Everything in them is made by these scripts; the camera is fictional.
#
#   tools/listing-samples.sh            # PYTHON=… to pick an interpreter with the packages below
#
# Needs Python 3 with numpy, Pillow, tifffile and OpenEXR, Node.js, and macOS `sips` for the HEIC.
set -eu
cd "$(dirname "$0")/.."
out=.orca/listing/samples
py=${PYTHON:-python3}
mkdir -p "$out"
# More rays per pixel than the demo default: less grain, and smaller lossless listing images.
"$py" tools/demo/scene.py "$out" 1600 1000 4 16
"$py" tools/demo/outputs.py "$out"
"$py" tools/demo/poster.py "$out/poster"
"$py" tools/demo/textures.py "$out"
bundle="$out/containers.mjs"
npx -y esbuild@0.25.12 tools/demo/containers.ts --bundle --platform=node --format=esm --outfile="$bundle" --log-level=warning
node "$bundle" dng "$out/dng"
node "$bundle" psd "$out/poster"
rm -f "$bundle"
ls -l "$out"
