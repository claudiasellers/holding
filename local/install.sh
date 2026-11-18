#!/usr/bin/env bash
# Holding Local installer for macOS and Linux. Safe to run again; it skips what's done.
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Holding Local: free, private AI that runs on this computer"
echo "This downloads about 7-10 GB the first time (the chat model is most of it)."

# 1. uv (self-contained Python manager; installs to ~/.local/bin, no admin needed)
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv (Python manager)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# 2. Ollama (runs the chat model)
have_ollama() { command -v ollama >/dev/null 2>&1 || [ -d /Applications/Ollama.app ] || [ -d "$HOME/Applications/Ollama.app" ]; }
if ! have_ollama; then
  say "Installing Ollama"
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install --cask ollama
    else
      tmp="$(mktemp -d)"
      curl -fL --progress-bar -o "$tmp/Ollama.dmg" https://ollama.com/download/Ollama.dmg
      mnt="$(hdiutil attach -nobrowse -readonly "$tmp/Ollama.dmg" | tail -1 | awk -F'\t' '{print $NF}')"
      dest=/Applications; [ -w /Applications ] || dest="$HOME/Applications"; mkdir -p "$dest"
      cp -R "$mnt/Ollama.app" "$dest/"
      hdiutil detach "$mnt" -quiet || true
      rm -rf "$tmp"
    fi
    open -a Ollama || true
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
fi

# 3. Python environment with the voice and listening engines
say "Setting up the voice and listening engines"
uv sync --extra stt --quiet

# 4. Launchers
chmod +x "Start Holding Local.command" "Start with phone access.command" start.sh 2>/dev/null || true

# 5. Download models for this hardware and start
say "Downloading models for this computer"
exec uv run --quiet holding-local setup
