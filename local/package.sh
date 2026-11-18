#!/usr/bin/env bash
# Builds local/dist/Holding-Local.zip: this companion plus the built app (../dist),
# ready to download, unzip and double-click. Run from anywhere.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="${1:-}"
if [ -z "$app" ]; then
  for c in "$here/app" "$here/../dist"; do
    [ -f "$c/index.html" ] && app="$c" && break
  done
fi
out="$here/dist"; stage="$(mktemp -d)/Holding Local"
mkdir -p "$stage" "$out"
(cd "$here" && tar --exclude=.venv --exclude=dist --exclude=__pycache__ --exclude=app -cf - .) | (cd "$stage" && tar -xf -)
if [ -n "$app" ]; then
  mkdir -p "$stage/app"
  (cd "$app" && tar --exclude=node_modules --exclude=.git --exclude=local-ai -cf - .) | (cd "$stage/app" && tar -xf -)
  echo "Included app from $app"
else
  echo "No built app found (run 'npm run build' in the app folder first); the zip will serve the API and a placeholder page."
fi
chmod +x "$stage"/*.command "$stage"/*.sh
rm -f "$out/Holding-Local.zip"
(cd "$(dirname "$stage")" && zip -qr -X "$out/Holding-Local.zip" "Holding Local")
echo "Wrote $out/Holding-Local.zip ($(du -h "$out/Holding-Local.zip" | cut -f1))"
