# Local AI stack for Holding

_Current as of 18 Nov 2026. Model tags and WebLLM ids were checked against the Ollama library and the published `@mlc-ai/web-llm` package, not just blog posts._

## The short version

| Job | Desktop (installed companion) | Browser / phone (nothing installed) | License |
|---|---|---|---|
| Parent dialogue (LLM) | **Ollama `gemma4:e4b`** (tiered below) | **WebLLM `Qwen3.5-2B-q4f16_1-MLC`** | Apache 2.0 (Gemma 4, Qwen3.5) |
| Voice (TTS) | **Kokoro-82M v1.0** via `kokoro-onnx` | **Kokoro-82M** via `kokoro-js` 1.2.1 | Apache 2.0 weights, MIT code |
| Expressive voice upgrade (GPU) | Chatterbox Turbo (350M, `[sigh]`/`[laugh]` tags, exaggeration knob) | — | MIT |
| Listening (STT, optional) | `faster-whisper` small / base | Whisper-base or Moonshine-base via transformers.js 4.3.x | MIT |
| Face tracking for marked mirroring | (runs in the page either way) | **MediaPipe Face Landmarker**, `@mediapipe/tasks-vision` 1.2.x, 52 blendshapes | Apache 2.0 |
| Embeddings for the RAG skill | Ollama `nomic-embed-text` (v1.5) | same model as ONNX via transformers.js | Apache 2.0 |
| Zero-download fallback | scripted lines + OS `speechSynthesis` | same | — |

Two ways to run locally; the app supports both through its own provider layer (`holding/src/ai/`, `holding/src/voice/`):

1. **Browser mode.** Everything runs in the page on WebGPU. First visit downloads ~2.3 GB (LLM) + ~90 MB (voice) + ~4 MB (face) once, then it works offline. Works on desktop Chrome/Edge, Android Chrome, and recent iOS Safari with WebGPU. No install at all, which is the easiest path given there's no Apple developer licence.
2. **Desktop companion ("Holding Local").** One installer sets up Ollama + a small server on `127.0.0.1:8787` that serves the app and OpenAI-compatible `/v1/chat/completions`, `/v1/audio/speech`, `/v1/audio/transcriptions`. Bigger, warmer models; and with phone access on, a phone can use the computer's models by scanning a QR code.

Nothing in either mode calls Anthropic, OpenAI, ElevenLabs or any paid API.

## 1. Dialogue model

What matters here is not coding or reasoning benchmarks but: staying in a warm parental voice for a whole session, short spoken-length turns, following a persona system prompt, and not drifting into therapist-speak or lists. Reasoning ("thinking") modes are actively harmful here: they add seconds of latency before the parent speaks and sometimes leak into the reply.

