#!/usr/bin/env bash
# Build 余晖 and install it to /Applications, idempotently — for use on YOUR OWN
# Mac (the build machine). To share with someone else, send them the DMG that
# this produces (dist/余晖-<version>-arm64.dmg), not this script.
#
# Make it double-clickable in Finder once with:
#   chmod +x scripts/install-mac.sh && cp scripts/install-mac.sh 安装余晖.command
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="余晖.app"
BUILT_APP="dist/mac-arm64/$APP_NAME"
INSTALLED_APP="/Applications/$APP_NAME"

echo "==> Installing npm dependencies (if needed)"
npm install --silent

echo "==> Cleaning previous build"
rm -rf dist

echo "==> Building DMG + zip (arm64, ad-hoc re-signed)"
npx electron-builder --mac \
  -c.electronDist=./node_modules/electron/dist \
  -c.electronVersion=42.5.0

echo "==> Verifying the code-signature seal is VALID"
if ! codesign --verify --deep --strict --verbose=2 "$BUILT_APP"; then
  echo "ERROR: signature seal is invalid — aborting before install." >&2
  echo "       Check that mac.identity is \"-\" in package.json." >&2
  exit 1
fi
echo "    seal OK"

echo "==> Installing to /Applications"
osascript -e 'quit app "余晖"' >/dev/null 2>&1 || true
sleep 1
rm -rf "$INSTALLED_APP"
ditto "$BUILT_APP" "$INSTALLED_APP"
# Locally built apps are not quarantined, but strip defensively just in case.
xattr -dr com.apple.quarantine "$INSTALLED_APP" 2>/dev/null || true

echo "==> Launching"
open "$INSTALLED_APP"

cat <<DONE

✓ Installed: $INSTALLED_APP  (menu-bar only, no Dock icon)
  Share with others: dist/$(ls dist 2>/dev/null | grep -m1 '\.dmg$' || echo '余晖-*.dmg')
  First time it shows Claude data, click "始终允许 / Always Allow" on the keychain prompt.
DONE
