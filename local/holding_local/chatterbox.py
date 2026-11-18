"""Chatterbox (Resemble AI, MIT): an expressive voice with an emotion dial, on ONNX Runtime.

The same ONNX export the browser uses (onnx-community/chatterbox-ONNX), with the
4-bit language model, so it runs on a Mac mini or any computer's CPU with no
PyTorch. About 1.5 GB on disk.

Chatterbox copies a voice from a few seconds of reference audio. Holding Local
renders that reference with Kokoro in the parent's own voice (blends included),
so every parent keeps sounding like themselves, just with feeling.

Generation loop adapted from the model card's reference script and the
chatterbox-onnx package (MIT): greedy decoding with a repetition penalty.
"""
import re
import threading

import numpy as np

from . import state

REPO = "onnx-community/chatterbox-ONNX"
BASE_URL = f"https://huggingface.co/{REPO}/resolve/main"
SR = 24000
START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562
NUM_LAYERS, KV_HEADS, HEAD_DIM = 30, 16, 64
REPETITION_PENALTY = 1.2
DEFAULT_EXAGGERATION = 0.55
REF_TEXT = ("I'm right here with you. There's no hurry at all. "
            "Take whatever time you need, and I'll stay right here.")

# (path inside the repo, approximate size in bytes). Each .onnx needs its .onnx_data beside it.
FILES = [
    ("tokenizer.json", 200_000),
    ("onnx/speech_encoder.onnx", 1_180_000),
    ("onnx/speech_encoder.onnx_data", 591_000_000),
    ("onnx/embed_tokens.onnx", 13_300),
    ("onnx/embed_tokens.onnx_data", 61_600_000),
    ("onnx/language_model_q4.onnx", 228_000),
    ("onnx/language_model_q4.onnx_data", 354_000_000),
    ("onnx/conditional_decoder.onnx", 6_350_000),
    ("onnx/conditional_decoder.onnx_data", 534_000_000),
]


def folder():
    return state.MODELS / "chatterbox"


def file_paths():
    return [folder() / rel for rel, _ in FILES]


def available() -> bool:
    return all(p.exists() and p.stat().st_size > 0 for p in file_paths())


def token_budget(text: str) -> int:
    """Speech tokens run at 25 a second; leave room for slow, gentle delivery."""
    return min(1000, 80 + 3 * len(text))


def split_long(text: str, limit: int = 280) -> list[str]:
    """Chatterbox is best on a sentence or two at a time."""
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    parts, cur = [], ""
    for s in re.split(r"(?<=[.!?…])\s+", text):
        if cur and len(cur) + len(s) + 1 > limit:
            parts.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        parts.append(cur)
    return parts


def apply_repetition_penalty(scores: np.ndarray, ids: np.ndarray, penalty: float = REPETITION_PENALTY):
    picked = np.take_along_axis(scores, ids, axis=1)
    picked = np.where(picked < 0, picked * penalty, picked / penalty)
    out = scores.copy()
    np.put_along_axis(out, ids, picked, axis=1)
    return out


def resample(a: np.ndarray, src: int, dst: int = SR) -> np.ndarray:
    if src == dst:
        return a.astype(np.float32)
    n = int(len(a) * dst / src)
    x = np.linspace(0, len(a) - 1, n)
    return np.interp(x, np.arange(len(a)), a).astype(np.float32)


