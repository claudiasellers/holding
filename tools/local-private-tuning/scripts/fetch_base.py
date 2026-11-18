#!/usr/bin/env python3
"""The ONE step that uses the network: download public base weights. It reads nothing from the
vault and sends nothing but the repo id to Hugging Face. Run it before you put data in the vault
if you want to be strict.

  fetch_base.py                    downloads config models.finetune_base_hf into vault/models/base/<name>
  fetch_base.py --repo ORG/NAME    any other public repo
  fetch_base.py --ollama           also `ollama pull` the fine-tune base tag (eval baseline) and embeddings.
                                   The chat model itself comes from Repair Local's setup (`repair-local setup`);
                                   this only pulls what that setup doesn't.
"""
import argparse
import os
import shutil
import subprocess
import sys

os.environ["LPT_ALLOW_NETWORK"] = "1"  # must be set before the guard is imported
import privacy_guard as pg  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--repo")
ap.add_argument("--ollama", action="store_true")
a = ap.parse_args()
cfg = pg.load_config()
repo = a.repo or cfg["models"]["finetune_base_hf"]
dest = pg.vault_path() / "models" / "base" / repo.split("/")[-1]
dest.parent.mkdir(parents=True, exist_ok=True)
env = {k: v for k, v in os.environ.items() if not k.startswith(("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"))}
cli = shutil.which("hf") or shutil.which("huggingface-cli")
if not cli:
    sys.exit("pip install -U huggingface_hub   (then re-run)")
subprocess.run([cli, "download", repo, "--local-dir", str(dest)], check=True, env=env)
if a.ollama:
    import json as _j, urllib.request as _u
    try:
        with _u.urlopen(cfg["ollama_url"].rstrip("/") + "/api/tags", timeout=3) as r:
            have = {m["name"] for m in _j.loads(r.read()).get("models", [])}
    except Exception:
        have = set()
    for tag in {cfg["models"]["finetune_base"], cfg["models"]["embed"]}:
        if tag not in have and f"{tag}:latest" not in have:
            subprocess.run(["ollama", "pull", tag], check=True)
pg.report({"downloaded": repo, "to": "models/base/" + dest.name, "ollama_pulled": a.ollama})
