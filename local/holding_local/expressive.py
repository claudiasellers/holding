"""Speaking with any voice model other than Kokoro: one entry point, a line cache, and
recording a parent's scripted lines ahead of time.

These models are slower than Kokoro, some much slower, so every line they speak
is kept, and scripted lines can be recorded in the background while the app is
idle. AI replies are new text and are always spoken live.
"""
import hashlib
import shutil
import threading
import time

import numpy as np

from . import chatterbox, mlx_voices, state, tts

DEFAULT_FEELING = chatterbox.DEFAULT_EXAGGERATION
REF_TEXT = chatterbox.REF_TEXT


def is_onnx(mid: str) -> bool:
    return mid in chatterbox.VARIANTS


def has_feeling(mid: str) -> bool:
    if mid == "chatterbox":
        return True
    return bool(mlx_voices.CATALOG.get(mid, {}).get("feeling"))


def ready(mid: str) -> bool:
    if is_onnx(mid):
        return chatterbox.available(mid)
    if mid in mlx_voices.CATALOG:
        return mlx_voices.supported() and mlx_voices.downloaded(mid)
    return False


def clamp_feeling(mid: str, feeling) -> float:
    """Models without a dial store every line at 0, so one take serves every feeling."""
    if not has_feeling(mid):
        return 0.0
    f = float(feeling if isinstance(feeling, (int, float)) else DEFAULT_FEELING)
    return round(min(max(f, 0.25), 1.5), 2)


# ---------- the parent's voice, rendered by Kokoro, for models that copy a voice ----------
def _ref_samples(voice: str, quality: str) -> np.ndarray:
    samples, sr = tts.synthesize(REF_TEXT, voice, 0.95, quality)
    return chatterbox.resample(np.asarray(samples, dtype=np.float32), sr)


def reference_wav(voice: str, quality: str):
    """A WAV file of the parent's voice, for the Mac voices (they read audio from a path)."""
    d = state.HOME / "voice-cache" / "references"
    d.mkdir(parents=True, exist_ok=True)
    f = d / (hashlib.sha1(f"{voice or ''}\u0000{quality}".encode()).hexdigest()[:16] + ".wav")
    if not f.exists():
        f.write_bytes(tts.to_wav(_ref_samples(voice, quality), chatterbox.SR))
    return f


# ---------- the line cache ----------
def cache_root():
    return state.HOME / "voice-cache"


def cache_dir(mid: str = "chatterbox"):
    return cache_root() / mid


def _norm(text: str) -> str:
    return " ".join(str(text).split())


def _cache_key(text: str, voice: str) -> str:
    return hashlib.sha1(f"{voice or ''}\u0000{_norm(text)}".encode()).hexdigest()[:20]


def cached(mid: str, text: str, voice: str, feeling: float, tolerance: float = 0.15):
    """A line spoken before by this model in this voice at about this feeling: (samples, sr), or None.
    Scripted lines repeat a lot, so this is what makes them instant."""
    d = cache_dir(mid)
    if not d.exists():
        return None
    key = _cache_key(text, voice)
    # The app eases the feeling to 80% at peak distress; treat that as the same take.
    tolerance = max(tolerance, 0.25 * feeling)
    best, dist = None, tolerance + 1e-9
    for f in d.glob(f"{key}-*.npz"):
        try:
            x = float(f.stem.rsplit("-", 1)[1])
        except ValueError:
            continue
        if abs(x - feeling) <= dist:
            best, dist = f, abs(x - feeling)
    if best is None:
        return None
    try:
        with np.load(best) as z:
            return z["a"].astype(np.float32), int(z["sr"])
    except (OSError, ValueError, KeyError):
        return None


def store(mid: str, text: str, voice: str, feeling: float, samples: np.ndarray, sr: int):
    d = cache_dir(mid)
    d.mkdir(parents=True, exist_ok=True)
    # float16 halves the size and is far below what anyone can hear
    np.savez(d / f"{_cache_key(text, voice)}-{feeling:.2f}.npz", a=samples.astype(np.float16), sr=np.int32(sr))