class Chatterbox:
    def __init__(self, threads: int | None = None):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        d = folder()
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        providers = ["CPUExecutionProvider"]

        def session(name):
            return ort.InferenceSession(str(d / "onnx" / name), sess_options=opts, providers=providers)

        self.tokenizer = Tokenizer.from_file(str(d / "tokenizer.json"))
        self.speech_encoder = session("speech_encoder.onnx")
        self.embed_tokens = session("embed_tokens.onnx")
        self.language_model = session("language_model_q4.onnx")
        self.decoder = session("conditional_decoder.onnx")
        self._embed_inputs = {i.name for i in self.embed_tokens.get_inputs()}
        self._voices: dict[str, tuple] = {}
        self._lock = threading.Lock()

    def condition(self, key: str, audio_24k_fn):
        """Encode a reference voice once; audio_24k_fn() returns mono float32 at 24 kHz."""
        if key not in self._voices:
            audio = np.asarray(audio_24k_fn(), dtype=np.float32)[: SR * 10]
            outs = self.speech_encoder.run(None, {"audio_values": audio[np.newaxis, :]})
            self._voices[key] = tuple(outs)  # cond_emb, prompt_token, speaker_embeddings, speaker_features
            if len(self._voices) > 32:
                self._voices.pop(next(iter(self._voices)))
        return self._voices[key]

    def generate(self, text: str, cond, exaggeration: float = DEFAULT_EXAGGERATION) -> np.ndarray:
        cond_emb, prompt_token, speaker_embeddings, speaker_features = cond
        input_ids = np.array([self.tokenizer.encode(text).ids], dtype=np.int64)
        position_ids = np.where(input_ids >= START_SPEECH_TOKEN, 0,
                                np.arange(input_ids.shape[1])[np.newaxis, :] - 1).astype(np.int64)
        embed_in = {"input_ids": input_ids, "position_ids": position_ids,
                    "exaggeration": np.array([exaggeration], dtype=np.float32)}
        embed_in = {k: v for k, v in embed_in.items() if k in self._embed_inputs}
        tokens = np.array([[START_SPEECH_TOKEN]], dtype=np.int64)
        past = None
        mask = None
        with self._lock:
            for i in range(token_budget(text)):
                embeds = self.embed_tokens.run(None, embed_in)[0]
                if i == 0:
                    embeds = np.concatenate((cond_emb, embeds), axis=1)
                    batch, seq, _ = embeds.shape
                    past = {f"past_key_values.{layer}.{kv}": np.zeros([batch, KV_HEADS, 0, HEAD_DIM], dtype=np.float32)
                            for layer in range(NUM_LAYERS) for kv in ("key", "value")}
                    mask = np.ones((batch, seq), dtype=np.int64)
                logits, *present = self.language_model.run(None, dict(inputs_embeds=embeds, attention_mask=mask, **past))
                scores = apply_repetition_penalty(logits[:, -1, :], tokens[:, -1:])
                nxt = np.argmax(scores, axis=-1, keepdims=True).astype(np.int64)
                tokens = np.concatenate((tokens, nxt), axis=-1)
                if (nxt.flatten() == STOP_SPEECH_TOKEN).all():
                    break
                embed_in["input_ids"] = nxt
                if "position_ids" in embed_in:
                    embed_in["position_ids"] = np.full((1, 1), i + 1, dtype=np.int64)
                mask = np.concatenate([mask, np.ones((mask.shape[0], 1), dtype=np.int64)], axis=1)
                for j, key in enumerate(past):
                    past[key] = present[j]
            speech = tokens[:, 1:]
            if speech.shape[1] and speech[0, -1] == STOP_SPEECH_TOKEN:
                speech = speech[:, :-1]
            speech = np.concatenate([prompt_token, speech], axis=1)
            wav = self.decoder.run(None, {"speech_tokens": speech, "speaker_embeddings": speaker_embeddings,
                                          "speaker_features": speaker_features})[0]
        return limit_peak(trim_silence(np.squeeze(wav, axis=0).astype(np.float32)))


def limit_peak(a: np.ndarray, ceiling: float = 0.95) -> np.ndarray:
    """Chatterbox can overshoot full scale on emphatic lines; scale down instead of clipping."""
    peak = float(np.abs(a).max()) if a.size else 0.0
    return a * (ceiling / peak) if peak > ceiling else a


def trim_silence(a: np.ndarray, threshold: float = 0.006, pad_ms: int = 60) -> np.ndarray:
    idx = np.flatnonzero(np.abs(a) >= threshold)
    if idx.size == 0:
        return a
    pad = SR * pad_ms // 1000
    return a[max(0, idx[0] - pad): min(len(a), idx[-1] + pad)]


_engine: Chatterbox | None = None
_engine_lock = threading.Lock()


def engine() -> Chatterbox:
    global _engine
    with _engine_lock:
        if _engine is None:
            if not available():
                raise FileNotFoundError("Chatterbox is not downloaded. Download it in Settings → Voice, "
                                        "or run: holding-local voice download chatterbox")
            _engine = Chatterbox()
        return _engine


def unload():
    global _engine
    with _engine_lock:
        _engine = None


def cache_dir():
    return state.HOME / "voice-cache" / "chatterbox"


def _norm(text: str) -> str:
    return " ".join(str(text).split())


def _cache_key(text: str, voice: str) -> str:
    import hashlib
    return hashlib.sha1(f"{voice or ''}\u0000{_norm(text)}".encode()).hexdigest()[:20]


