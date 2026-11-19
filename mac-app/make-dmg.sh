#!/bin/bash
# Wraps build/Holding Local.app in build/Holding-Local-mac.dmg (drag to Applications),
# then signs, notarizes and staples it when the Apple credentials are set:
#   SIGN_IDENTITY                         "Developer ID Application: Your Name (TEAMID)"
#   NOTARY_KEY_PATH, NOTARY_KEY_ID, NOTARY_ISSUER   App Store Connect API key (preferred), or
#   NOTARY_APPLE_ID, NOTARY_PASSWORD, NOTARY_TEAM_ID  Apple ID + app-specific password
set -euo pipefail
cd "$(dirname "$0")"
APP="build/Holding Local.app"
DMG="build/Holding-Local-mac.dmg"
[ -d "$APP" ] || { echo "Build the app first: ./build.sh" >&2; exit 1; }

stage="build/tmp/dmg"
rm -rf "$stage" "$DMG"; mkdir -p "$stage"
ditto "$APP" "$stage/Holding Local.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname "Holding Local" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$DMG"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
  if [ -n "${NOTARY_KEY_PATH:-}" ]; then
    xcrun notarytool submit "$DMG" --key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait --timeout 30m
  elif [ -n "${NOTARY_APPLE_ID:-}" ]; then
    xcrun notarytool submit "$DMG" --apple-id "$NOTARY_APPLE_ID" --password "$NOTARY_PASSWORD" --team-id "$NOTARY_TEAM_ID" --wait --timeout 30m
  else
    echo "Signed but not notarized (no NOTARY_* settings). Gatekeeper will still block it when downloaded." >&2
    exit 0
  fi
  xcrun stapler staple "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose "$DMG" || true
  echo "Notarized and stapled $DMG"
else
  echo "Made $DMG (ad-hoc; not notarized)."
fi
