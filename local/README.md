# Holding Local

Free, private AI for the Holding app that runs entirely on your own computer. No accounts, no API keys, no bills. Your words, voice and face never leave the machine.

It gives the app three things:

- **A parent who talks**: a local chat model through [Ollama](https://ollama.com) (Gemma 4 by default, picked for your hardware).
- **A voice**: Kokoro, a small, warm-sounding text-to-speech model (Apache 2.0).
- **Listening (optional)**: Whisper speech-to-text, for when you want to talk back instead of type. You never have to.

It also serves the app itself, so you just open `http://127.0.0.1:8787`.

## Install (one time)

**Easiest on a Mac:** download `Holding-Local-mac.dmg` from the [latest release](https://github.com/claudiasellers/holding/releases/latest), drag Holding Local to Applications, open it and press **Set up**. It does everything below with progress bars, lives in the menu bar, pairs your phone with a QR code and manages chat models. See `../mac-app/README.md`.

Or with this folder:

| Computer | Do this |
|---|---|
| **Mac** | Double-click **Install Holding Local.command**. If macOS says it can't be opened, right-click it, choose **Open**, then **Open** again. |
| **Windows** | Double-click **Install Holding Local.bat**. If SmartScreen appears, choose **More info → Run anyway**. |
| **Linux** | Run `./install.sh` in a terminal. |

The installer sets up everything it needs (uv for Python, Ollama, the voice and listening engines), looks at how much memory your computer has, downloads the right chat model, and opens the app. The first run downloads about 7–10 GB, mostly the chat model. Later starts take a few seconds.

## Every day

Double-click **Start Holding Local** (`.command` on Mac, `.bat` on Windows, or `./start.sh`). Leave the window open while you use the app; close it to stop.

**On a Mac, keep the parent on your desktop:** double-click **Install Holding Widget.command** once. It adds a small floating parent to the menu bar (Control-Option-H shows or hides it) that uses Holding Local whenever it's running. See the [Mac widget guide](https://github.com/claudiasellers/holding/blob/main/mac-widget/README.md).

## Use it from your phone

Your phone can use your computer's AI while both are on.

**Best: Tailscale (free, HTTPS, works anywhere).** Phones only allow the camera (for mirroring), microphone and "Add to Home Screen" on secure `https` pages, and Tailscale gives you one with a real certificate.

1. Install Tailscale on the computer and on your phone from [tailscale.com/download](https://tailscale.com/download), and sign in to the same account on both.
2. In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and **HTTPS certificates** (one-time).
3. Double-click **Start with phone access**. It runs `tailscale serve --bg 8787` for you and shows a QR code.
4. Scan the QR code with your phone, or open `http://127.0.0.1:8787/pair` on the computer for a bigger one.
5. On iPhone, tap Share → **Add to Home Screen**. The installed app keeps its own storage, so open it and type the **pairing code** shown next to the QR code (like `K7QM-2XPA`) when it asks.

**Quick: same Wi-Fi only.** `./start.sh --lan` (or `Start Holding Local.bat --lan`) shows a QR code with a plain `http://192.168.x.x` link. Chat and the voice work; the phone's camera, mic and install don't, because the page isn't secure.

The pairing code is required for anything that isn't on the computer itself. Make a new one (and unpair old phones) with `--new-token`.

## Change the chat model

```
uv run holding-local model gemma4:12b
```

| Your computer | Model | Download |
|---|---|---|
| 8 GB memory | `qwen3.5:4b` | ~4 GB |
| 16 GB memory, or 8 GB graphics card (default) | `gemma4:e4b` | ~7–10 GB |
| 32 GB Mac, or 12–16 GB graphics card | `gemma4:12b` | ~8 GB |
| 48 GB+ Mac, or 24 GB graphics card | `gemma4:26b` | ~17 GB |

Others worth trying: `qwen3.5:9b`, `qwen3.5:27b`. To free space, `uv run holding-local models` lists the chat models with their sizes and `uv run holding-local models rm TAG` deletes one (not the one in use). Settings → AI in the app, and the Mac app's **Chat models…**, do the same with buttons. `uv run holding-local status` shows what's running and what's downloaded; `uv run holding-local catalog` lists the recommendations.

## For developers: the API

Everything is under `http://127.0.0.1:8787/v1` and is OpenAI-compatible, so any OpenAI client works with `baseURL` set to that and any `apiKey` (the pairing code when not on the same machine). Interactive docs at `/v1/docs`.

| Endpoint | What it does |
|---|---|
| `POST /v1/chat/completions` | Chat, streaming (`stream: true`, SSE) or not. `model` may be `default`. Thinking is forced off for reasoning models and any `<think>` text is removed. Accepts `temperature`, `top_p`, `max_tokens`, `stop`, `seed`, image parts as data URLs. |
| `POST /v1/audio/speech` | `{model, input, voice, speed, response_format}`. `voice` is a Kokoro voice (`af_heart`), an archetype id (`warm-aunt`), a blend (`af_nicole:0.6+am_michael:0.4`), or an OpenAI name (`nova`). `response_format`: `wav` (default), `mp3`/`opus`/`aac`/`flac` (need ffmpeg; otherwise WAV is returned with `Content-Type: audio/wav`), `pcm` (16-bit mono, rate in `X-Sample-Rate`). |
| `POST /v1/audio/transcriptions` | Multipart `file` (+ optional `language`, `prompt`, `response_format` = `json`/`text`/`verbose_json`). Whisper `small` by default (`base` on 8 GB machines); `501` if listening isn't installed. |
| `POST /v1/embeddings` | `nomic-embed-text` through Ollama, for the RAG skill. Remember its `search_query: ` / `search_document: ` prefixes. |
| `GET /v1/models` | Installed models. `401` without the pairing code from another device, which is how a phone detects "needs pairing". |
| `GET /v1/chat-models` | Chat models in Ollama with sizes, which one is in use, recommended downloads, free disk, download progress. `POST /v1/chat-models/select {name}` switches, `POST /v1/chat-models/pull {name}` downloads in the background (`DELETE /v1/chat-models/pull` stops it), `DELETE /v1/chat-models/{name}` deletes one and returns `freed_bytes` (`409` for the model in use). |
| `GET /v1/voices` | Kokoro voices, archetype presets, OpenAI aliases. |
| `GET /v1/catalog` | Recommended model tiers, exact WebLLM ids for the browser/phone path, archetype voices. |
| `GET /health` | Open to all (no secrets): is Ollama up, is the model downloaded, is the voice ready. |
| `GET /v1/pair`, `/pair` | Pairing QR code and code. Only answers a browser on the computer itself. |

**Auth.** Requests from a browser on this computer (`127.0.0.1`/`localhost`, no proxy headers) need nothing. Everything else (LAN, Tailscale, any other `Host`) needs `Authorization: Bearer <pairing code>` (or `X-Pair-Token: <code>`); dashes, spaces and case are ignored. More than 20 wrong codes a minute returns `429`. The app's own files are served without auth since they hold no secrets.

**CORS.** API responses send CORS headers for any origin by default (plus `Access-Control-Allow-Private-Network: true` for Chrome), so a hosted copy of the app can call the companion. To restrict, set `"cors_origins": ["https://you.github.io"]` in `~/.holding-local/config.json`.

**App files.** Served from, in order: `--app-dir`, `./app` (inside a packaged download), `../dist` (the built app), `..` (the app folder itself, for development). Single-page-app routes fall back to `index.html`. Dotfiles, and top-level `node_modules`, `local/`, `android/`, `ios/`, `tools/` and `scripts/`, are never served. `./package.sh` zips this folder plus `../dist` into `dist/Holding-Local.zip`.

**Config** lives in `~/.holding-local/config.json` (models in `~/.holding-local/models`). Set `HOLDING_LOCAL_HOME` to move it.

Tests: `uv run --with pytest pytest -q` (no models or Ollama needed).

## Licences

Companion code: MIT. Gemma 4 and Qwen3.5: Apache 2.0. Kokoro-82M: Apache 2.0 (kokoro-onnx: MIT). faster-whisper / Whisper: MIT. nomic-embed-text: Apache 2.0. Ollama: MIT.
