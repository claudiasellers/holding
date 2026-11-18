"""Shared guard for every script in this skill.

Import this FIRST. It:
  1. Forces offline mode for Hugging Face, tokenizers, W&B, telemetry.
  2. Patches socket so only loopback (127.0.0.0/8, ::1, localhost, unix sockets) can connect.
     Anything else raises PrivacyViolation before a single byte leaves the machine.
  3. Resolves the vault path and config.
  4. Provides report(), the only way scripts print: aggregates, never content.

Zero third-party dependencies.
"""
from __future__ import annotations

import ipaddress
import json
import os
import socket
import stat
import sys
from pathlib import Path

# ---------------------------------------------------------------- offline env
for _k, _v in {
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "DO_NOT_TRACK": "1",
    "WANDB_MODE": "disabled",
    "WANDB_DISABLED": "true",
    "TOKENIZERS_PARALLELISM": "false",
    "ANONYMIZED_TELEMETRY": "False",
    "OLLAMA_NOHISTORY": "1",
}.items():
    os.environ[_k] = _v
# Proxies would route loopback-looking traffic elsewhere; drop them for this process.
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "*"


class PrivacyViolation(RuntimeError):
    pass


def _is_loopback(host) -> bool:
    if host is None:
        return False
    if isinstance(host, bytes):
        host = host.decode(errors="ignore")
    host = str(host).strip("[]")
    if host in ("localhost", "localhost.localdomain", ""):
        return True
    try:
        return ipaddress.ip_address(host.split("%")[0]).is_loopback
    except ValueError:
        return False  # any hostname other than localhost is refused (no DNS lookups)


_orig_connect = socket.socket.connect
_orig_connect_ex = socket.socket.connect_ex
_orig_create_connection = socket.create_connection
_orig_getaddrinfo = socket.getaddrinfo


def _check(sock, address):
    fam = getattr(sock, "family", None)
    if fam == getattr(socket, "AF_UNIX", object()):
        return
    host = address[0] if isinstance(address, tuple) else address
    if not _is_loopback(host):
        raise PrivacyViolation(
            f"blocked outbound connection to {host!r}: this skill only talks to 127.0.0.1"
        )


def _guarded_connect(self, address):
    _check(self, address)
    return _orig_connect(self, address)


def _guarded_connect_ex(self, address):
    _check(self, address)
    return _orig_connect_ex(self, address)


def _guarded_create_connection(address, *a, **kw):
    if not _is_loopback(address[0]):
        raise PrivacyViolation(f"blocked outbound connection to {address[0]!r}")
    return _orig_create_connection(address, *a, **kw)


def _guarded_getaddrinfo(host, *a, **kw):
    if not _is_loopback(host):
        raise PrivacyViolation(f"blocked DNS lookup for {host!r}")
    return _orig_getaddrinfo(host, *a, **kw)


def lock_network():
    socket.socket.connect = _guarded_connect
    socket.socket.connect_ex = _guarded_connect_ex
    socket.create_connection = _guarded_create_connection
    socket.getaddrinfo = _guarded_getaddrinfo


if os.environ.get("LPT_ALLOW_NETWORK") != "1":  # escape hatch for one-off model downloads only
    lock_network()

# ---------------------------------------------------------------- vault + config
DEFAULT_VAULT = Path(os.environ.get("PARENT_VAULT", Path.home() / ".parent-vault")).expanduser()
SKILL_DIR = Path(__file__).resolve().parent.parent

DEFAULT_CONFIG = {
    "vault": str(DEFAULT_VAULT),
    "ollama_url": "auto",
    "models": {
        # Inference: "auto" = whatever Repair Local chose for this machine (~/.repair-local/config.json
        # llm_model), else gemma4:e4b. Matches the desktop companion's RAM-sized Gemma 4 tiers.
        "chat": "auto",
        "chat_fallback": "gemma4:e4b",
        # Fine-tune base. Qwen3.5-4B, not Gemma 4: see SKILL.md "Why Qwen for fine-tuning".
        "finetune_base": "qwen3.5:4b",
        "finetune_base_hf": "Qwen/Qwen3.5-4B",
        "mobile_chat": "qwen3.5:2b",
        "mobile_chat_hf": "Qwen/Qwen3.5-2B",
        "mobile_webllm_lib": "Qwen3.5-2B-q4f16_1-MLC",
        "embed": "nomic-embed-text",
        "embed_hf": "nomic-ai/nomic-embed-text-v1.5",
        "redact_helper": "auto",
    },
    "rag": {"chunk_chars": 900, "overlap_chars": 150, "k": 4, "backend": "auto"},
    "redaction": {"llm_pass": False, "placeholder_style": "[{CAT}]"},
    "finetune": {
        "method": "lora",
        "rank": 16,
        "alpha": 32,
        "epochs": 2,
        "lr": 2e-4,
        "max_seq_len": 2048,
        "val_fraction": 0.08,
        "output_tag": "parent-warm",
        "quant": "q4_k_m",
    },
    "report": {"min_k": 5},
    "server": {"host": "127.0.0.1", "port": 8765},
}


