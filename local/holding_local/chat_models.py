"""Chat models (Ollama) on this computer: list them with sizes, pick one, download
another, delete the ones you don't use. The server routes in server.py call these
with its shared httpx.AsyncClient, so tests can mock Ollama.

GET    /v1/chat-models               -> {models, selected, suggested, disk, pull}
POST   /v1/chat-models/select {name} -> the model the parent uses when a request names none
POST   /v1/chat-models/pull {name}   -> start downloading one in the background
DELETE /v1/chat-models/pull          -> stop that download
DELETE /v1/chat-models/{name}        -> delete it, report the space freed
"""
import asyncio
import json
import os
import shutil
from pathlib import Path

import httpx

from . import catalog, state

# One download at a time: Ollama pulls are large and share the disk and network.
_pull: dict = {"running": False}
_task: asyncio.Task | None = None


def ollama_models_dir() -> Path:
    return Path(os.environ.get("OLLAMA_MODELS") or Path.home() / ".ollama" / "models")


def disk_free() -> int | None:
    for p in (ollama_models_dir(), state.HOME, Path.home()):
        try:
            if p.exists():
                return shutil.disk_usage(p).free
        except OSError:
            continue
    return None


def same(a: str, b: str | None) -> bool:
    """Ollama names models 'tag' and 'tag:latest' interchangeably."""
    if not b:
        return False
    norm = lambda s: s if ":" in s.rsplit("/", 1)[-1] else s + ":latest"
    return norm(a) == norm(b)


def selected(cfg: dict) -> str:
    return cfg.get("llm_model") or catalog.LLM_TIERS[1]["tag"]


def describe(raw: list[dict], cfg: dict, ram_gb: float | None = None) -> dict:
    """Shape Ollama's /api/tags list for the app. Pure, so it is easy to test."""
    sel = selected(cfg)
    tiers = {t["tag"]: t for t in catalog.LLM_TIERS}
    models = []
    for m in raw:
        name = m.get("name") or m.get("model") or ""
        det = m.get("details") or {}
        embed = same(name, catalog.EMBED_TAG) or "embed" in (det.get("family") or "")
        tier = next((t for tag, t in tiers.items() if same(name, tag)), None)
        in_use = same(name, sel)
        models.append({
            "name": name,
            "bytes": int(m.get("size") or 0),
            "modified_at": m.get("modified_at"),
            "parameter_size": det.get("parameter_size"),
            "quantization": det.get("quantization_level"),
            "kind": "embed" if embed else "chat",
            "in_use": in_use,
            "note": ("Used for your private notes (memory). Small; deleting it turns that off until you download it again."
                     if embed else tier["note"] if tier else ""),
            # Deleting the model the parent is using would leave her with nothing to say.
            "deletable": not in_use,
            "keep_reason": "This is the model the parent uses. Switch to another one first." if in_use else "",
        })
    models.sort(key=lambda x: (not x["in_use"], x["kind"] != "chat", -x["bytes"]))
    have = [m["name"] for m in models]
    suggested = []
    for t in catalog.LLM_TIERS:
        if any(same(n, t["tag"]) for n in have):
            continue
        fits = ram_gb is None or ram_gb >= t["min_gb"]
        suggested.append({"name": t["tag"], "download": t["download"], "note": t["note"], "fits": fits})
    chat_bytes = sum(m["bytes"] for m in models)
    return {"models": models, "selected": sel, "selected_installed": any(m["in_use"] for m in models),
            "suggested": suggested, "total_bytes": chat_bytes,
            "disk": {"free_bytes": disk_free()}, "pull": dict(_pull)}


async def tags(http: httpx.AsyncClient, url: str) -> list[dict]:
    r = await http.get(f"{url}/api/tags", timeout=5)
    r.raise_for_status()
    return r.json().get("models", [])


async def delete(http: httpx.AsyncClient, url: str, name: str, cfg: dict) -> dict:
    if same(name, selected(cfg)):
        raise PermissionError("This is the model the parent uses. Pick another one first, then delete this one.")
    if _pull.get("running") and same(name, _pull.get("name")):
        raise PermissionError("It is still downloading. Stop the download first.")
    existing = await tags(http, url)
    match = next((m for m in existing if same(m.get("name", ""), name)), None)
    if not match:
        raise KeyError(name)
    before = disk_free()
    r = await http.request("DELETE", f"{url}/api/delete", json={"model": match["name"], "name": match["name"]},
                           timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(_err(r) or f"Ollama answered {r.status_code}")
    after = disk_free()
    size = int(match.get("size") or 0)
    # Models can share layers, so the space actually freed can be less than the listed size.
    measured = (after - before) if before is not None and after is not None else 0
    freed = measured if 0 < measured <= size * 1.1 else size
    return {"deleted": match["name"], "freed_bytes": freed, "disk": {"free_bytes": after}}


def _err(r: httpx.Response) -> str:
    try:
        return r.json().get("error") or ""
    except ValueError:
        return r.text[:200]


async def select(http: httpx.AsyncClient, url: str, name: str, cfg: dict) -> str:
    existing = await tags(http, url)
    match = next((m["name"] for m in existing if same(m.get("name", ""), name)), None)
    if not match:
        raise FileNotFoundError(f"{name} is not downloaded yet.")
    cfg["llm_model"] = name
    state.save(cfg)
    return name


def start_pull(http: httpx.AsyncClient, url: str, name: str) -> dict:
    global _task
    if _pull.get("running"):
        if same(name, _pull.get("name")):
            return dict(_pull)
        raise PermissionError(f"Already downloading {_pull['name']}. Wait for it or stop it first.")
    _pull.clear()
    _pull.update({"name": name, "running": True, "done": 0, "total": 0, "status": "starting", "error": None})
    _task = asyncio.get_running_loop().create_task(_run_pull(http, url, name))
    return dict(_pull)


async def _run_pull(http: httpx.AsyncClient, url: str, name: str):
    try:
        async with http.stream("POST", f"{url}/api/pull", json={"model": name, "stream": True}, timeout=None) as r:
            if r.status_code >= 400:
                await r.aread()
                raise RuntimeError(_err(r) or f"Ollama answered {r.status_code}")
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                ev = json.loads(line)
                if ev.get("error"):
                    raise RuntimeError(ev["error"])
                _pull["status"] = ev.get("status", _pull["status"])
                if ev.get("total"):
                    _pull["total"], _pull["done"] = ev["total"], ev.get("completed", 0)
        _pull.update(running=False, status="success")
    except asyncio.CancelledError:
        _pull.update(running=False, status="stopped", error=None)
    except Exception as e:  # noqa: BLE001 - shown to the person as is
        _pull.update(running=False, status="failed", error=str(e) or e.__class__.__name__)


def stop_pull() -> dict:
    if _task and not _task.done():
        _task.cancel()
    return dict(_pull)
