#!/usr/bin/env python3
"""Vault management. Subcommands print aggregates only.

  vault.py init      create ~/.parent-vault (mode 700) and a default config.json
  vault.py stats     aggregate-only report of what is in the vault (safe to show a frontier model)
  vault.py doctor    check local runtimes: Ollama, pulled models, MLX / CUDA / Unsloth / PEFT
"""
import argparse
import importlib.util
import json
import os
import platform
import shutil
import sys
import urllib.request

import privacy_guard as pg

SUBDIRS = ["raw", "redacted", "index", "datasets", "seeds", "archetypes", "models", "eval", "logs"]


def cmd_init(_):
    v = pg.DEFAULT_VAULT
    v.mkdir(parents=True, exist_ok=True)
    os.chmod(v, 0o700)
    pg.assert_private_dir(v)
    for s in SUBDIRS:
        (v / s).mkdir(exist_ok=True)
        os.chmod(v / s, 0o700)
    cfg = v / "config.json"
    if not cfg.exists():
        cfg.write_text(json.dumps(pg.DEFAULT_CONFIG | {"vault": str(v)}, indent=2))
    (v / "README.txt").write_text(
        "Private vault. Put your own files in raw/. Never share this folder with a cloud AI.\n"
        "Scripts in the local-private-tuning skill read from here and only print counts.\n"
    )
    pg.report({"vault_created": True, "subdirs": SUBDIRS, "config": "config.json"})


def _counts(root):
    files = list(pg.iter_text_files(root)) if root.exists() else []
    chars = sum(p.stat().st_size for p in files)
    exts = {}
    for p in files:
        exts[p.suffix.lower()] = exts.get(p.suffix.lower(), 0) + 1
    return {"n_files": len(files), "approx_chars": chars, "approx_tokens": chars // 4, "by_ext": exts}


def cmd_stats(_):
    v = pg.vault_path()
    pg.assert_private_dir(v)
    out = {"vault_exists": v.exists()}
    for s in ["raw", "redacted", "seeds", "datasets"]:
        out[s] = _counts(v / s)
    idx = v / "index" / "meta.json"
    out["index"] = json.loads(idx.read_text()) if idx.exists() else None
    man = v / "datasets" / "manifest.json"
    out["dataset"] = json.loads(man.read_text()) if man.exists() else None
    red = v / "logs" / "redaction_report.json"
    out["redaction"] = json.loads(red.read_text()) if red.exists() else None
    out["models_dir"] = sorted(p.name for p in (v / "models").iterdir()) if (v / "models").exists() else []
    pg.report(out)


def _has(mod):
    return importlib.util.find_spec(mod) is not None


def cmd_doctor(_):
    from local_llm import available
    cfg = pg.load_config()
    tags = []
    if available():
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(cfg["ollama_url"].rstrip("/") + "/api/tags", timeout=3) as r:
            tags = [m["name"] for m in json.loads(r.read()).get("models", [])]
    want = cfg["models"]
    apple = platform.system() == "Darwin" and platform.machine() == "arm64"
    cuda = shutil.which("nvidia-smi") is not None
    pg.report({
        "os": platform.system(), "arch": platform.machine(), "python": sys.version.split()[0],
        "apple_silicon": apple, "nvidia_gpu": cuda,
        "ollama_running": bool(tags) or available(), "ollama_cli": shutil.which("ollama") is not None,
        "models_wanted": want,
        "repair_local_detected": pg.REPAIR_LOCAL_CONFIG.exists(),
        "models_missing": sorted({m for k, m in want.items() if not k.endswith(("_hf", "_lib", "_fallback")) and not any(t.startswith(m.split(":")[0]) and (":" not in m or t == m or t == m + ":latest") for t in tags)}),
        "pkgs": {k: _has(k) for k in ["mlx_lm", "unsloth", "peft", "transformers", "trl", "torch", "numpy"]},
        "llama_cpp_convert": bool(shutil.which("llama-quantize")) or bool(os.environ.get("LLAMA_CPP_DIR")),
        "recommended_trainer": "mlx" if apple else ("unsloth" if cuda else "none (CPU LoRA is impractical): use RAG + persona prompts"),
        "vault_ok": _safe_vault_ok(),
    })


def _safe_vault_ok():
    try:
        pg.assert_private_dir(pg.vault_path())
        return pg.vault_path().exists()
    except pg.PrivacyViolation:
        return False


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(required=True)
    for name, fn in [("init", cmd_init), ("stats", cmd_stats), ("doctor", cmd_doctor)]:
        sub.add_parser(name).set_defaults(fn=fn)
    a = ap.parse_args()
    a.fn(a)
