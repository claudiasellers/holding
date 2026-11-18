# Voice models

Holding speaks with a voice model you download once. Settings → Voice → **Voice models** lists them with their size and the space they use. Each one has **Download**, **Use** and **Delete** buttons, and deleting a model gives the space back. Everything runs on your own devices for free. No paid API is involved.

None of them is required. Download only the ones you want, try them, and delete the rest.

| Model | Where it runs | Size | Parent's own voice | Feeling | Speed |
|---|---|---|---|---|---|
| Device voices | Everywhere | built in | n/a | none | instant |
| Kokoro-82M (Apache-2.0) | Any browser, including phones, and Holding Local | 92 MB (326 MB on WebGPU) | yes (it *is* the voice) | none (flat but clear) | far faster than real time |
| **Chatterbox** (Resemble AI, MIT) | Desktop browsers with WebGPU, and Holding Local on any computer | about 1.5 GB | yes, copied | **feeling dial** | slower than real time on a CPU: 0.17 to 0.27× on a 4-core CI runner |
| **Chatterbox Turbo** (Resemble AI, MIT) | Desktop browsers with WebGPU, and Holding Local on any computer | about 960 MB | yes, copied | no dial; reads `[sigh]`, `[chuckle]` | several times faster than Chatterbox (see CI) |
| **Qwen3-TTS 1.7B** (Alibaba, Apache-2.0) | Holding Local on a Mac with Apple silicon | about 3.1 GB | no: its own voices (Serena, Ryan) | **feeling dial**, sent as a spoken instruction | see CI |
| **Qwen3-TTS 0.6B** | Mac | about 2 GB | no | **feeling dial** | faster than 1.7B |
| **Chatterbox on the Mac's GPU** | Mac | about 1.4 GB | yes, copied | **feeling dial** | GPU, several times faster than on CPU |
| **Chatterbox Turbo on the Mac's GPU** | Mac | about 1.2 GB | yes, copied | tags | fastest of the voices that copy a parent |
| **Orpheus 3B** (Canopy Labs, Apache-2.0) | Mac with 16 GB or more | about 2 GB (4-bit) | no: its own voices (Tara, Leo) | `<sigh>`, `<laugh>` tags | see CI |
| **Sesame CSM-1B** (Apache-2.0) | Mac | about 2.2 GB | yes, copied | conversational delivery | see CI |
| **Dia 1.6B** (Nari Labs, Apache-2.0) | Mac with 16 GB or more | about 6.5 GB | yes, copied | `(laughs)`, `(sighs)` | slowest here; not run in CI (needs more memory than the runner) |

Settings groups them as **Run on any computer** and **Mac only**. On a computer that can't run the Mac voices, that group says why instead of offering downloads.

## Why Chatterbox

The user wanted a voice with more emotional resonance that stays local and free. We compared these candidates in November 2026:

- **Chatterbox (0.5B, MIT)** is the only open model with an explicit emotion-intensity control. It copies a voice from 5 to 10 seconds of reference audio, so each parent keeps their own voice. In Resemble's blind test, listeners preferred it over ElevenLabs. Transformers.js 4 runs it natively in the browser, and its ONNX export runs on plain ONNX Runtime, so Holding Local needs no PyTorch.
- **Chatterbox Turbo (350M)** is smaller (about 560 MB at q4f16) and faster, and it supports `[sigh]` and `[chuckle]` tags. It has no feeling dial. It is a good next step for the browser if download size matters more than the dial.
- **Qwen3-TTS (0.6B/1.7B, Apache-2.0)** gives the richest control: you describe the delivery in plain words, such as "softly, reassuring". It runs on a Mac through mlx-audio. Measured speed is about 0.2× real time on an M4 (tts-bench), in the same range as Chatterbox on CPU, and it is Mac-only through MLX, so it was not the first pick. It is the strongest candidate for pre-rendering scripted lines on the Mac mini if Chatterbox's delivery isn't enough.
- **Orpheus 3B (Apache-2.0)** is very expressive, with `<sigh>` and `<laugh>` tags. It is a 3B model and wants a GPU, so it is too heavy for the Mac mini alongside the chat model.
- **IndexTTS-2**, **Fish S2** and **F5-TTS** have strong emotion control, but their licenses are non-commercial or restricted, so they are not offered.
- **Supertonic 3** has expression tags and runs in browsers, but its repository is archived and gets no further support. The browser-ready Supertonic build is v1, which has no expression control, so it isn't offered either.

All the open, freely licensed options that run on your own devices are now in the manager. Chatterbox stays the recommended default because it is the only one with both a feeling dial and each parent's own voice on every computer.
- **Kokoro**, the voice we already had, is fast and clean but has no emotional range. It stays as the fallback, and its voices are the ones Chatterbox copies.

Phones can't hold these models with usable speed. On a phone, choose **Voice from my computer**. Holding Local then speaks with whichever model you picked, over Wi-Fi or Tailscale.

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

**Recorded ahead.** On Holding Local, choosing any voice other than Kokoro starts recording the current parent's scripted lines in the background. That is about 430 lines, filled with the same endearment and name the session uses, with the "Hold me" openers first. Every line Chatterbox speaks is also kept, so repeats are instant. Settings shows the progress, a time estimate and a Stop button.

