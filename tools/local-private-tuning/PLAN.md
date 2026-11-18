# Plan: local-private-tuning skill

## Goal
Let a frontier model (Claude, GPT, Gemini…) help someone build a RAG index or a LoRA
fine-tune for the comforting-parent app, while the frontier model never receives the
person's private material (journals, memories, transcripts, voice notes, names).

## Threat model (what "doesn't get any of your data" means here)
| Channel | Risk | Control |
|---|---|---|
| Model reads files in an agentic tool (Claude Code, Cursor, Codex) | Content enters the model context | Vault lives outside the repo; PreToolUse hook blocks any tool call naming the vault; SKILL.md forbids it |
| Script output printed to the terminal | Content leaks through stdout the model reads | Every script prints aggregates only (counts, lengths, category tallies, min-k thresholds). No `--show` flag exists |
| Scripts phoning home (HF Hub, telemetry, pip) | Data or metadata leaves the machine | `privacy_guard` patches `socket` so only loopback connects; HF/TOKENIZERS/WANDB offline env vars forced |
| Person pastes content into the chat | Direct disclosure | SKILL.md tells the model to refuse to read it and point to the local path instead |
| Fine-tuned weights | Memorise private text | Redaction before training, dedupe, and a local canary/regurgitation check |
| Chat UI without a filesystem (claude.ai, ChatGPT) | None of the above apply | Model works purely as architect: writes configs, synthetic seeds, and code the person runs |

Division of labour:
- **Frontier model (data-blind):** designs archetypes, writes synthetic seed dialogues
  (no personal data), writes/edits config, reads aggregate reports, debugs scripts.
- **Local model (data-sighted, via Ollama on 127.0.0.1):** redaction second pass,
  generating Q/A or style pairs from private notes, embeddings, inference, eval judging.

## Workflows
1. `vault.py init` creates `~/.parent-vault` (mode 700) with raw/redacted/index/datasets/models.
2. Person drops their files in `raw/` themselves.
3. `redact.py` writes `redacted/` (regex PII + optional local-LLM name pass). Prints tallies.
4. RAG: `build_index.py` chunks + embeds (Ollama embeddings, BM25 fallback with zero deps).
   `serve.py` exposes `/retrieve` and `/chat` on 127.0.0.1 for the app.
5. Fine-tune: frontier model writes `seeds/*.jsonl` (synthetic archetype dialogues incl.
   parent-speaks-first openers and marked-mirroring lines). `make_dataset.py` merges seeds
   with locally generated pairs from `redacted/`, dedupes, splits. `finetune.py` picks
   MLX-LM (Apple Silicon) or Unsloth/PEFT (CUDA), trains LoRA, fuses, exports GGUF and an
   Ollama Modelfile. `eval_local.py` runs canary/regurgitation and style checks locally.
6. `stats.py` is the only window the frontier model has into the vault.

## Alignment
- Model names live in `config.yaml` (`models:` block). Defaults: Ollama, `qwen3:4b`
  chat/fine-tune base, `nomic-embed-text` embeddings. Swap to the picks from
  "Choose best local AI models" when they land.
- Archetype schema in `templates/archetypes.yaml` matches the app's archetype fields; the
  app talks to `serve.py` at `http://127.0.0.1:8765`.

## Out of scope
Cloud training, any hosted vector DB, uploading datasets anywhere.
