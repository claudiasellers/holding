"""Minimal Ollama client over urllib. Loopback only (enforced by privacy_guard)."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

import privacy_guard as pg


def _post(path: str, payload: dict, timeout=300):
    url = pg.load_config()["ollama_url"].rstrip("/") + path
    host = urllib.request.urlparse(url).hostname
    if not pg._is_loopback(host):
        raise pg.PrivacyViolation(f"ollama_url must be loopback, got {host!r}")
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never use a proxy
    with opener.open(req, timeout=timeout) as r:
        return json.loads(r.read())


def available() -> bool:
    try:
        url = pg.load_config()["ollama_url"].rstrip("/") + "/api/tags"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=2) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError, pg.PrivacyViolation):
        return False


def chat(messages, model=None, temperature=0.7, json_mode=False, num_ctx=8192) -> str:
    m = model or pg.load_config()["models"]["chat"]
    payload = {"model": m, "messages": messages, "stream": False, "think": False,
               "options": {"temperature": temperature, "num_ctx": num_ctx}}
    if json_mode:
        payload["format"] = "json"
    return strip_think(_post("/api/chat", payload)["message"]["content"])


def strip_think(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def embed(texts: list[str], model=None, kind="document") -> list[list[float]]:
    """kind: 'document' or 'query'. nomic-embed-text needs task prefixes; keeping them identical to the
    browser (transformers.js) side keeps desktop and phone indexes compatible."""
    m = model or pg.load_config()["models"]["embed"]
    if "nomic" in m:
        texts = [("search_query: " if kind == "query" else "search_document: ") + t for t in texts]
    out = []
    for i in range(0, len(texts), 32):
        out.extend(_post("/api/embed", {"model": m, "input": texts[i:i + 32]})["embeddings"])
    return out