def cached(text: str, voice: str, exaggeration: float, tolerance: float = 0.15):
    """A line rendered before in this voice at about this feeling: samples, or None.
    Scripted lines repeat a lot, so this is what makes them instant."""
    d = cache_dir()
    if not d.exists():
        return None
    key = _cache_key(text, voice)
    # The app eases the feeling to 80% at peak distress; treat that as the same take.
    tolerance = max(tolerance, 0.25 * exaggeration)
    best, dist = None, tolerance + 1e-9
    for f in d.glob(f"{key}-*.npy"):
        try:
            x = float(f.stem.rsplit("-", 1)[1])
        except ValueError:
            continue
        if abs(x - exaggeration) <= dist:
            best, dist = f, abs(x - exaggeration)
    if best is None:
        return None
    try:
        return np.load(best)
    except (OSError, ValueError):
        return None


def store(text: str, voice: str, exaggeration: float, samples: np.ndarray):
    d = cache_dir()
    d.mkdir(parents=True, exist_ok=True)
    # float16 halves the size and is far below what anyone can hear
    np.save(d / f"{_cache_key(text, voice)}-{exaggeration:.2f}.npy", samples.astype(np.float16))


def cache_bytes() -> int:
    d = cache_dir()
    return sum(f.stat().st_size for f in d.glob("*.npy")) if d.exists() else 0


def clear_cache() -> int:
    import shutil
    n = cache_bytes()
    shutil.rmtree(cache_dir(), ignore_errors=True)
    return n


_live = 0  # live requests in flight; pre-rendering yields to them
_live_lock = threading.Lock()


def synthesize(text: str, voice: str, exaggeration: float | None, quality: str, live: bool = True):
    """Returns (samples float32, 24000). The reference voice is Kokoro's rendering of `voice`."""
    global _live
    from . import tts
    ex = float(exaggeration if exaggeration is not None else DEFAULT_EXAGGERATION)
    ex = round(min(max(ex, 0.25), 1.5), 2)
    hit = cached(text, voice, ex)
    if hit is not None:
        return hit.astype(np.float32), SR
    e = engine()

    def reference():
        samples, sr = tts.synthesize(REF_TEXT, voice, 0.95, quality)
        return resample(np.asarray(samples, dtype=np.float32), sr)

    if live:
        with _live_lock:
            _live += 1
    try:
        cond = e.condition(f"kokoro:{voice or ''}", reference)
        gap = np.zeros(int(SR * 0.3), dtype=np.float32)
        out = []
        for part in split_long(text):
            if out:
                out.append(gap)
            out.append(e.generate(part, cond, ex))
        wav = np.concatenate(out) if out else np.zeros(1, dtype=np.float32)
    finally:
        if live:
            with _live_lock:
                _live -= 1
    try:
        store(text, voice, ex, wav)
    except OSError:
        pass
    return wav, SR


def live_busy() -> bool:
    return _live > 0


# ---------- pre-rendering a parent's scripted lines in the background ----------
_job: dict = {}


def prerender_status() -> dict:
    j = dict(_job)
    j.pop("cancel", None)
    j.pop("texts", None)
    return j or {"running": False, "done": 0, "total": 0}


def prerender(texts: list[str], voice: str, exaggeration: float | None, quality: str, wait: bool = False) -> dict:
    """Render every line not already cached, one at a time, pausing while the app is speaking live."""
    global _job
    import time
    if _job.get("running"):
        _job["cancel"] = True
        for _ in range(600):
            if not _job.get("running"):
                break
            time.sleep(0.1)
    ex = round(min(max(float(exaggeration if exaggeration is not None else DEFAULT_EXAGGERATION), 0.25), 1.5), 2)
    seen, todo = set(), []
    for t in texts:
        t = _norm(t)
        if t and t not in seen:
            seen.add(t)
            todo.append(t)
    job = {"running": True, "voice": voice, "feeling": ex, "total": len(todo), "done": 0, "rendered": 0,
           "seconds": 0.0, "error": None, "started": time.time()}
    _job = job

    def run():
        try:
            for t in todo:
                if job.get("cancel"):
                    break
                if cached(t, voice, ex) is None:
                    while live_busy() and not job.get("cancel"):
                        time.sleep(0.2)
                    t0 = time.time()
                    synthesize(t, voice, ex, quality, live=False)
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
        threading.Thread(target=run, name="chatterbox-prerender", daemon=True).start()
    return prerender_status()


def cancel_prerender():
    if _job.get("running"):
        _job["cancel"] = True
