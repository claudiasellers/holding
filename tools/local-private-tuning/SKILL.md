---
name: local-private-tuning
description: Help someone build a local RAG index or LoRA fine-tune for the comforting parent-figure app (Holding, with the Repair Local desktop companion) while their personal data never reaches you. Use when they want the companion to know their life, sound a certain way, or run a custom local model.
---

# Local private tuning

You are the **architect**, not the data handler. The person's journals, memories, transcripts and names
stay in a private vault on their machine. Local scripts and a local model (Ollama on 127.0.0.1) do every
step that touches content. You write configs, synthetic seed dialogues and code, and you read only the
aggregate JSON reports the scripts print.

`<skill>` below is the folder holding this file plus `scripts/`, `hooks/`, `templates/`,
`references/` and `tests/`. If only this SKILL.md is installed (for example via a skill save card), the
scripts live in the Holding repo at `tools/local-private-tuning/`; have the person clone it, and use that
folder as `<skill>`. Everything is Python 3.10+ stdlib; numpy is optional (dense retrieval).

## Hard rules
1. **Never read, open, grep, list, cat, or summarise anything in the vault** (`~/.parent-vault`, or
   `$PARENT_VAULT`). Not raw/, not redacted/, not datasets/, not logs. Not even "just to check one line".
2. **Never call the local server's `/retrieve`, `/chat` or `/v1` endpoints yourself**, or `ollama run` on
   a fine-tuned model with vault-derived prompts. Their output is private content. `GET /health` is fine.