def vault_path() -> Path:
    return Path(load_config()["vault"]).expanduser()


def _deep_merge(a, b):
    out = dict(a)
    for k, v in b.items():
        out[k] = _deep_merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return out


REPAIR_LOCAL_CONFIG = Path(os.environ.get("REPAIR_LOCAL_HOME", Path.home() / ".repair-local")) / "config.json"


def _repair_local() -> dict:
    """Read only the model choice and Ollama URL from Repair Local's settings (never its token)."""
    try:
        c = json.loads(REPAIR_LOCAL_CONFIG.read_text())
        return {"llm_model": c.get("llm_model"), "ollama_url": c.get("ollama_url")}
    except (OSError, ValueError):
        return {}


def load_config() -> dict:
    cfg_file = DEFAULT_VAULT / "config.json"
    cfg = _deep_merge(DEFAULT_CONFIG, json.loads(cfg_file.read_text())) if cfg_file.exists() else _deep_merge(DEFAULT_CONFIG, {})
    rl = None
    if cfg["ollama_url"] == "auto":
        rl = _repair_local()
        cfg["ollama_url"] = rl.get("ollama_url") or "http://127.0.0.1:11434"
    m = cfg["models"] = dict(cfg["models"])
    if m.get("chat") == "auto":
        rl = rl if rl is not None else _repair_local()
        m["chat"] = rl.get("llm_model") or m.get("chat_fallback") or "gemma4:e4b"
    if m.get("redact_helper") == "auto":
        m["redact_helper"] = m["chat"]
    return cfg


def assert_private_dir(p: Path):
    """Refuse to work if the vault is world/group readable or sits inside a git repo."""
    p = p.resolve()
    if p.exists():
        mode = stat.S_IMODE(p.stat().st_mode)
        if os.name != "nt" and mode & 0o077:
            raise PrivacyViolation(f"{p} is readable by other users (mode {oct(mode)}); run: chmod 700 {p}")
    for parent in [p, *p.parents]:
        if (parent / ".git").exists():
            raise PrivacyViolation(
                f"vault {p} is inside a git repo at {parent}; move it out so it is never committed"
            )


# ---------------------------------------------------------------- reporting
def report(obj: dict, min_k: int | None = None):
    """Print a JSON report. Only numbers, booleans, category names and vault-relative
    *counts*. Any string longer than 80 chars is refused, so content cannot slip through."""
    k = min_k if min_k is not None else load_config()["report"]["min_k"]

    def scrub(x, key=""):
        if isinstance(x, dict):
            return {kk: scrub(vv, kk) for kk, vv in x.items()}
        if isinstance(x, list):
            return [scrub(v) for v in x]
        if isinstance(x, str) and len(x) > 80:
            return "<redacted: long string>"
        if isinstance(x, int) and not isinstance(x, bool) and key.startswith("n_") and 0 < x < k:
            return f"<{k}"  # small counts can identify; bucket them
        return x

    print(json.dumps(scrub(obj), indent=2, sort_keys=True))


def iter_text_files(root: Path, exts=(".txt", ".md", ".json", ".jsonl", ".csv", ".srt", ".vtt")):
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in exts and not p.name.startswith("."):
            yield p


def read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


if __name__ == "__main__":
    # self-test: prove the lock works
    try:
        socket.create_connection(("1.1.1.1", 443), timeout=2)
        print("FAIL: outbound connection allowed")
        sys.exit(1)
    except PrivacyViolation as e:
        print("ok: outbound blocked ->", e)
    try:
        socket.getaddrinfo("huggingface.co", 443)
        print("FAIL: DNS allowed")
        sys.exit(1)
    except PrivacyViolation as e:
        print("ok: DNS blocked ->", e)
    print("ok: loopback allowed =", _is_loopback("127.0.0.1"), _is_loopback("::1"), _is_loopback("localhost"))
