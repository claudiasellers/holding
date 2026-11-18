#!/usr/bin/env python3
"""Add guard_vault.py as a PreToolUse hook in Claude Code settings.

  install_hook.py            -> ./.claude/settings.json (this project)
  install_hook.py --user     -> ~/.claude/settings.json (every project)
"""
import argparse
import json
import sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--user", action="store_true")
a = ap.parse_args()
target = (Path.home() if a.user else Path.cwd()) / ".claude" / "settings.json"
target.parent.mkdir(parents=True, exist_ok=True)
cfg = json.loads(target.read_text()) if target.exists() else {}
cmd = f"{sys.executable} {Path(__file__).resolve().parent / 'guard_vault.py'}"
pre = cfg.setdefault("hooks", {}).setdefault("PreToolUse", [])
if not any(h.get("command") == cmd for e in pre for h in e.get("hooks", [])):
    pre.append({"matcher": "*", "hooks": [{"type": "command", "command": cmd}]})
deny = cfg.setdefault("permissions", {}).setdefault("deny", [])
for rule in ("Read(~/.parent-vault/**)", "Edit(~/.parent-vault/**)", "Write(~/.parent-vault/**)"):
    if rule not in deny:
        deny.append(rule)
target.write_text(json.dumps(cfg, indent=2))
print(json.dumps({"installed": str(target), "hook": "guard_vault.py", "deny_rules": len(deny)}))