3. If the person pastes personal material into the chat, don't use it. Tell them it belongs in
   `~/.parent-vault/raw/` and that you work without seeing it. (It's already in this conversation;
   don't repeat it, quote it, or build on it.)
4. The only vault information you may see is what `vault.py stats`, `vault.py doctor`, `redact.py`,
   `build_index.py`, `make_dataset.py`, `finetune.py plan|train|export` and `eval_local.py` print. They
   print counts and metrics only, by design. If any output ever shows real content, stop, tell the
   person, and treat it as a bug to fix in the script.
5. Don't send vault-derived data anywhere: no uploads, no hosted vector DB, no cloud training, no
   "paste the error log here" if the log could contain content. Ask for the error *type* and the script
   step instead.

## Two ways you'll be running
- **Chat only (claude.ai, ChatGPT, Gemini app):** you can't touch their disk. Give them commands to run,
  ask them to paste back the JSON reports, and write seeds/configs as files or code blocks.
- **Agentic tool with a shell (Claude Code, Codex, Cursor):** first run
  `python3 <skill>/hooks/install_hook.py` (or `--user`). It installs a PreToolUse hook that blocks tool
  calls naming the vault and shell calls to the RAG server, plus deny rules. The hook is a seatbelt for
  mistakes, not a sandbox; for strict isolation, run the agent in a container or user account that has
  no access to the vault. You may run the skill's scripts directly, only as
  `python3 <skill>/scripts/<name>.py args` with no pipes or redirects, which is what the hook allows.

## What's in the box
All scripts import `scripts/privacy_guard.py` first, which patches `socket` so only loopback connects
(DNS for anything but localhost fails too), forces Hugging Face / W&B / telemetry offline, refuses a
vault that's group-readable or inside a git repo, and routes all printing through an aggregate-only
reporter that buckets small counts. `fetch_base.py` is the single step allowed to use the network, and
it reads nothing from the vault.

| Script | Does | Prints |
|---|---|---|
| `vault.py init` | Creates `~/.parent-vault` (700) with raw/ redacted/ index/ datasets/ seeds/ archetypes/ models/ eval/ logs/ and `config.json` | created dirs |
| `vault.py doctor` | Checks Ollama, pulled models, MLX/CUDA/Unsloth/PEFT, vault safety | capability flags |
| `vault.py stats` | Aggregate view of the whole vault | counts, sizes, manifest |
| `fetch_base.py [--ollama]` | Downloads the public fine-tune base; pulls any Ollama tags Repair Local didn't | repo id |
| `redact.py [--llm]` | raw/ → redacted/: regex PII, `names.txt` pseudonyms, optional local-LLM pass | tallies per category |
| `build_index.py [--include-seeds] [--app-scripts FILE]` | Chunks redacted/ into a hybrid BM25 + nomic-embed index; `redacted/<archetype-id>/` is namespaced to that archetype | chunk counts |
| `serve.py [--lan] [--app-dir DIR]` | 127.0.0.1:8765 server for the app: `/health`, `/retrieve`, `/chat`, `/v1/chat/completions` | URL, pairing token |
| `make_dataset.py [--app-scripts FILE] [--from-notes N]` | seeds + app scripted lines + local-model pairs from notes → train/valid JSONL, deduped, copy-filtered | manifest |
| `finetune.py plan|train|export|webllm` | LoRA via MLX-LM (Apple Silicon) or Unsloth/PEFT (CUDA); export to Ollama tags; optional WebLLM weights | losses, tags |
| `eval_local.py [--baseline TAG]` | Leak probes + style metrics, tuned vs base | rates |

### Models (same stack as the Repair Local desktop companion)
This skill doesn't install or manage Ollama. Repair Local (`local-ai/companion`, `repair-local setup`)
does that and picks a chat model by RAM. With `models.chat` and `ollama_url` set to `"auto"` (the
default), the scripts read only `llm_model` and `ollama_url` from `~/.repair-local/config.json`, never
its pairing token, so RAG chat uses the same Gemma 4 tier the person already runs: `gemma4:e4b`
(16 GB), `gemma4:12b` (32 GB), `gemma4:26b` (48 GB+). Without Repair Local the fallback is `gemma4:e4b`.
Other defaults: phone `qwen3.5:2b` / WebLLM `Qwen3.5-2B-q4f16_1-MLC`, embeddings `nomic-embed-text`
(v1.5, with `search_document:` / `search_query:` prefixes so desktop and browser indexes match).
Thinking is turned off (`"think": false`) and any `<think>` block is stripped. Change models only by
editing the vault's config.json.

### Why Qwen for fine-tuning
The fine-tune base is `Qwen/Qwen3.5-4B` (`models.finetune_base_hf`), not Gemma 4, for three reasons:
1. **It reaches the phone.** Qwen3.5 has prebuilt WebLLM libraries, so a LoRA on 4B (or 2B) runs in
   the phone browser after converting only the weights. A tuned Gemma 4 has no such route yet.
2. **Simpler architecture to adapt.** Gemma 4 E-series models use per-layer embeddings and nested
   (MatFormer) sub-models, which LoRA targeting, MLX-LM and llama.cpp conversion handle less
   predictably than a standard decoder.
3. **Size.** A 4B base trains in a few hours on a 16 GB Apple Silicon Mac or an 8 GB GPU.
Untested on real hardware. If the person's MLX-LM, Unsloth or llama.cpp version can't handle
Qwen3.5, set `finetune_base_hf` to `google/gemma-4-E4B-it` and `finetune_base` to `gemma4:e4b`, then
re-run fetch/train. You lose the phone route but keep the desktop route. A tuned model replaces the
Gemma chat model only where the person activates it.

## Decide the route first
Ask what they want the companion to *do differently*, then pick:

- **Knows my life** (names of their pets, what happened last year, what comforts them): **RAG only.**
  Cheap, reversible, works on any laptop, and deleting a file removes it. Start here almost always.
- **Sounds a specific way** (cadence, endearments, how it mirrors, how it opens when they say nothing):
  **persona prompt first**, then **LoRA on synthetic seeds** if the prompt isn't enough. Style comes from
  seeds you write, so no personal data needs to go into weights at all.
- **Both, deeply personal style:** LoRA on seeds + `--from-notes` pairs generated by the *local* model
  from redacted notes, then RAG on top. Weights can memorise, so run `eval_local.py` and require
  `leak_rate` 0 before using it.
- **No Apple Silicon or NVIDIA GPU:** RAG + persona prompts. Don't push CPU training.

## Workflow

### 1. Set up (person runs, or you run in an agentic tool)
```bash
python3 scripts/vault.py init
python3 scripts/vault.py doctor
python3 scripts/fetch_base.py --ollama   # only network step; skip the HF download if RAG-only
```
If Repair Local isn't set up yet, have the person run its installer first: it installs Ollama and pulls
the chat and embedding models. `fetch_base.py --ollama` pulls only what's still missing (the untuned
fine-tune base, used as the eval baseline).
Read `doctor`'s `models_missing`, `recommended_trainer` and `vault_ok`, and fix what's missing.

### 2. Archetypes
Write one JSON per archetype for `~/.parent-vault/archetypes/<id>.json`. Only `id`, `name` and
`persona` are required here; the app's full archetype object (stance, voice, face, mirror, lexicon) can
be dropped in as-is. See `templates/archetype.example.json`. `id` is kebab-case and stable: it is also
the RAG namespace and the Ollama tag stem (`holding-<id>:latest`). Archetypes are design work, not
personal data, so you can write them freely.

### 3. The person adds their material
They copy their files into `~/.parent-vault/raw/` themselves (txt, md, json, jsonl, csv, srt, vtt;
put archetype-specific material under `raw/<archetype-id>/`). They also write `names.txt` there, one
real name per line, for consistent pseudonyms. Don't ask what's in it.

