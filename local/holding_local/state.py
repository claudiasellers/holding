"""Persistent settings in ~/.holding-local/config.json (override with HOLDING_LOCAL_HOME)."""
import json
import os
import secrets
from pathlib import Path

HOME = Path(os.environ.get("HOLDING_LOCAL_HOME", Path.home() / ".holding-local"))
MODELS = HOME / "models"
CONFIG = HOME / "config.json"

DEFAULTS = {
    "llm_model": None,          # chosen by setup from hardware
    "ollama_url": "http://127.0.0.1:11434",
    "tts_quality": "int8",
    "whisper_model": "small",
    "port": 8787,
    "app_dir": None,            # folder with the built app; None = auto-detect
    "cors_origins": ["*"],      # API needs a token from anything not on this machine
    "token": None,
}


def load() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG.exists():
        try:
            cfg.update(json.loads(CONFIG.read_text()))
        except (OSError, ValueError):
            pass
    return cfg


def save(cfg: dict) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2))
    tmp.replace(CONFIG)
    try:
        os.chmod(CONFIG, 0o600)
    except OSError:
        pass


ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L


def normalize_code(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())


def ensure_token(cfg: dict, rotate: bool = False) -> str:
    """The pairing code is short enough to type on a phone (e.g. K7QM-2XPA,
    ~39 bits); the server rate-limits wrong guesses. Dashes, spaces and case
    are ignored when it is checked."""
    if rotate or not cfg.get("token") or len(normalize_code(cfg["token"])) != 8:
        raw = "".join(secrets.choice(ALPHABET) for _ in range(8))
        cfg["token"] = f"{raw[:4]}-{raw[4:]}"
        save(cfg)
    return cfg["token"]
