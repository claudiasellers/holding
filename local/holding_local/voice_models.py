"""Voice models on this computer: list, download (in the background), select, delete.

Used by the /v1/voice-models endpoints (Settings → Voice in the app) and by
`holding-local voice ...`. Kokoro stays installed: it is the fallback voice and
Chatterbox copies its voices.
"""
import shutil
import threading
import time
from pathlib import Path

import httpx

from . import catalog, chatterbox, state


def _kokoro_files(cfg: dict) -> list[tuple[str, Path, int]]:
    q = cfg.get("tts_quality", "int8")
    name, url = catalog.KOKORO_FILES.get(q, catalog.KOKORO_FILES["int8"])
    vname, vurl = catalog.KOKORO_FILES["voices"]
    return [(url, state.MODELS / name, 88_000_000 if q == "int8" else 310_000_000),
            (vurl, state.MODELS / vname, 27_000_000)]


def _chatterbox_files(cfg: dict) -> list[tuple[str, Path, int]]:
    return [(f"{chatterbox.BASE_URL}/{rel}", chatterbox.folder() / rel, size) for rel, size in chatterbox.FILES]


MODELS = {
    "kokoro": {
        "name": "Kokoro",
        "blurb": "Clear and steady, and very fast. The everyday voice.",
        "size_note": "about 115 MB",
        "feeling": False,
        "deletable": False,
        "keep_reason": "Kept: it is the fallback voice, and Chatterbox copies its voices.",
        "files": _kokoro_files,
    },
    "chatterbox": {
        "name": "Chatterbox",
        "blurb": "Warm and expressive, with a feeling dial. Keeps each parent's own voice. "
                 "Slower: about real time on a Mac mini, so phrases take a moment to start.",
        "size_note": "about 1.5 GB",
        "feeling": True,
        "deletable": True,
        "keep_reason": "",
        "files": _chatterbox_files,
    },
}

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _on_disk(path: Path) -> int:
    n = 0
    for p in (path, path.with_suffix(path.suffix + ".part")):
        try:
            n += p.stat().st_size
        except OSError:
            pass
    return n


def info(model_id: str, cfg: dict) -> dict:
    m = MODELS[model_id]
    files = m["files"](cfg)
    have = all(p.exists() and p.stat().st_size > 0 for _, p, _ in files)
    job = _jobs.get(model_id) or {}
    return {
        "id": model_id, "name": m["name"], "blurb": m["blurb"], "size_note": m["size_note"],
        "feeling": m["feeling"], "deletable": m["deletable"], "keep_reason": m["keep_reason"],
        "downloaded": have, "bytes": sum(_on_disk(p) for _, p, _ in files),
        "downloading": bool(job.get("running")), "done_bytes": job.get("done", 0),
        "total_bytes": job.get("total", 0), "error": job.get("error"),
    }


def selected(cfg: dict) -> str:
    sel = cfg.get("tts_engine") or "kokoro"
    return sel if sel in MODELS else "kokoro"


def listing(cfg: dict) -> dict:
    try:
        state.MODELS.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(state.MODELS).free
    except OSError:
        free = None
    return {"models": [info(k, cfg) for k in MODELS], "selected": selected(cfg), "disk": {"free_bytes": free}}


def _size(client: httpx.Client, url: str, fallback: int) -> int:
    try:
        r = client.head(url, follow_redirects=True, timeout=15)
        n = int(r.headers.get("content-length") or 0)
        return n or fallback
    except Exception:
        return fallback


def _fetch(client: httpx.Client, url: str, dest: Path, job: dict):
    if dest.exists() and dest.stat().st_size > 0:
        job["done"] += dest.stat().st_size
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with client.stream("GET", url, headers=headers, follow_redirects=True, timeout=60) as r:
        if r.status_code == 416:
            part.rename(dest)
            job["done"] += have
            return
        r.raise_for_status()
        if r.status_code == 200:
            have = 0
        job["done"] += have
        with open(part, "ab" if have else "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                if job.get("cancel"):
                    raise RuntimeError("cancelled")
                f.write(chunk)
                job["done"] += len(chunk)
    part.rename(dest)


def download(model_id: str, cfg: dict, wait: bool = False) -> dict:
    """Start (or resume) a download. Returns the job state."""
    if model_id not in MODELS:
        raise KeyError(model_id)
    with _lock:
        job = _jobs.get(model_id)
        if job and job.get("running"):
            return job
        job = {"running": True, "done": 0, "total": 0, "error": None, "started": time.time()}
        _jobs[model_id] = job

    def run():
        try:
            files = MODELS[model_id]["files"](cfg)
            with httpx.Client() as client:
                job["total"] = sum(_size(client, url, approx) for url, _, approx in files)
                for url, dest, _ in files:
                    _fetch(client, url, dest, job)
        except Exception as e:  # reported to the app; the .part files let it resume
            job["error"] = str(e)
        finally:
            job["running"] = False

    if wait:
        run()
    else:
        threading.Thread(target=run, name=f"download-{model_id}", daemon=True).start()
    return job


def delete(model_id: str, cfg: dict) -> int:
    """Remove a model's files. Returns bytes freed."""
    m = MODELS[model_id]
    if not m["deletable"]:
        raise PermissionError(m["keep_reason"])
    job = _jobs.get(model_id)
    if job and job.get("running"):
        job["cancel"] = True
        for _ in range(50):
            if not job.get("running"):
                break
            time.sleep(0.1)
    if model_id == "chatterbox":
        chatterbox.unload()
    freed = 0
    for _, p, _ in m["files"](cfg):
        for f in (p, p.with_suffix(p.suffix + ".part")):
            try:
                freed += f.stat().st_size
                f.unlink()
            except OSError:
                pass
    if model_id == "chatterbox":
        shutil.rmtree(chatterbox.folder(), ignore_errors=True)
    _jobs.pop(model_id, None)
    if selected(cfg) == model_id:
        cfg["tts_engine"] = "kokoro"
        state.save(cfg)
    return freed


def select(model_id: str, cfg: dict) -> str:
    if model_id not in MODELS:
        raise KeyError(model_id)
    if not info(model_id, cfg)["downloaded"]:
        raise FileNotFoundError(f"{MODELS[model_id]['name']} is not downloaded yet.")
    cfg["tts_engine"] = model_id
    state.save(cfg)
    return model_id