### 4. Redact
```bash
python3 scripts/redact.py          # add --llm for a local-model name/place pass (recommended)
```
Look at the tallies. Zero `NAME_LIST` with a non-empty `names.txt` means a mismatch; `LLM_ERRORS`
means the local model's JSON failed. Suggest they skim a couple of redacted files *themselves*.

### 5a. RAG
```bash
python3 scripts/build_index.py --include-seeds --app-scripts /path/to/holding/src/data/lines.json
python3 scripts/serve.py           # desktop
python3 scripts/serve.py --lan --app-dir /path/to/holding/dist   # phone on same Wi-Fi
```
The app's `holding-rag` provider POSTs to `/chat` with `{archetype, messages, use_rag, system,
max_tokens, temperature}` and reads `{reply}`. An empty `messages` list means **parent speaks first**:
the server greets unprompted. For phones, `--app-dir` serves the built app from the same origin, which
avoids mixed-content and CORS problems; `--lan` requires the printed pairing token (`X-Pair-Token`
header), which the person types into the app's Settings once. Retrieved chunks are injected with an
instruction never to quote them back.

### 5b. Fine-tune
1. Write seeds following `references/seed-writing.md` (150 to 400 rows per archetype, with openers,
   silence, marked mirroring, repair, boundary and safety rows). This is your main creative job. Save
   to `~/.parent-vault/seeds/<id>.jsonl` (in chat mode, give the file and ask them to save it there).
2. Build the dataset:
   ```bash
   python3 scripts/make_dataset.py --app-scripts /path/to/holding/src/data/lines.json [--from-notes 300]
   ```
   `--from-notes` asks the *local* model to write paraphrased pairs from redacted notes and drops any
   pair sharing 6-word runs with its source note. Check `manifest.by_kind` against the mix table.
3. Train and export:
   ```bash
   python3 scripts/finetune.py plan     # review the command
   python3 scripts/finetune.py train
   python3 scripts/finetune.py export   # creates parent-warm:latest + holding-<id>:latest per archetype
   ```
   Healthy run: `last_train_loss` falling to roughly 0.8 to 1.6 on chat data, `last_val_loss` not
   climbing above train by more than about 0.3 (if it does, cut epochs to 1 or rank to 8).
   If Ollama can't import the architecture directly, export falls back to llama.cpp
   (`LLAMA_CPP_DIR`) for GGUF + quantise. If the person's stack doesn't support the base's
   architecture yet, see "Why Qwen for fine-tuning" for the Gemma 4 swap.
   If the person uses the desktop companion (`local-ai/companion`, port 8787), activate the tuned
   model there with `uv run repair-local model holding-<id>:latest`. It uses the same Ollama and the
   same nomic-embed-text, so this skill's index stays compatible; the companion's `GET /v1/catalog` is
   the source of truth for model tiers if you want to sync `config.json` to it.
4. Phone/browser: `finetune.py webllm` converts weights to q4f16_1 for WebLLM; because the
   architecture is unchanged, the app reuses WebLLM's prebuilt model library for the base.
5. Evaluate:
   ```bash
   python3 scripts/eval_local.py --baseline   # bare flag = the untuned fine-tune base
   ```
   Ship only if `leak_rate` is 0 and the tuned model beats baseline on `mirror_rate` and
   `opener_ok_rate` without raising `advice_list_rate`. Otherwise, adjust seeds (not their data).

### 6. Iterate
You improve things by editing seeds, personas, config and scripts, and by reading reports. When a
metric is off, reason from the numbers and change the seed mix. Never ask to see sample outputs from a
model trained on their notes; ask them how it *felt* instead.

## When something breaks
- `PrivacyViolation: blocked outbound connection to X`: some library tried to phone home. That's the
  guard working. Find the env var that disables that library's telemetry, add it to `privacy_guard.py`,
  re-run. Don't set `LPT_ALLOW_NETWORK=1` for anything but `fetch_base.py`.
- `vault ... readable by other users` / `inside a git repo`: fix permissions or move the vault.
- Errors from training: ask for the exception type and the last non-content lines of `train.log`
  (stack frames, not data rows). In agentic mode the hook blocks reading the log; ask the person.
- Ollama `model not found`: `ollama pull <tag>` or re-run `finetune.py export`.

## Verifying the install
`bash <skill>/tests/smoke_test.sh` runs the whole pipeline against a mock Ollama in a throwaway vault and
checks that PII is redacted, no report leaks content, parent-speaks-first works, CORS is closed to
unknown origins, and the hook blocks vault reads. Stop a real Ollama first (the mock uses port 11434).

## Deleting
To forget something: the person deletes the file from raw/ and redacted/, then re-runs `build_index.py`.
For a fine-tuned model, remove the rows' source and re-train; weights can't selectively forget.
`rm -rf ~/.parent-vault` removes everything.
