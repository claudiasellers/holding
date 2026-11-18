#!/usr/bin/env bash
# End-to-end smoke test against a mock Ollama on 127.0.0.1:11434 in a throwaway vault.
# Usage: bash tests/smoke_test.sh     (stop a real Ollama first, or it will be used instead)
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"; SK="$R/scripts"; H="$R/hooks"
export PARENT_VAULT="$(mktemp -d)/vault"
python3 "$R/tests/mock_ollama.py" & MOCK=$!; trap 'kill $MOCK ${SRV:-} 2>/dev/null; rm -rf "$(dirname "$PARENT_VAULT")"' EXIT
sleep 1
fail(){ echo "FAIL: $1"; exit 1; }
python3 "$SK/privacy_guard.py" >/dev/null || fail "network lock"
python3 "$SK/vault.py" init >/dev/null
mkdir -p "$PARENT_VAULT/raw/steady-grandmother" "$PARENT_VAULT/apps"
printf 'I called Jenny at 555-123-4567, jenny@example.com, 42 Maple Street.\nMy cat Biscuit sits with me when I am sad.\n' > "$PARENT_VAULT/raw/j.txt"
echo "Grandma hummed while making tea." > "$PARENT_VAULT/raw/steady-grandmother/tea.md"
echo Jenny > "$PARENT_VAULT/names.txt"
cp "$R/templates/archetype.example.json" "$PARENT_VAULT/archetypes/steady-grandmother.json"
cp "$R/templates/seeds.example.jsonl" "$PARENT_VAULT/seeds/steady-grandmother.jsonl"
APP=$(mktemp -d)/lines.json; echo '{"opening":[{"t":"There you are, {endearment}. I saved you the warm seat.","ipf":0.4,"w":1}],"stillHere":[{"t":"I am still here… no rush."}],"affect":{"sad":{"name":[{"t":"Oh, {endearment}, that sounds so sad."}],"bewith":[{"t":"I will sit right here with you."}]}},"safety":{"stay":[{"t":"Please reach a crisis line now, I will stay with you."}]}}' > "$APP"
OUT=$(python3 "$SK/redact.py" --llm); echo "$OUT" | grep LLM_PERSON >/dev/null || fail "llm redaction"
grep -qE "Jenny|555-123|example.com|Maple|Biscuit" "$PARENT_VAULT/redacted/j.txt" && fail "PII survived redaction"
python3 "$SK/build_index.py" --include-seeds --app-scripts "$APP" | grep '"dense": true' >/dev/null || fail "dense index"
python3 "$SK/make_dataset.py" --app-scripts "$APP" --from-notes 2 | grep '"app_script": 5' >/dev/null || fail "dataset"
grep -q "There you are, love. I saved" "$PARENT_VAULT/datasets/"*.jsonl || fail "endearment token fill"
grep -q "{endearment}" "$PARENT_VAULT/datasets/"*.jsonl && fail "token left in dataset"
ALL=$(python3 "$SK/vault.py" stats; python3 "$SK/vault.py" doctor)
echo "$ALL" | grep -qE "Jenny|Biscuit|Maple|hummed" && fail "content leaked into a report"
python3 "$SK/serve.py" --port 8799 >/dev/null & SRV=$!; sleep 1.5
curl -s -XPOST 127.0.0.1:8799/chat -d '{"archetype":"steady-grandmother","messages":[]}' | grep '"reply"' >/dev/null || fail "parent-speaks-first"
curl -s -XPOST 127.0.0.1:8799/chat -d '{"archetype":"steady-grandmother","messages":[{"role":"user","content":"tea"}]}' | grep 'RAG=True' >/dev/null || fail "rag chat"
curl -s -XOPTIONS 127.0.0.1:8799/chat -H 'Origin: https://evil.example' -D - -o /dev/null | grep -qi allow-origin && fail "CORS too open"
echo "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$PARENT_VAULT/raw/j.txt\"}}" | python3 "$H/guard_vault.py" 2>/dev/null && fail "hook let a vault Read through"
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"python3 $SK/vault.py stats\"}}" | python3 "$H/guard_vault.py" || fail "hook blocked a skill script"
echo "ALL SMOKE TESTS PASSED"
