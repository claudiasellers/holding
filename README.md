# Holding

A steady, comforting parent figure who stays with you when you fall apart. You choose or build the figure (face, voice, manner); their face mirrors your feeling back in a **marked** way (clearly yours, while they stay steady); they speak out loud; and they can **talk first** so you never have to type or say anything.

Everything runs on your own devices. No Claude API, no paid service, no account.

Design basis: *Emotion-Coaching Parent App — Research-Grounded Design* (hostile-helpless / disorganized attachment, Gottman emotion coaching, Gergely & Watson marked mirroring, Beebe midrange contingency, Tronick repair). The build plan and its status live in [PLAN.md](PLAN.md).

## What's in it

| Feature | Where |
|---|---|
| 8 parent archetypes + "make someone new" generator + full face/voice/manner editor | `src/data/archetypes.js`, `src/ui/builder.js` |
| Procedural SVG faces with FACS-style action units | `src/face/render.js`, `src/face/expressions.js` |
| Expression gains tuned to each face's brows, lids, mouth, beard, glasses, age and shape | `src/face/tuning.js` |
| Marked mirroring (contingent beat, ostensive cue, exaggerated signature, parent's own steady cues kept, return to holding) | `src/face/mirror.js` |
| Face lab: every archetype × every mirrored feeling on one page | `face-lab.html` |
| "Hold me": parent speaks first and keeps a paced presence; tiles, typing and voice are all optional | `src/engine/dialogue.js`, `src/ui/session.js` |
| Deterministic turn policy (length, questions, pacing, warmth) and an output guard for every line | `src/engine/policy.js`, `src/engine/guard.js` |
| 438 scripted lines (fallback and instant opening lines) | `src/data/lines.json` |
| Repair ("That missed"), role-reversal refusal, critic protection, safety flow with 988 and your person | engine + session |
| Keepsakes, new-rule cards with dated evidence, repair log, no streaks | `src/ui/memory.js` |
| Optional camera mirroring (MediaPipe, on-device, opt-in) | `src/engine/camera.js` |
| Voices: device voices (free), Kokoro neural voice in the browser, or Holding Local | `src/voice/` |
| AI: scripts only, in-browser model (WebLLM/WebGPU), Ollama/LM Studio/any OpenAI-compatible local server, or the private RAG/fine-tune server | `src/ai/` |
| Phone: installable PWA, offline, Android APK, pairing with your computer | `src/mobile/`, `android/`, `docs/MOBILE.md` |
| Mac widget: the parent in a small floating window from the menu bar, no Apple license needed | `mac-widget/` |
| Private RAG + fine-tuning skill for frontier-model-assisted setup without sharing your data | `tools/local-private-tuning/` |

## Run it

```bash
npm install
npm run dev          # http://localhost:5173 (also on your LAN for a phone)
npm run build        # static files in dist/, all paths relative
npm test             # guard, library, tuning, mirroring, provider tests
```

`dist/` runs from any static host. GitHub Pages deploys from `.github/workflows/pages.yml`; the Android APK builds from `.github/workflows/android.yml`. See [docs/MOBILE.md](docs/MOBILE.md) for getting it on a phone without the App Store.

On a Mac, put the parent on your desktop as a widget with one line in Terminal (details in [mac-widget/README.md](mac-widget/README.md)):

```bash
curl -fsSL https://raw.githubusercontent.com/claudiasellers/holding/main/mac-widget/install.sh | bash
```

## Local AI choices

| Where | Default | Notes |
|---|---|---|
| No model | Scripted lines | Instant, offline, every device. Always the fallback. |
| In the browser, desktop | `gemma-4-E2B-it-q4f16_1-MLC` (WebLLM) | One-time download, then offline. |
| In the browser, phone | Qwen 3.5 2B / 0.8B or Hermes 3 3B, picked per device | iPhones get the compact model; failures fall back automatically. |
| Your computer (Ollama) | `gemma4:e4b` (16 GB) · `qwen3.5:4b` (8 GB) · `gemma4:12b` (32 GB) | Settings → "Use my computer (Holding Local)". |
| Your fine-tuned parent | `holding-<archetype-id>:latest` | Built with `tools/local-private-tuning`. |

Every model reply passes the same guard as the scripts; anything off-policy, slow, or broken is replaced by a scripted line, so the parent never goes silent.

## Not therapy

Holding is an AI companion. It is not a person, not a therapist and not an emergency service. In the US, call or text 988.
