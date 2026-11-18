#!/bin/bash
# Builds "Holding Widget.app" (the Mac widget) into mac-widget/build/.
# Needs only the free Xcode Command Line Tools (run `xcode-select --install` once). No Apple
# developer account: the app is ad-hoc signed, which is all a Mac needs to run it locally.
#   ./build.sh            build for this Mac
#   ./build.sh --universal  build for Apple Silicon and Intel (what CI ships)
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-1.0}"
BUILD="${BUILD:-1}"
OUT="build/Holding Widget.app"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the free Command Line Tools with: xcode-select --install" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

if [ "${1:-}" = "--universal" ]; then
  for arch in arm64 x86_64; do
    swiftc -O -target "$arch-apple-macos12.0" Sources/main.swift -o "build/HoldingWidget-$arch"
  done
  lipo -create build/HoldingWidget-arm64 build/HoldingWidget-x86_64 -output "$OUT/Contents/MacOS/HoldingWidget"
  rm -f build/HoldingWidget-arm64 build/HoldingWidget-x86_64
else
  swiftc -O Sources/main.swift -o "$OUT/Contents/MacOS/HoldingWidget"
fi

sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" Info.plist > "$OUT/Contents/Info.plist"
printf 'APPL????' > "$OUT/Contents/PkgInfo"

# App icon from AppIcon.png (sips and iconutil ship with macOS).
ICONSET="build/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s AppIcon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) AppIcon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

# Ad-hoc signature: free, local, enough for macOS to run it and remember camera/mic permission.
codesign --force --deep --sign - "$OUT"
echo "Built $(pwd)/$OUT"
