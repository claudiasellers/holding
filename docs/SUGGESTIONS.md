# Suggested replies

Three short things the user could say, shown just above the typing box. Tap one and it is said. A chip that ends in "…" (like "It started when…") is a sentence starter: it fills the box so the user can finish it.

Code: `src/engine/suggest.js` (pure logic, tested in `test/suggest.test.mjs`), `src/ui/suggestions.js` (chips and scheduling). Settings → You: **Suggested replies** (on/off) and **Let the AI write suggestions** (Automatic / Always / Never).

## The question

How much of the conversation do we need to keep and process to make suggestions that follow it, without costing time or memory on a phone?

## Short answer

Very little. Storage is not the constraint. Compute on a shared GPU is.

- **What we keep:** nothing new. The suggestions read the session's existing in-memory history, and from it build a "gist" of about 0.8 KB. It holds the tier, feeling and strength, what the parent just did, whether the parent asked a question, up to 3 people or places the user has named, and the last 4 turns, each cut to 220 characters. The gist stays this size however long the session runs (there is a test for a 400-turn session). Nothing is written to storage.
- **What a model sees:** about 225 to 260 tokens: a 3-line instruction, the gist, and the last 4 turns. It may write at most 48 tokens back.
- **Rolling summary or last N turns:** the last N turns (N = 4, which is 2 exchanges) plus a summary built by rules, not by a model. "What would I say next" depends mostly on the last exchange. What earlier turns add (who the user has been talking about, how they feel) the rules capture for free with a feeling reading the app already does and a regex for people and places. A model-written rolling summary would cost a whole extra generation every turn to save about 150 tokens of prompt. That trade is backwards on these devices.

## Two layers

| | Rules | Model |
|---|---|---|
| When | Always, the moment anything changes | Only after the user has typed their own words, the parent has finished answering and gone quiet for 0.7 s, and the box is empty |
| Works in | Scripted mode, every device, offline | Gemma 4 in the desktop browser, Holding Local/Ollama/LM Studio. Not the in-browser model on phones unless the user picks "Always" (see below) |
| Cost | Under a millisecond, no memory | ~250-token prompt + ≤48 tokens out, 6 s timeout (9 s for a server) |
| Context-aware via | Feeling, tier, the parent's last move (question, repair, body check, words-back), the people/places the user named, and never repeating something already said | The same gist plus the last 4 turns' actual words |

**Answering her last line.** When the parent's last line ends in a question, the rule chips answer *that* question. `questionKind()` sorts it into one of these kinds:
- a check on a guess at the feeling ("Is that close?"): Yes / Not quite / It's more like…
- a this-or-that ("tell me, or stay a bit longer?")
- the day ("How's today treating you?")
- sleep, or the body
- what's going on
- how it felt ("What was it like to have me stay?")
- a yes/no question, or an open question

"Yes, that's it." appears only after a check or the repair's check, never after an open question. In make-sense, her open questions are answered with the sentence starters.

The rule chips show right away. A model result replaces them only if the talk hasn't moved on and the user isn't typing, so chips never jump under someone's finger. If the model is slow, fails, or every line it writes is rejected, the rule chips simply stay.

## Why the in-browser model is off for suggestions on phones (on "Automatic")

1. **One GPU, one queue.** WebLLM runs one request per model at a time ("Ensures each model only processes one request at a time", [web-llm engine.d.ts](https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.82/lib/engine.d.ts)). A suggestion pass that is still running when the user sends will delay the parent's reply. The pass is aborted the moment the user sends, but on a phone even a short pass is seconds.
2. **It throws away the parent's prompt cache.** WebLLM reuses the KV cache only when a new request continues the same conversation. Otherwise it resets and re-reads the whole prompt (same file, `prefill()` notes). A suggestion request is a different conversation, so the parent's next reply re-reads its system prompt and history. That is cheap on a desktop GPU. On iOS it is the long-prefill pattern that has crashed Safari's GPU process (see `src/mobile/webllm-mobile.js`).
3. **Phones are slow at this size.** In the most recent WebGPU measurements, phones decode at roughly 4 to 17 tokens/s, and on iOS only sub-1B models fit in Safari's per-tab memory ([Llamas on the Web, 2026](https://arxiv.org/html/2605.20706)). The same paper finds WebLLM faster than its own engine at prefill on desktop GPUs, and desktop-class GPUs reach thousands of tokens/s prefill. At ~250 tokens in and ~30 out, a suggestion pass is roughly **1 to 2 s on a desktop** with Gemma 4 E2B. On a phone with Qwen 3.5 2B it is roughly **4 to 10 s**, plus the re-prefill it causes for the parent. These are estimates from the published throughput ranges, not measurements on our devices.

A model on the user's own computer (Holding Local, Ollama, LM Studio) runs in a separate process. It keeps its own cache per request and doesn't compete with the phone's GPU, so "Automatic" allows it even from a phone. `holding-rag` is left out on "Automatic". That server serves a fine-tuned *parent* model and reads the user's private notes, and neither is what a user-voice suggestion needs.

## Safety: words in the user's mouth

A suggestion is something the user would say, so it has its own guard (`suggestionGuard`), on top of the model being told not to:

- Nothing about self-harm or dying. This uses the same `RISK` pattern the engine uses to open the safety flow, plus a broader word list.
- No self-annihilating verdicts ("I'm too much", "everyone leaves"). The app works to never agree with these, and it shouldn't propose them either.
- No caretaking the parent ("are you okay?"), no anger at the coach, no inner-critic lines, no clinical labels.
- Nothing about crying or tears until the user has said they're crying (typed it, or tapped Crying). `state.crying` and `mentionsTears()` come from `src/engine/crying.js`. A sad face on the camera doesn't count. Hand-written chips are filtered, the model is told the rule, and model chips that break it are dropped.
- At most 9 words, no markup, no emoji.

All of the hand-written lines are tested against this guard and against the engine's intent detectors. Suggestions are hidden while the safety sheet is open and after the session ends.

## Tunables

`src/engine/suggest.js`: `RECENT_TURNS` (4), `TURN_CHARS` (220), `MAX_TOPICS` (3), `MAX_WORDS` (9).
`src/ui/suggestions.js`: `MODEL_DELAY_MS` (700), `MODEL_TIMEOUT_MS` (6000 in-browser, 9000 server).

If phone suggestions ever feel too generic, the next step is not a bigger context. It is a larger hand-written bank keyed by the same gist, because that costs nothing at run time.
