# Holding — master plan

Source of truth for what gets built. Every feature in the request maps to a section here, and each section has a status line that is updated as work lands. Anything without a plan gets a plan here before code.

Design basis: the research doc "Emotion-Coaching Parent App — Research-Grounded Design" (the user's linked page). Section numbers like §5 refer to it.

## 0. How the request was read

| Request wording | Reading used | Why |
|---|---|---|
| "I want the features to be disoriented" | Features oriented to **disorganized** attachment (the hostile-helpless template the research doc is about) | Dictation slip; "disorganized" is the doc's core concept and the only reading that fits |
| "favor 5.2 page" | Build from **the linked page** (written with Fable 5.2) | The link follows; there is no section 5.2 in the doc |
| "builds different comforting parental figure archetypes" | An **archetype builder**: curated presets + generator + full customization, producing one stable figure the user keeps | Reconciles with §6 "single, stable, named figure the user helps shape" |
| "MARKED mirroring through their facial expressions tuned to their facial features" | Gergely & Watson marked affect mirroring rendered on an animated face; the expression amplitudes are computed from each face's geometry | §2 micro-mechanics |
| "AI generated voice so the lines can be played out loud" | On-device TTS by default (browser voices), optional neural TTS running in the browser (Kokoro), no paid service | Local-only requirement |
| "local AI to run everything… no Claude APIs or any third party service bills" | Pluggable backend. Default works with **no AI at all** (scripts). Local options: in-browser model (WebLLM/WebGPU) or the user's own machine (Ollama / LM Studio / llama.cpp, OpenAI-compatible) | |
| "skill … plug it into one of the frontier lab models and it doesn't get any of your data … RAG … fine tune" | Sibling thread builds it; this app consumes its localhost RAG server as a provider | |
| "parent talks first and the user doesn't have to talk or type" | **Hold me** mode opens with the parent speaking and continues on its own paced rhythm; input is optional | §7.1 |
| "scripted options as a fallback" | Full script library per tier × affect × archetype; used when no model, when a model fails validation, and always for the opening line | §7.1 pre-rendered arrival line |
| "available on mobile … no Apple license" | Responsive PWA (installable from the browser, works offline) + Android APK side-load; sibling thread owns packaging | |
| "make sure the plan is being followed" | This file, with per-section status; checked before delivery | |

### Deliberate departure from the research doc

§6 says "Visual presence, not a face" (uncanny valley, face/voice discordance). The user now explicitly wants faces. Mitigations, so the departure does not undo the reason behind the original rule:

1. **Stylized, not photoreal.** Flat illustrated SVG faces sit on the safe side of the uncanny valley.
2. **One state drives every channel.** A single `presence state` object drives words, voice prosody, face, background color and pacing, so the channels cannot disagree (Beebe intermodal concordance). A congruence check rejects a reply whose text affect conflicts with the face state.
3. **Faces are always optional.** An "abstract light" archetype keeps the doc's original breathing-light presence for users who find faces threatening, and any archetype can switch to it.
4. **Anti-resemblance screen.** The builder asks whether the face or voice reminds the user of anyone, and makes every feature one tap to change (§6, §11).

## 1. Architecture

Static web app. Vite 8 + vanilla ES modules, `base: './'`, so `dist/` is plain relative files that run from any static host, from a phone, or inside an Android WebView. No server is required for the core experience.

```
src/
  main.js              boot, routing between screens
  data/schema.js       archetype schema (shared contract)
  data/archetypes.js   curated presets + generator
  data/scripts.js      scripted line library (tier × affect × IPF quality), archetype-voiced
  engine/state.js      presence state: tier, user affect, intensity, warmth dose
  engine/policy.js     deterministic turn policy (length cap, questions allowed, beat delay)
  engine/affect.js     on-device affect reading from taps / text / optional camera
  engine/prompt.js     persona + policy -> system prompt for any LLM
  engine/guard.js      output validation (banned moves from §6) + safety screen
  engine/dialogue.js   orchestrates: state -> policy -> (LLM | script) -> guard -> face+voice
  engine/autoplay.js   parent-speaks-first loop (no input needed)
  face/render.js       procedural SVG face from archetype.face
  face/expressions.js  action-unit model (FACS-style) + presets
  face/tuning.js       per-face amplitude tuning from geometry
  face/mirror.js       marked-mirroring controller
  ai/providers.js      LLM contract + registry
  ai/scripted.js       always-available provider
  ai/webllm.js         in-browser model (WebGPU)
  ai/openai-local.js   Ollama / LM Studio / llama.cpp / any OpenAI-compatible URL
  ai/holding-rag.js    the companion skill's localhost RAG server
  voice/providers.js   TTS contract + registry
  voice/webspeech.js   OS voices (free, on-device on most platforms)
  voice/kokoro.js      Kokoro-82M in browser (optional download)
  ui/*.js              screens: home, builder, hold, talk, keepsakes, settings, safety
  store.js             all data on device (localStorage), export + delete
```

Owned by sibling threads (do not edit from here): `public/manifest.webmanifest`, `public/icons/`, `public/sw.js`, `src/mobile/`, `android/`, `.github/workflows/` (mobile thread); `skill/` (RAG/fine-tune thread).

## 2. Archetype builder

Status: done (8 presets, generator, IPF question, anti-resemblance check, full editor)

- **Presets** (8), each a full figure with stance, IPF emphasis, voice, face, and lexicon. All are defined by what a hostile-helpless parent was not (§1): never fragile, never attacking, bigger-stronger-wiser-kind.
  1. Steady Grandmother — soothing + delight, slow, sparse
  2. Gentle Giant (father figure) — protection, low voice, few words
  3. Warm Aunt — attunement + delight, lightly wry
  4. Calm Elder (nonbinary) — attunement, very even
  5. Protective Mother — protection + soothing
  6. Wise Mentor — encouragement of best self, used more in Make-sense
  7. Cheerful Uncle — delight, warmth dosed low by default (fear-of-compassion users)
  8. Abstract Light — no face, breathing light (the doc's original presence)
- **Generator**: "Make me someone new" samples a coherent archetype (stance, IPF weights, face, voice, name) with constraints that keep it in the comforting range.
- **Customization**: every face feature, voice, pace, warmth dial, name, endearments on/off.
- **IPF onboarding** (§6): asks which of the five qualities the user most wishes they had been met with; weights the figure.
- **Anti-resemblance check**: "Does anything about them remind you of someone?" → highlights the editable features.
- The chosen figure is saved and stays stable (familiarity, §4 social baseline). Changing voice or face never wipes memory.

## 3. Face + marked mirroring

Status: done (render.js, tuning.js, mirror.js; face-lab.html shows every archetype × feeling; unit tests check no-alarm eyes, steady cheeks, tilt, and feature-tuned gains)

**Face model.** Procedural SVG with ~25 geometry parameters from `archetype.face`. Expressions are a FACS-style action-unit vector: AU1 inner brow raise, AU2 outer brow raise, AU4 brow lower, AU5 upper lid raise, AU6 cheek raise, AU7 lid tighten, AU12 lip corner pull, AU15 lip corner depress, AU17 chin raise, AU25/26 lips part / jaw drop, AU43 eyes closed, plus head tilt, gaze, and blink. Each AU moves specific control points.

**Tuning to facial features** (`face/tuning.js`). The same AU value reads differently on different faces, so gains are computed per face:
- Thick or low brows move less visibly → AU1/AU2/AU4 gain raised; thin high-arched brows → lowered so they don't look alarmed.
- Hooded lids hide AU5/AU7 → lid gains raised, and warmth carried more by AU6 cheeks.
- Wide mouths exaggerate AU12/AU15 → mouth gains scaled by 1/width; full lips need less.
- Beards hide the mouth corners and chin → AU15/AU17 carried by brows + head tilt instead; mustache dampens AU12 visibility so cheeks lift more.
- Age adds nasolabial and crow's-feet lines that deepen with AU6/AU12 (older faces read warm through creases, so AU12 gain is lowered).
- Glasses frame the eyes → brow gains slightly raised to clear the frame.
- Round faces get gentler head tilt; long faces more.
The tuning is deterministic and visible in a debug panel in Settings.

**Marked mirroring** (Gergely & Watson 1996; §2, §5 principle 5). The face reflects the user's affect so it is recognizable as *theirs*, while signalling clearly that the parent is not in that state:
1. *Contingent*: triggered by the user's tap, words, or (opt-in) camera; follows within ~450 ms (midrange contingency, not instant).
2. *Marked*: the mirrored expression is exaggerated and stylized (higher amplitude on the affect's signature AUs) but **combined with the parent's own steady baseline**: soft cheeks (AU6) stay on, no lid widening (no AU5 for fear), head tilt, slower onset, and a brief duration.
3. *Ostensive cue first*: a small eyebrow flash and a soft ripple of the background ("this is for you") before the mirror.
4. *Returns to holding*: after the hold, the face eases back to the parent's steady-warm state, modelling regulation.
5. *Per-affect marked forms*: sad → inner brows up, mouth corners down, eyes soft; scared → concerned brows, **no** wide eyes, slow blink; angry → brow lower with soft mouth, never tight lips or bared teeth; ashamed → soft gaze down then back up to meet; numb → stillness, slow blink, low amplitude; lonely → tilt + soft sad; overwhelmed → slow blink + exhale.
6. Markedness slider (0 = subtle, 1 = very marked) in the builder; defaults per archetype.
7. Never mirrors contempt, disgust or panic (those are the hostile and frightened parent's faces).

**Affect sources** (state tracker, §9: driven mainly by taps):
- Tiles (primary), text lexicon classifier (on-device), optional camera via MediaPipe Face Landmarker blendshapes (on-device, opt-in, off by default, never stored).

## 4. Voice

Status: done (webspeech, kokoro, openai-speech for Holding Local; prerecorded opening lines via the mobile layer)

- Default: Web Speech API with OS voices (free; on-device on iOS, macOS, Android, Windows). Voice picked per archetype by gender + name hints, user-overridable.
- Optional: Kokoro-82M via kokoro-js, downloaded once (~90 MB, q8) and run in the browser; higher quality and fully local.
- Prosody per tier (§6 table): Be with = slow, low, falling; Name = warm/steady; Make sense = normal. Rate/pitch = archetype voice × tier multiplier.
- Pauses: lines are split into phrases with deliberate silences ("…" = 700 ms).
- Lip sync: mouth AU25/26 driven by speech boundary events (Web Speech) or audio level (Kokoro).
- Voice on/off and captions always visible.

## 5. Dialogue engine

Status: done (guard + policy unit-tested; repair, role reversal, too-much, critic, anger-at-coach, safety all scripted and model-optional)

- **Presence state**: tier (bewith/name/makesense/ordinary), user affect + intensity, words-back flag, warmth dose, misses count.
- **Turn policy** (deterministic, §9): per tier sets max sentences, whether one question is allowed, beat delay before speaking (Be with: 1.8–3 s), warmth. LLMs never choose these.
- **Generation**: provider → guard → fallback to scripts on failure, timeout (Be with: 6 s), or banned content.
- **Guard** (§6 "never does"): rejects "calm down", "stop crying", "why", "bright side", the coach's own distress or need, "I'm sorry you feel", crisis-line-and-leave, agreement with "I'm too much"/"everyone leaves", claims to be human/therapist. Truncates to policy length.
- **Repair** (§7.5, `src/engine/repair.js`): "That missed" control always visible, plus self-detected misses (silence after a parent turn in conversation, sharp language, the user apologizing). The script is fixed: **name the specific miss** from what the parent actually did on its last turn (asked too soon, jumped to fixing, said too much, named the wrong feeling, stock answer, kept it light…), **own it** once without groveling, **check** ("Is that it, or something else?"; in Be-with a tap-able statement with one-tap answers, since questions are off), then **re-attune at the right tier** once the user answers: do the opposite of the miss (tier steps down, no questions / no techniques / fewer words for the next turns; a generated reply that breaks the promise is rejected), or reflect the user's own correction. With an AI on, the re-attune is generated from the miss and the correction; the repair line itself is always scripted. Each repair is logged with how it came back (Memory → Repairs).
- **Role-reversal refusal**: detects "are you ok / sorry I'm so much" → scripted decline.
- **Safety** (§8): on-device risk lexicon on every user turn; on signal the coach stays in voice, asks directly, shows one-tap 988 call/text and a chosen person, and stays. No means information ever.

## 6. Parent speaks first ("Hold me")

Status: done (verified: 30 s with no input produces paced lines; ?mode=hold shortcut opens straight into it)

- One big button on Home. The parent's opening line plays immediately (scripted, so zero latency), face arrives in holding state.
- Autoplay loop: the parent keeps a paced rhythm with no input required: presence lines, permission statements, an invitation to self-touch, a breathing visual synced to the face's slow breath, and "Still here" every 25–40 s. Silence is part of the script.
- Input is optional at all times: tiles (one thumb), typing, or speaking. Any input moves to contingent mode, then autoplay resumes after quiet.
- Words-back detection → offer: "tell me what happened, or stay a bit longer."
- Close + metaprocess (§7.1): "What was it like to have me stay?" and save a keepsake line.

## 7. Scripted library

Status: done (438 lines; every line passes the guard in tests; exported per archetype for voice prerender and RAG)

- Lines per tier × affect, plus openings, still-here, permissions, self-touch, body budget, names, role-reversal declines, repairs, critic protection, close/metaprocess, ordinary-day check-ins, evening delight, safety.
- Each line tagged with IPF quality so archetypes pick lines matching their emphasis; archetype endearments and signature lines are mixed in.
- Lines obey §6 rules and are checked by the same guard as model output (unit test).

## 8. Local AI

Status: done. WebLLM 'auto' (desktop gemma-4-E2B, phones from the device ladder), Ollama default gemma4:e4b, Holding Local one-tap setup, RAG server with pairing token

- Providers: `scripted` (default, no download), `webllm` (in browser, WebGPU; small instruct models), `openai-local` (Ollama/LM Studio/llama.cpp at a user-set URL), `holding-rag` (companion skill server at 127.0.0.1:8765).
- Settings shows availability, download progress, and a test button. Model name is a free field so fine-tuned Ollama tags work.
- No Claude API or paid service is wired in. A "custom OpenAI-compatible URL" exists only because Ollama and friends use that protocol; whatever URL the user types is their choice.

## 9. Mobile

Status: integrated (PWA, offline cache, Android APK workflow, pairing, install sheet; see docs/MOBILE.md)

- Responsive layout designed phone-first (one thumb, large tiles, safe areas).
- PWA install + offline cache (mobile thread), Android APK side-load via Capacitor (mobile thread).
- On-device AI on phones via WebLLM where WebGPU exists; otherwise scripts or the home-computer server over LAN.

## 10. Companion skill (RAG / fine-tune)

Status: integrated (tools/local-private-tuning/, provider 'holding-rag'). Contract: POST /chat {archetype, messages, use_rag, system, max_tokens, temperature} → {reply}; GET /health.

## 11. Privacy + data

All data on device (localStorage), memory panel to view/delete, export JSON, wipe-all. No analytics. Camera frames never leave the device or get stored.

## 12. Testing

- Unit: guard rejects banned lines; every script line passes the guard; tuning math; policy caps.
- Browser (Playwright): builder → hold flow with no input for 60 s; mirroring changes face on tile tap; settings provider switch; phone viewport 390×844 and desktop 1280×800 screenshots.

## Status log

- 2026-11-18: plan written; contracts shared with mobile and skill threads.
- 2026-11-18: all sections built; 10 unit tests pass; phone (390×844) and desktop (1280×800) browser runs clean; preview published; companion vendored at local/.

## Open items

- Push to GitHub once the repo exists (git history is ready locally).
- Run `npm run voice:prerender` on a machine with the Kokoro model to ship instant offline opening lines.
- Real-device checks: iPhone Safari (WebGPU, audio unlock), Android Chrome (WebLLM), camera mirroring on phones.
- User research to tune timing values (beats, autoplay gaps, markedness defaults), which are starting parameters, not findings.
