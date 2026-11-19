#!/bin/bash
# Builds "Holding Local.app" into mac-app/build/.
#   ./build.sh               for this Mac
#   ./build.sh --universal   for Apple silicon and Intel (what CI ships)
# Needs Apple's free Command Line Tools (xcode-select --install) and the internet (it
# fetches uv). Run `npm run build` in the repo first to include the web app.
# Signing: set SIGN_IDENTITY to a "Developer ID Application: ..." identity in your keychain
# for a build you can notarize; without it the app is ad-hoc signed (fine on your own Mac).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
VERSION="${VERSION:-0.1.0}"
BUILD="${BUILD:-1}"
UV_VERSION="0.11.32"
UV_SHA_arm64="ed336d0ba49db8ef89b2b41fffa372ce63bd032f22a56f001c265891aec32829"
UV_SHA_x86_64="77f5ca26c0de20e992a3677a174fe1121ee25c36f9b1434a863f75bf077a05eb"
APP="build/Holding Local.app"
RES="$APP/Contents/Resources"

command -v swiftc >/dev/null || { echo "swiftc not found. Install the Command Line Tools: xcode-select --install" >&2; exit 1; }

if [ "${1:-}" = "--universal" ]; then ARCHS="arm64 x86_64"; else ARCHS="$(uname -m)"; fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/bin" build/tmp

# 1. The app itself.
bins=()
for arch in $ARCHS; do
  swiftc -O -parse-as-library -target "$arch-apple-macos13.0" Sources/*.swift -o "build/tmp/HoldingLocal-$arch"
  bins+=("build/tmp/HoldingLocal-$arch")
done
lipo -create "${bins[@]}" -output "$APP/Contents/MacOS/HoldingLocal"

# 2. uv, pinned and checksummed. It sets up Python and the engine on first run.
uvs=()
for arch in $ARCHS; do
  triple="$([ "$arch" = arm64 ] && echo aarch64 || echo x86_64)-apple-darwin"
  tgz="build/tmp/uv-$triple.tar.gz"
  [ -f "$tgz" ] || curl -fsSL -o "$tgz" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$triple.tar.gz"
  want="$(eval echo "\$UV_SHA_$arch")"
  got="$(shasum -a 256 "$tgz" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || { echo "uv checksum mismatch for $arch: $got" >&2; rm -f "$tgz"; exit 1; }
  tar -xzf "$tgz" -C build/tmp
  uvs+=("build/tmp/uv-$triple/uv")
done
lipo -create "${uvs[@]}" -output "$RES/bin/uv"
chmod +x "$RES/bin/uv"

# 3. The engine (holding_local), copied out to Application Support on first run.
mkdir -p "$RES/engine"
(cd "$ROOT/local" && tar --exclude=__pycache__ -cf - holding_local pyproject.toml uv.lock .python-version LICENSE README.md) \
  | (cd "$RES/engine" && tar -xf -)

# 4. The web app, served by the engine on http://127.0.0.1:8787.
if [ -f "$ROOT/dist/index.html" ]; then
  mkdir -p "$RES/app"
  (cd "$ROOT/dist" && tar --exclude=node_modules --exclude=.git --exclude=local-ai -cf - .) | (cd "$RES/app" && tar -xf -)
else
  echo "No built web app in $ROOT/dist (run npm run build); the app will serve the API only." >&2
fi

# 5. Info.plist and icon.
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
ICON_SRC="${ICON_SRC:-$ROOT/public/icons/icon-512.png}"
ICONSET="build/tmp/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

# 6. Sign: nested executables first, then the app. Hardened runtime for notarization.
if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$RES/bin/uv"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
  echo "Signed with $SIGN_IDENTITY"
else
  codesign --force --deep --sign - "$APP"
  echo "Ad-hoc signed (no SIGN_IDENTITY). Fine on this Mac; downloads from the web need a Developer ID build."
fi
codesign --verify --strict --verbose=1 "$APP"
echo "Built $(pwd)/$APP ($(du -sh "$APP" | cut -f1))"
