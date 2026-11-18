# local-private-tuning

Build a local RAG index or LoRA fine-tune for the Holding comforting-parent app, with a frontier model
(Claude, GPT, Gemini) helping as architect while your personal notes stay on your computer.

Start: `python3 scripts/vault.py init`, then follow SKILL.md. Load SKILL.md into the frontier model as a
skill (or paste it as instructions). In Claude Code, run `python3 hooks/install_hook.py` first.

Layout: `scripts/` (pipeline, stdlib only), `hooks/` (Claude Code guard), `templates/` (archetype + seed
examples), `references/seed-writing.md` (how to write synthetic seeds, marked mirroring), `tests/`
(smoke test with a mock Ollama), `PLAN.md` (threat model and design).
