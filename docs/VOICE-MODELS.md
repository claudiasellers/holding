# Voice models

Holding speaks with a voice model you download once. Settings → Voice → **Voice models** lists them with their size and the space they use. Each one has **Download**, **Use** and **Delete** buttons, and deleting a model gives the space back. Everything runs on your own devices for free. No paid API is involved.

| Model | Where it runs | Size | Feeling | Speed |
|---|---|---|---|---|
| Device voices | Everywhere | built in | none | instant |
| Kokoro-82M (Apache-2.0) | Any browser, including phones, and Holding Local | 92 MB (326 MB on WebGPU) | none (flat but clear) | far faster than real time |
| **Chatterbox** (Resemble AI, MIT) | Desktop browsers with WebGPU, and Holding Local on Mac, Windows and Linux | about 1.5 GB | **feeling dial** (`exaggeration`) | **slower than real time on a CPU**: 0.17 to 0.27× on a 4-core CI runner (a 5 s line takes 20 to 35 s). Faster on a WebGPU GPU; not yet measured on the Mac mini |

## Why Chatterbox

The user wanted a voice with more emotional resonance that stays local and free. We compared these candidates in November 2026:

- **Chatterbox (0.5B, MIT)** is the only open model with an explicit emotion-intensity control. It copies a voice from 5 to 10 seconds of reference audio, so each parent keeps their own voice. In Resemble's blind test, listeners preferred it over ElevenLabs. Transformers.js 4 runs it natively in the browser, and its ONNX export runs on plain ONNX Runtime, so Holding Local needs no PyTorch.
- **Chatterbox Turbo (350M)** is smaller (about 560 MB at q4f16) and faster, and it supports `[sigh]` and `[chuckle]` tags. It has no feeling dial. It is a good next step for the browser if download size matters more than the dial.
- **Qwen3-TTS (0.6B/1.7B, Apache-2.0)** gives the richest control: you describe the delivery in plain words, such as "softly, reassuring". It runs on a Mac through mlx-audio. Measured speed is about 0.2× real time on an M4 (tts-bench), in the same range as Chatterbox on CPU, and it is Mac-only through MLX, so it was not the first pick. It is the strongest candidate for pre-rendering scripted lines on the Mac mini if Chatterbox's delivery isn't enough.
- **Orpheus 3B (Apache-2.0)** is very expressive, with `<sigh>` and `<laugh>` tags. It is a 3B model and wants a GPU, so it is too heavy for the Mac mini alongside the chat model.
- **IndexTTS-2**, **Fish S2** and **F5-TTS** have strong emotion control, but their licenses are non-commercial or restricted.
- **Supertonic 3** has expression tags and runs in browsers, but its repository is archived and gets no further support.
- **Kokoro**, the voice we already had, is fast and clean but has no emotional range. It stays as the fallback, and its voices are the ones Chatterbox copies.

Phones can't hold a 1.5 GB model with usable speed. On a phone, choose **Voice from my computer**. Holding Local then speaks with Chatterbox over Wi-Fi or Tailscale.

## Speed

CI measured Chatterbox on CPU at 0.17 to 0.27× real time, for both engines:

| Engine | Line | Audio | Time to make it |
|---|---|---|---|
| Holding Local (ONNX Runtime, 4-bit LM) | steady-grandmother, feeling 0.35 | 6.0 s | 35 s |
| Holding Local | steady-grandmother, feeling 0.8 | 5.3 s | 20 s |
| Holding Local | gentle-giant, feeling 0.35 | 5.3 s | 32 s |
| Holding Local | gentle-giant, feeling 0.8 | 4.6 s | 21 s |
| Browser engine on CPU (Transformers.js) | default voice, feeling 0.35 / 0.8 | 3.3 s / 2.5 s | 18 s / 15 s |

These runs used a 4-vCPU GitHub runner, so an Apple Silicon Mac should be several times faster, and a desktop GPU through WebGPU faster still. Even so, a long live reply will take a moment to start. Two things soften this:

- The client splits replies at pauses and makes the next phrase while the current one plays.
- If the live voice fails, the instant pre-recorded line plays instead.

Pre-rendering each parent's scripted lines with Chatterbox once, in the background on Holding Local, would make the scripted part of a session instant and expressive. That is the natural next step.

## How the feeling works

- **Feeling dial.** Each parent figure has a feeling setting from 0.25 to 1. The default is 0.55. Set it in Settings → Voice; it appears when an expressive model is in use. Lower sounds calm and even, and higher sounds more animated.
- **Peak distress.** In the "be with" tier, the engine lowers the feeling to 80%, so the parent steadies instead of getting dramatic.
- **Pre-recorded lines.** With an expressive model in use, scripted lines are spoken live instead of from the flat Kokoro recordings. The recordings remain the instant fallback if the live voice fails.
- **Where the parent's voice comes from.** Chatterbox copies the voice from a short reference clip:
  - In the browser, the clip comes from the parent's own pre-recorded lines. If there are none, Kokoro renders one, and failing that Chatterbox uses its built-in voice.
  - On Holding Local, Kokoro renders the clip in the parent's voice spec, including blends such as `af_nicole:0.55+am_michael:0.45`.

## Holding Local

```
holding-local voice list
holding-local voice download chatterbox   # resumable; also from Settings
holding-local voice use chatterbox
holding-local voice delete chatterbox
```

API (same pairing token as the rest of `/v1`):

- `GET /v1/voice-models` returns the models with `downloaded`, `bytes`, `downloading`, `done_bytes` and `total_bytes`, plus `selected` and `disk.free_bytes`.
- `POST /v1/voice-models/{id}/download` downloads in the background and resumes from `.part` files.
- `DELETE /v1/voice-models/{id}` removes the files. Kokoro is kept.
- `POST /v1/voice-models/select {"id": "chatterbox"}` sets the default voice model.
- `POST /v1/audio/speech` accepts `model: "chatterbox"` and `exaggeration` (0.25 to 1.5). It falls back to Kokoro if Chatterbox isn't downloaded, and the `X-Voice-Model` header says which model spoke.

Files are stored in `~/.holding-local/models/chatterbox/`. The loop uses the 4-bit language model, and the encoder and decoder at fp32.

## Browser

The browser loads Transformers.js 4.3.2 from jsDelivr (`src/voice/chatterbox-version.js`) and runs it on WebGPU. The language model uses q4f16 when the GPU supports shader-f16 and q4 otherwise. Weights live in the browser's `transformers-cache`. The manager measures and deletes them there (`src/voice/models.js`), and the service worker never copies them.

## Tests

- `npm test` covers cache accounting and deletion, the feeling dial, and the core helpers.
- `cd local && uv run --with pytest pytest -q` covers the manager endpoints, resumable download, Kokoro fallback, and the generation loop with stand-in sessions.
- The **Voice models** CI workflow runs the real model through both engines on every voice change. It uploads WAV samples at feeling 0.35 and 0.8, next to Kokoro, as artifacts to listen to.
