#!/usr/bin/env bash
# Start Holding Local. Extra options pass through, e.g. ./start.sh --tailscale
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
exec uv run --quiet holding-local start "$@"