- Recording pauses while the app is speaking live.
- A kept line is reused when its feeling is within 25% of the one asked for. That covers the eased feeling at peak distress.
- Models without a dial keep one take per line, used at every feeling.
- Lines are stored as float16 in `~/.holding-local/voice-cache/<model>/`, about 50 KB per second of speech. They are deleted together with the model.
- API: `POST /v1/voice-prerender {model, texts, voice, exaggeration}`, `GET /v1/voice-prerender` for progress, and `DELETE /v1/voice-prerender` to stop.

Typed conversations are still spoken live, at the speeds above.

## How the feeling works

- **Feeling dial.** Chatterbox (both engines) and Qwen3-TTS have one. Each parent figure has a feeling setting from 0.25 to 1. The default is 0.55. Set it in Settings → Voice; it appears when an expressive model is in use. Lower sounds calm and even, and higher sounds more animated.
- **Peak distress.** In the "be with" tier, the engine lowers the feeling to 80%, so the parent steadies instead of getting dramatic.
- **Qwen3-TTS** has no number to turn, so the dial picks one of three spoken instructions: calm and steady, warm and gentle, or openly heartfelt.
- **Pre-recorded lines.** With any model other than Kokoro in use, scripted lines are spoken live instead of from the flat Kokoro recordings. The recordings remain the instant fallback if the live voice fails.
- **Where the parent's voice comes from.** Chatterbox, Turbo, CSM and Dia copy the voice from a short reference clip. Qwen3-TTS and Orpheus use their own voices, picked by the parent's gender (from the Kokoro voice, or the heavier part of a blend):
  - In the browser, the clip comes from the parent's own pre-recorded lines. If there are none, Kokoro renders one, and failing that Chatterbox uses its built-in voice.
  - On Holding Local, Kokoro renders the clip in the parent's voice spec, including blends such as `af_nicole:0.55+am_michael:0.45`.

## Holding Local

```
holding-local voice list
holding-local voice download chatterbox-turbo   # resumable; also from Settings
holding-local voice use chatterbox-turbo
holding-local voice delete chatterbox-turbo
```

IDs: `kokoro`, `chatterbox`, `chatterbox-turbo`, and on a Mac `qwen3-tts`, `qwen3-tts-small`, `chatterbox-mac`, `chatterbox-turbo-mac`, `orpheus`, `csm`, `dia`.

API (same pairing token as the rest of `/v1`):

- `GET /v1/voice-models` returns each model with `downloaded`, `bytes`, `group` (`any` or `mac`), `runs_here`, `why_not`, `downloading`, `phase`, `done_bytes` and `total_bytes`, plus `selected` and `disk.free_bytes`.
- `POST /v1/voice-models/{id}/download` downloads in the background. ONNX models resume from `.part` files.
- `DELETE /v1/voice-models/{id}` removes the files and the lines that model recorded. Kokoro is kept.
- `POST /v1/voice-models/select {"id": "qwen3-tts"}` sets the default voice model.
- `POST /v1/audio/speech` accepts any model id and `exaggeration` (0.25 to 1.5). It falls back to Kokoro if the model isn't downloaded or fails, and the `X-Voice-Model` header says which model spoke.

Files:

- Chatterbox and Turbo live in `~/.holding-local/models/chatterbox/` and `.../chatterbox-turbo/`. Chatterbox uses the 4-bit language model with the encoder and decoder at fp32. Turbo uses the 4-bit language model with the 8-bit encoder, embeddings and decoder.
- **Mac voices.** The first Mac voice you download installs `mlx-audio` 0.6.6 into Holding Local's own Python, about 300 MB once, and needs Python 3.11 or newer. Each model then downloads into the Hugging Face cache (`~/.cache/huggingface/hub`), and Holding Local speaks one short line to fetch any helper files and confirm the model works. Deleting a voice removes its folders, plus any helper folder no other downloaded voice still needs. For example, Chatterbox and Turbo on the GPU share the S3 tokenizer. The installer keeps `mlx-audio` when you update (`uv sync --inexact`), and Holding Local reinstalls it if it ever goes missing.

## Browser

- **Chatterbox.** The browser loads Transformers.js 4.3.2 from jsDelivr (`src/voice/chatterbox-version.js`) and runs it on WebGPU. The language model uses q4f16 when the GPU supports shader-f16 and q4 otherwise.
- **Chatterbox Turbo.** Transformers.js has no Turbo class, so `src/voice/chatterbox-turbo-core.js` runs the model card's loop on ONNX Runtime Web 1.31.1, also from jsDelivr, on WebGPU. It keeps the language model's cache on the GPU between steps, and uses the same files as Holding Local. Transformers.js supplies only the tokenizer.
- Both engines keep their weights in the browser's `transformers-cache`, keyed by the Hugging Face URL. The manager measures and deletes them there (`src/voice/models.js`), and the service worker never copies them. The playback and reference-voice code they share is in `src/voice/expressive-provider.js`.

## Tests

- `npm test` covers cache accounting and deletion, the feeling dial, the core helpers, and the Turbo loop with stand-in sessions.
- `cd local && uv run --with pytest pytest -q` covers:
  - the manager endpoints, resumable download and Kokoro fallback;
  - both generation loops with stand-in sessions;
  - the per-model line cache;
  - how each Mac voice gets its voice and feeling;
  - shared helper folders surviving a delete;
  - the "needs a Mac" path.
- The **Voice models** CI workflow runs on every voice change:
  - Real Chatterbox and Turbo through both engines on Linux.
  - Every Mac voice except Dia on a `macos-14` Apple silicon runner. It installs mlx-audio the way Settings does, downloads the voice, speaks two lines, then deletes it.
  - Each job uploads WAV samples as artifacts to listen to.
