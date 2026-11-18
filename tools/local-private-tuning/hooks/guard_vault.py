#!/usr/bin/env python3
"""Claude Code PreToolUse hook: keep the frontier model out of the private vault.

Blocks any tool call (Read, Grep, Glob, Edit, Write, Bash, NotebookEdit, MCP file tools…) whose input
mentions the vault path, EXCEPT Bash commands that run this skill's own scripts, which print aggregates
only. Install with install_hook.py, or add to .claude/settings.json:

  {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command",
     "command": "python3 /path/to/local-private-tuning/hooks/guard_vault.py"}]}]}}

Exit code 2 = block; the reason goes back to the model.
"""
import json
import os
import re
import sys
from pathlib import Path

VAULT = Path(os.environ.get("PARENT_VAULT", Path.home() / ".parent-vault")).expanduser()
SKILL_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
ALLOWED_SCRIPTS = {"vault.py", "redact.py", "build_index.py", "make_dataset.py", "finetune.py",
                   "eval_local.py", "serve.py", "fetch_base.py", "privacy_guard.py"}
PORT = os.environ.get("LPT_PORT", "8765")
SHELL_META = re.compile(r"[|;&`<>]|\$\(")


def needles():
    s = {str(VAULT), str(VAULT.resolve()), ".parent-vault"}
    home = str(Path.home())
    if str(VAULT).startswith(home):
        s.add("~" + str(VAULT)[len(home):])
        s.add("$HOME" + str(VAULT)[len(home):])
    return s


def bash_is_skill_script(cmd: str) -> bool:
    """Allow `python3 <skill>/scripts/X.py args` with no pipes, redirects, or command chaining."""
    if SHELL_META.search(cmd):
        return False
    parts = cmd.split()
    if len(parts) < 2 or not re.match(r"^(python3?|uv run python3?|py)$", parts[0]):
        return False
    script = Path(os.path.expanduser(parts[1]))
    return script.name in ALLOWED_SCRIPTS and script.resolve().parent == SKILL_SCRIPTS


def main():
    try:
        ev = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    tool = ev.get("tool_name", "")
    inp = json.dumps(ev.get("tool_input", {}))
    hit = any(n in inp for n in needles())
    if tool == "Bash":
        cmd = ev.get("tool_input", {}).get("command", "")
        if bash_is_skill_script(cmd):
            sys.exit(0)
        # Also block generic content dumps that would read the vault via env var or cd
        if re.search(r"(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):%s/(retrieve|chat|v1)" % PORT, cmd):
            print("Blocked: calling the local RAG server from the model's shell would return private "
                  "chunks into the model's context. Test it with GET /health only.", file=sys.stderr)
            sys.exit(2)
        if hit or re.search(r"\bPARENT_VAULT\b", cmd):
            print("Blocked: this command touches the private vault. Use the skill's scripts "
                  "(e.g. python3 scripts/vault.py stats), which print aggregates only.", file=sys.stderr)
            sys.exit(2)
        sys.exit(0)
    if hit:
        print(f"Blocked: {tool} would expose files in the private vault to the model. "
              "Ask the person to run the local script instead; read only its aggregate output.", file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
