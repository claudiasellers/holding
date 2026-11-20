#!/bin/bash
# Installs the Holding Mac widget: the parent in a small floating window, from the menu bar.
#
#   curl -fsSL https://raw.githubusercontent.com/claudiasellers/holding/main/mac-widget/install.sh | bash
#
# No Apple developer account and no Gatekeeper prompts: files fetched with curl aren't
# quarantined, and the app is ad-hoc signed. Options (after `bash -s --` when piped):
#   --from-source   build with the Xcode Command Line Tools instead of downloading the build
#   --uninstall     remove the app, its login item and its settings
set -euo pipefail

REPO="claudiasellers/holding"
ZIP_URL="https://github.com/$REPO/releases/latest/download/Holding-Widget-mac.zip"
APP_NAME="Holding Widget.app"
LABEL="app.holding.widget"

if [ -w /Applications ]; then DEST="/Applications"; else DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
say() { printf '\033[1m%s\033[0m\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then echo "This installs the Mac widget; run it on a Mac." >&2; exit 1; fi

if [ "${1:-}" = "--uninstall" ]; then
  pkill -x HoldingWidget 2>/dev/null || true
  rm -rf "/Applications/$APP_NAME" "$HOME/Applications/$APP_NAME" "$HOME/Library/LaunchAgents/$LABEL.plist"
  defaults delete "$LABEL" 2>/dev/null || true
  say "Holding widget removed."
  exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
APP=""

build_from_source() {
  if ! command -v swiftc >/dev/null 2>&1; then
    say "Building needs Apple's free Command Line Tools. Starting their installer now."
    xcode-select --install 2>/dev/null || true
    echo "When it finishes, run this installer again." >&2
    exit 1
  fi
  local here=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/Sources/main.swift" ]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  else
    say "Downloading the source…"
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar xz -C "$TMP"
    here="$(echo "$TMP"/*/mac-widget)"
  fi
  say "Building…"
  bash "$here/build.sh"
  APP="$here/build/$APP_NAME"
}

if [ "${1:-}" = "--from-source" ]; then
  build_from_source
else
  say "Downloading the Holding widget…"
  if curl -fL --retry 2 --progress-bar -o "$TMP/widget.zip" "$ZIP_URL"; then
    ditto -x -k "$TMP/widget.zip" "$TMP/x"
    APP="$TMP/x/$APP_NAME"
  else
    say "No ready-made build to download; building it on this Mac instead."
    build_from_source
  fi
fi

[ -d "$APP" ] || { echo "Couldn't find the built app at $APP" >&2; exit 1; }

pkill -x HoldingWidget 2>/dev/null || true
rm -rf "${DEST:?}/$APP_NAME"
ditto "$APP" "$DEST/$APP_NAME"
xattr -dr com.apple.quarantine "$DEST/$APP_NAME" 2>/dev/null || true
# Keep "open at login" pointing at the new copy if it was on.
if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:2 $DEST/$APP_NAME" "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
fi
open "$DEST/$APP_NAME"

say "Holding is in your menu bar (the heart). Control-Option-H shows or hides the parent."
echo "Installed to $DEST/$APP_NAME"
