#!/usr/bin/env bash
# Lets your phone use this computer's AI over HTTPS through Tailscale (free).
# Without Tailscale it falls back to plain Wi-Fi (no camera or mic on the phone).
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
if command -v tailscale >/dev/null 2>&1 || [ -d /Applications/Tailscale.app ]; then
  exec bash ./start.sh --tailscale
else
  echo "Tailscale isn't installed, so using Wi-Fi only. Get Tailscale at https://tailscale.com/download"
  exec bash ./start.sh --lan
fi