def cache_bytes(mid: str = "chatterbox") -> int:
    d = cache_dir(mid)
    return sum(f.stat().st_size for f in d.glob("*.npz")) if d.exists() else 0


def clear_cache(mid: str = "chatterbox") -> int:
    n = cache_bytes(mid)
    shutil.rmtree(cache_dir(mid), ignore_errors=True)
    return n


# ---------- speaking ----------
def min_seconds(text: str) -> float:
    """Far shorter than anyone speaks (about 40 characters a second): below it, a line was cut off."""
    return 0.025 * len(_norm(text))


_live = 0  # live requests in flight; pre-rendering yields to them
_live_lock = threading.Lock()


def live_busy() -> bool:
    return _live > 0


def synthesize(mid: str, text: str, voice: str, feeling, quality: str, live: bool = True):
    """Returns (samples float32, sample_rate)."""
    global _live
    f = clamp_feeling(mid, feeling)
    hit = cached(mid, text, voice, f)
    if hit is not None:
        return hit
    if live:
        with _live_lock:
            _live += 1
    try:
        if is_onnx(mid):
            if mlx_voices._models:
                mlx_voices.unload()  # one expressive model in memory at a time
            wav, sr = chatterbox.generate(mid, text, lambda: _ref_samples(voice, quality),
                                          f"kokoro:{voice or ''}", f if has_feeling(mid) else chatterbox.DEFAULT_EXAGGERATION)
        else:
            chatterbox.unload()
            needs_ref = mlx_voices.CATALOG[mid]["style"].startswith("clone")
            ref = reference_wav(voice, quality) if needs_ref else None
            wav, sr = mlx_voices.generate(mid, text, voice, f or DEFAULT_FEELING, ref, REF_TEXT)
            wav = chatterbox.limit_peak(chatterbox.trim_silence(wav, sr=sr))
    finally:
        if live:
            with _live_lock:
                _live -= 1
    if len(wav) / sr < min_seconds(text):
        # Cut short: better the steady Kokoro voice than a clipped line. Not kept.
        raise RuntimeError(f"{mid} stopped early ({len(wav) / sr:.1f}s for {len(text)} characters)")
    try:
        store(mid, text, voice, f, wav, sr)
    except OSError:
        pass
    return wav, sr


# ---------- recording a parent's scripted lines in the background ----------
_job: dict = {}


def prerender_status() -> dict:
    j = dict(_job)
    j.pop("cancel", None)
    return j or {"running": False, "done": 0, "total": 0}


def prerender(mid: str, texts: list[str], voice: str, feeling, quality: str, wait: bool = False) -> dict:
    """Speak every line not already cached, one at a time, pausing while the app is speaking live."""
    global _job
    cancel_prerender(wait=True)
    f = clamp_feeling(mid, feeling)
    seen, todo = set(), []
    for t in texts:
        t = _norm(t)
        if t and t not in seen:
            seen.add(t)
            todo.append(t)
    job = {"running": True, "model": mid, "voice": voice, "feeling": f, "total": len(todo), "done": 0,
           "rendered": 0, "seconds": 0.0, "error": None, "started": time.time()}
    _job = job

    def run():
        try:
            for t in todo:
                if job.get("cancel"):
                    break
                if cached(mid, t, voice, f) is None:
                    while live_busy() and not job.get("cancel"):
                        time.sleep(0.2)
                    t0 = time.time()
                    synthesize(mid, t, voice, f, quality, live=False)
                    job["seconds"] += time.time() - t0
                    job["rendered"] += 1
                job["done"] += 1
        except Exception as e:
            job["error"] = str(e)
        finally:
            job["running"] = False

    if wait:
        run()
    else:
        threading.Thread(target=run, name="voice-prerender", daemon=True).start()
    return prerender_status()


def cancel_prerender(mid: str | None = None, wait: bool = False):
    if _job.get("running") and (mid is None or _job.get("model") == mid):
        _job["cancel"] = True
        if wait:
            for _ in range(600):
                if not _job.get("running"):
                    break
                time.sleep(0.1)
