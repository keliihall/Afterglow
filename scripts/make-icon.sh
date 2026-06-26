#!/usr/bin/env bash
# Regenerate assets/icon.icns from assets/icon.svg using only Apple-bundled tools
# (qlmanage + sips + iconutil) — no Homebrew / ImageMagick / rsvg needed.
set -euo pipefail
cd "$(dirname "$0")/.."

SVG="assets/icon.svg"
ICNS="assets/icon.icns"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SVG" ] || { echo "missing $SVG" >&2; exit 1; }

echo "→ rasterizing $SVG to 1024px PNG"
qlmanage -t -s 1024 -o "$WORK" "$SVG" >/dev/null 2>&1
sips -z 1024 1024 "$WORK/$(basename "$SVG").png" --out "$WORK/master.png" >/dev/null

W=$(sips -g pixelWidth "$WORK/master.png" | awk '/pixelWidth/{print $2}')
[ "$W" = "1024" ] || { echo "rasterized master is ${W}px, expected 1024" >&2; exit 1; }

echo "→ assembling iconset"
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
gen() { sips -z "$1" "$1" "$WORK/master.png" --out "$ICONSET/$2" >/dev/null; }
gen 16  icon_16x16.png
gen 32  icon_16x16@2x.png
gen 32  icon_32x32.png
gen 64  icon_32x32@2x.png
gen 128 icon_128x128.png
gen 256 icon_128x128@2x.png
gen 256 icon_256x256.png
gen 512 icon_256x256@2x.png
gen 512 icon_512x512.png
cp "$WORK/master.png" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$ICNS"
echo "✓ wrote $ICNS ($(wc -c < "$ICNS") bytes)"
