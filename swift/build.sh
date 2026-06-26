#!/bin/bash
# Build the native Swift "余晖 / Afterglow" widget into a self-contained .app
# using only the Command Line Tools (swiftc) — no Xcode, no third-party deps.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="余晖"
BUNDLE_ID="com.local.afterglow-swift"
EXEC_NAME="Afterglow"
VERSION="0.3.0"

BUILD_DIR="build"
APP="$BUILD_DIR/$APP_NAME.app"
MACOS_DIR="$APP/Contents/MacOS"
RES_DIR="$APP/Contents/Resources"

echo "→ cleaning"
rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RES_DIR"

echo "→ compiling Swift sources"
swiftc -swift-version 5 -O \
    -target arm64-apple-macos13.0 \
    Sources/*.swift \
    -o "$MACOS_DIR/$EXEC_NAME"

echo "→ copying resources (brand logos + app icon)"
cp assets/openai.svg assets/claude.svg "$RES_DIR/"
[ -f ../assets/icon.icns ] && cp ../assets/icon.icns "$RES_DIR/icon.icns" || echo "  (no icon.icns — run npm run icon in repo root)"

echo "→ writing Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleExecutable</key><string>$EXEC_NAME</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
echo "APPL????" > "$APP/Contents/PkgInfo"

echo "→ code signing"
SIGN_KC="$HOME/Library/Keychains/afterglow-codesign.keychain-db"
SIGN_ID="Afterglow Local Signing"
if security find-certificate -c "$SIGN_ID" "$SIGN_KC" >/dev/null 2>&1; then
    security unlock-keychain -p "afterglow-signing" "$SIGN_KC" 2>/dev/null || true
    if codesign --force --sign "$SIGN_ID" --keychain "$SIGN_KC" "$APP" 2>/dev/null; then
        echo "  signed with stable identity — keychain「始终允许」会跨重编译保留"
    else
        echo "  stable signing failed → ad-hoc"; codesign --force --sign - "$APP" 2>/dev/null || true
    fi
else
    echo "  提示：先跑一次 ./setup-signing.sh，钥匙串「始终允许」才能跨重编译保留；当前用 ad-hoc 签名"
    codesign --force --sign - "$APP" 2>/dev/null || true
fi

echo "✓ built: $APP"
echo "  打开： open \"$APP\""