**Why Gemma 4 for desktop.** This is my judgement, not a benchmark result (no standalone roleplay/empathy benchmark exists for these sizes; BenchLM's roleplay page says so, and EQ-Bench's table didn't load for small models). Gemma 4 has no thinking mode to fight, is Apache 2.0 since this generation, and its small "E" models are built for laptops and phones. Qwen3.5 is the stronger general model per parameter and tops BenchLM's roleplay-proxy list at 27B, but it is tuned toward reasoning/agentic use and needs thinking forced off. The companion ships both and the app should let the person A/B them; swap the default if Qwen sounds warmer to them.

### Desktop tiers (Ollama)

| Hardware | Model | Download | Notes |
|---|---|---|---|
| 8 GB RAM, no GPU | `qwen3.5:4b` (think off) | 3.3–4.0 GB | Smallest that holds a persona well; `qwen3.5:2b` (2.7 GB) if it's slow |
| **16 GB RAM / Apple Silicon 16 GB / 8 GB VRAM (default)** | **`gemma4:e4b`** | 6.6–9.5 GB | Text+image+audio capable; 128K context |
| 12–16 GB VRAM or 32 GB Mac | `gemma4:12b` | 7.7–8.0 GB | Noticeably richer phrasing |
| 24 GB VRAM or 48 GB+ Mac | `gemma4:26b` (MoE, 3.8B active) or `qwen3.5:27b` | 16–20 GB | 26b is MoE so it's fast for its size |

Apple Silicon: the `-mlx` tags (`gemma4:e4b-mlx` etc.) exist in Ollama and are usually faster on Macs. The installer picks the tier from RAM/VRAM automatically and the person can override.

Settings: `temperature 0.8`, `top_p 0.95`, `num_ctx 8192`, `"think": false` for Qwen3.5. Keep replies to 1–3 sentences via the system prompt; that also keeps TTS latency low.

### Browser / phone tiers (WebLLM, verified in `@mlc-ai/web-llm` 0.2.87+)

| Device | WebLLM model id | GPU memory needed |
|---|---|---|
| Low-end phone (≤6 GB RAM) | `Qwen3.5-0.8B-q4f16_1-MLC` | 1.6 GB |
| **Typical phone (8 GB+) — default** | **`Qwen3.5-2B-q4f16_1-MLC`** | 2.2 GB |
| Roleplay-tuned alternative | `Hermes-3-Llama-3.2-3B-q4f16_1-MLC` | 2.3 GB (Llama 3.2 community licence) |
| Laptop browser | `gemma-4-E2B-it-q4f16_1-MLC` or `Qwen3.5-4B-q4f16_1-MLC` | 3.4 / 3.9 GB |

All WebLLM builds use a 4K context, which is plenty for a session if older turns are summarised. Known issue: Qwen3.5 can start "thinking" on long inputs even with `/no_think`, so pass `extra_body: { enable_thinking: false }` and strip any `<think>…</think>` text (the companion already does this server-side for Ollama). Pin the script to `@mlc-ai/web-llm@0.2.87` (older than two weeks, has all of the above).

**Fine-tunes run in the browser too.** A LoRA/full fine-tune of Qwen3.5-2B or -4B keeps the same architecture, so `mlc_llm convert_weight` + `gen_config --quantization q4f16_1` produces weights that reuse WebLLM's prebuilt Qwen3.5 model library. Desktop fine-tunes go to Ollama as GGUF. (Shared with the RAG/fine-tune skill thread.)

## 2. Voice

**Kokoro-82M v1.0 is the default everywhere.** It's tiny (88 MB int8 / ~310 MB fp32), Apache 2.0, faster than real time on CPU, runs in the browser via `kokoro-js`, and its best voices are genuinely warm. It has no emotion tags; warmth comes from voice choice, a slightly slower speed (0.9–0.95), and short sentences with commas and ellipses for pauses.

Voice per archetype in the app (the companion accepts the archetype id directly as `voice`; blends need the companion, so the browser uses the closest single voice):

| Archetype | Companion voice | Browser (kokoro-js) | Speed |
|---|---|---|---|
| steady-grandmother | `bf_emma` | `bf_emma` | 0.88 |
| gentle-giant (father) | `am_michael` | `am_michael` | 0.88 |
| warm-aunt | `af_heart` (Kokoro's best, grade A) | `af_heart` | 0.95 |
| calm-elder (nonbinary) | blend `af_nicole:0.55+am_michael:0.45` | `af_nicole` | 0.86 |
| protective-mother | blend `af_bella:0.6+af_heart:0.4` | `af_bella` | 0.93 |
| wise-mentor | `bm_george` | `bm_george` | 0.88 |
| cheerful-uncle | `am_puck` | `am_puck` | 1.0 |
| abstract-light | blend `af_nicole:0.7+af_sky:0.3` | `af_nicole` | 0.85 |

Kokoro voices are trained as male or female, so the nonbinary elder is a style blend of the two that sits in between; worth listening to and adjusting the weights.

Upgrades and alternatives:
- **Chatterbox Turbo** (Resemble AI, MIT, 350M, English): paralinguistic tags like `[sigh]` `[chuckle]`, an `exaggeration` control, and zero-shot voice cloning. Best for "a real parent's tenderness" if there's an NVIDIA GPU or Apple Silicon; ~1× real time on an M4 GPU, too slow on plain CPU. Not built in yet; a natural later add-on behind the same `/v1/audio/speech`.
- **Supertonic 3** (~99M, 31 languages, `<sigh>`/`<breath>` tags, ONNX with a browser demo, very fast on CPU). Good for non-English users, but OpenRAIL-M licence and Supertone is archiving the repo, so not the default.
- **Qwen3-TTS 0.6B/1.7B** (Apache 2.0): natural-language emotion/prosody instructions ("speak softly, reassuring"), but GPU-oriented and slower.
- **Piper** for very old machines (GPL engine).
- Avoid XTTS-v2 and F5-TTS weights: non-commercial licences.
- Last resort: the OS's own `speechSynthesis` voices, which are offline on most systems.

Voice cloning a real parent's voice is technically possible with Chatterbox; if the app ever offers it, it should be the person's own recordings only.

## 3. Listening (optional)

The person never has to speak (parent-first mode), so STT is optional.
- Browser: Whisper-base (~75–150 MB) or Moonshine-base via transformers.js on WebGPU/WASM.
- Desktop: `faster-whisper` `small` (CPU int8) — wired into the companion's `/v1/audio/transcriptions`. Parakeet TDT 0.6B v3 (CC-BY-4.0) is more accurate and fast but heavier to package; a later upgrade.
- **Do not use Chrome's `webkitSpeechRecognition` in local mode**: it streams audio to Google's servers.

## 4. Face tracking for marked mirroring

**MediaPipe Face Landmarker** (`@mediapipe/tasks-vision`, Apache 2.0) runs in-page on the GPU delegate at 30+ fps on phones, model ~3.6 MB, and outputs 478 landmarks, a head-pose matrix, and **52 ARKit-style blendshapes** (`browInnerUp`, `mouthFrownLeft`, `mouthSmileRight`, `eyeSquintLeft`, `jawOpen`…). That's the right signal for marked mirroring, because the avatar should reflect the *expression* (contingent, congruent), not the identity.

Practical mapping that works with blendshapes:
- Sadness ≈ `browInnerUp` + `mouthFrownL/R` + `mouthPressL/R`, low `mouthSmile`.
- Worry/fear ≈ `browInnerUp` + `eyeWideL/R` + `mouthStretchL/R`.
- Anger/tension ≈ `browDownL/R` + `noseSneerL/R` + `jawForward`/`mouthPress`.
- Smile/relief ≈ `mouthSmileL/R` + `cheekSquintL/R`.
- Smooth with an EMA (~250 ms), mirror after a 300–700 ms contingent delay, at reduced amplitude (~40–60 %) blended with the archetype's soothing baseline. That blend of "I see your feeling" plus "and I'm calm" is the *marking*.
- Run it locally only; frames never leave the device. No other model is needed for this, so it isn't part of the download size question.

## 5. One-click download and run

**Browser mode** needs no packaging: the app is a PWA, and the client downloads and caches models on first use with a progress bar. iPhone users add it to the Home Screen from Safari; Android users get an install prompt. No App Store and no Apple licence needed.

**Desktop companion** (`holding/local/`, built and tested; see its README for the full API):
- macOS: double-click `Install Holding Local.command`. Linux: `./install.sh`. Windows: double-click `Install Holding Local.bat` (runs `install.ps1`).
- The installer: installs `uv` (self-contained Python) and Ollama if missing, detects RAM/VRAM and pulls the matching model, downloads Kokoro (88 MB int8), creates a "Start Holding Local" launcher, then opens `http://127.0.0.1:8787`.
- Phone access: "Start with phone access" runs `tailscale serve --bg 8787` and shows a QR code for `https://<computer>.<tailnet>.ts.net/#pair=CODE` plus a typeable pairing code (`K7QM-2XPA`), because an iPhone Home Screen app doesn't share storage with Safari. Plain Wi-Fi (`--lan`) also works but phones block camera, mic and install on http. Off by default; everything not on the computer itself needs the code.
- Total disk: ~7–10 GB for the default tier.

Later, if wanted: wrap the companion in a Tauri app for a true `.dmg`/`.exe`, which would need code-signing to avoid OS warnings. The script installers avoid that cost.

## What was tested

- The companion's chat proxy (streaming and not), think-stripping, thinking-off for Qwen, pairing-code auth from LAN and through a proxied Host, rate limiting, CORS preflight, static app serving with SPA fallback, the pairing page, embeddings, and setup's already-downloaded paths: all run against a mock Ollama, plus 9 automated tests (`uv run --with pytest pytest -q`).
- `/v1/audio/speech` was run end to end with the real Kokoro v1.0 int8 ONNX model (about 0.8 s per sentence on this CPU), including voice blends, archetype ids, OpenAI aliases and MP3 output. The voice styles in that test were placeholders because the build machine couldn't reach GitHub or Hugging Face, so the real download step and the real voice timbre still need a first run on the Mac.
- Not run here: a real Ollama model, Whisper transcription (its weights come from Hugging Face), and the Mac/Windows installers themselves. These are the first things to try in the morning: double-click the installer, then `uv run holding-local status`.

## Sources

- [Ollama library: gemma4](https://ollama.com/library/gemma4), [qwen3.5](https://ollama.com/library/qwen3.5)
- [Best Ollama Models (Nov 2026)](https://localaimaster.com/blog/best-ollama-models)
- [Best small local LLMs 2026](https://www.promptquorum.com/local-llms/small-local-llm-models)
- [BenchLM roleplay ranking (Nov 2026)](https://benchlm.ai/best/roleplay)
- WebLLM `src/config.ts` and `@mlc-ai/web-llm` 0.2.87/0.2.89 on npm; [Qwen3.5 in WebLLM issue #778](https://github.com/mlc-ai/web-llm/issues/778)
- [Best Local TTS Models 2026, licences checked](https://www.yaps.ai/blog/best-local-tts-models); [Supertonic repo](https://github.com/supertone-inc/supertonic); `kokoro-js` 1.2.1 and `kokoro-onnx` 0.6.1 packages
- [Parakeet vs Whisper vs Nemotron 2026](https://openwhispr.com/blog/parakeet-vs-whisper-vs-nemotron)
