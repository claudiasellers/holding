"""Voice models on this computer: list, download (in the background), select, delete.

Used by the /v1/voice-models endpoints (Settings → Voice in the app) and by
`holding-local voice ...`. Kokoro stays installed: it is the fallback voice and
the models that copy a voice copy Kokoro's.

Two kinds of model:
- files: a fixed list of files fetched with resumable downloads (Kokoro, and
  Chatterbox and Chatterbox Turbo on ONNX Runtime, which run on any computer);
- mac:   voices that run on a Mac's GPU through mlx-audio (see mlx_voices.py).
None is needed; download only the ones you want.
"""
import shutil
import threading
import time
from pathlib import Path

import httpx

from . import catalog, chatterbox, expressive, mlx_voices, state


def _kokoro_files(cfg: dict) -> list[tuple[str, Path, int]]:
    q = cfg.get("tts_quality", "int8")
    name, url = catalog.KOKORO_FILES.get(q, catalog.KOKORO_FILES["int8"])
    vname, vurl = catalog.KOKORO_FILES["voices"]
    return [(url, state.MODELS / name, 88_000_000 if q == "int8" else 310_000_000),
            (vurl, state.MODELS / vname, 27_000_000)]


def _onnx_files(mid: str):
    v = chatterbox.VARIANTS[mid]
    return lambda cfg: [(f"{v.base_url}/{rel}", chatterbox.folder(mid) / rel, size) for rel, size in v.files]


MODELS = {
    "kokoro": {
        "name": "Kokoro",
        "blurb": "Clear and steady, and very fast. The everyday voice.",
        "size_note": "about 115 MB",
        "feeling": False, "deletable": False, "kind": "files", "group": "any",
        "keep_reason": "Kept: it is the fallback voice, and the voices that copy a parent's voice copy Kokoro's.",
        "files": _kokoro_files,
    },
    "chatterbox": {
        "name": "Chatterbox",
        "blurb": "Warm and expressive, with a feeling dial. Keeps each parent's own voice. "
                 "Much slower than Kokoro: a short line can take several seconds to start.",
        "size_note": "about 1.5 GB",
        "feeling": True, "deletable": True, "kind": "files", "group": "any", "keep_reason": "",
        "files": _onnx_files("chatterbox"),
    },
    "chatterbox-turbo": {
        "name": "Chatterbox Turbo",
        "blurb": "Chatterbox's faster sibling: keeps each parent's own voice and understands [sigh] and [chuckle], "
                 "but has no feeling dial. Several times quicker than Chatterbox.",
        "size_note": "about 960 MB",
        "feeling": False, "deletable": True, "kind": "files", "group": "any", "keep_reason": "",
        "files": _onnx_files("chatterbox-turbo"),
    },
    **{k: {"name": m["name"], "blurb": m["blurb"], "size_note": m["size_note"], "feeling": m["feeling"],
           "deletable": True, "kind": "mac", "group": "mac", "keep_reason": ""}
       for k, m in mlx_voices.CATALOG.items()},
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
    job = _jobs.get(model_id) or {}
    if m["kind"] == "mac":
        have = mlx_voices.downloaded(model_id)
        size = mlx_voices.bytes_on_disk(model_id)
        runs, why = mlx_voices.supported(), mlx_voices.unsupported_reason()
    else:
        files = m["files"](cfg)
        have = all(p.exists() and p.stat().st_size > 0 for _, p, _ in files)
        size = sum(_on_disk(p) for _, p, _ in files)
        runs, why = True, ""
    return {
        "id": model_id, "name": m["name"], "blurb": m["blurb"], "size_note": m["size_note"],
        "feeling": m["feeling"], "deletable": m["deletable"], "keep_reason": m["keep_reason"],
        "group": m["group"], "runs_here": runs, "why_not": why,
        "downloaded": have, "bytes": size,
        "lines_bytes": expressive.cache_bytes(model_id) if model_id != "kokoro" else 0,
        "downloading": bool(job.get("running")), "phase": job.get("phase"),
        "done_bytes": job.get("done", 0), "total_bytes": job.get("total", 0), "error": job.get("error"),
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
    m = MODELS[model_id]
    with _lock:
        job = _jobs.get(model_id)
        if job and job.get("running"):
            return job
        job = {"running": True, "done": 0, "total": 0, "error": None, "started": time.time(), "phase": "downloading"}
        _jobs[model_id] = job

    def run():
        try:
            if m["kind"] == "mac":
                mlx_voices.download(model_id, job, lambda: expressive.reference_wav(catalog.DEFAULT_VOICE, cfg.get("tts_quality", "int8")))
            else:
                files = m["files"](cfg)
                with httpx.Client() as client:
                    job["total"] = sum(_size(client, url, approx) for url, _, approx in files)
                    for url, dest, _ in files:
                        _fetch(client, url, dest, job)
        except Exception as e:  # reported to the app; the .part files let it resume
            job["error"] = str(e)
        finally:
            job["running"] = False
            job["phase"] = None

    if wait:
        run()
    else:
        threading.Thread(target=run, name=f"download-{model_id}", daemon=True).start()
    return job


def delete(model_id: str, cfg: dict) -> int:
    """Remove a model's files and the lines it recorded. Returns bytes freed."""
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
    expressive.cancel_prerender(model_id, wait=True)
    freed = 0
    if m["kind"] == "mac":
        freed += mlx_voices.delete(model_id)
    else:
        chatterbox.unload(model_id)
        for _, p, _ in m["files"](cfg):
            for f in (p, p.with_suffix(p.suffix + ".part")):
                try:
                    freed += f.stat().st_size
                    f.unlink()
                except OSError:
                    pass
        shutil.rmtree(chatterbox.folder(model_id), ignore_errors=True)
    freed += expressive.clear_cache(model_id)  # its recorded lines go with it
    _jobs.pop(model_id, None)
    if selected(cfg) == model_id:
        cfg["tts_engine"] = "kokoro"
        state.save(cfg)
    return freed


def select(model_id: str, cfg: dict) -> str:
    if model_id not in MODELS:
        raise KeyError(model_id)
    i = info(model_id, cfg)
    if not i["runs_here"]:
        raise FileNotFoundError(f"{i['name']} can't run here. {i['why_not']}")
    if not i["downloaded"]:
        raise FileNotFoundError(f"{i['name']} is not downloaded yet.")
    cfg["tts_engine"] = model_id
    state.save(cfg)
    return model_id
