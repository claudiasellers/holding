"""Kokoro text-to-speech, OpenAI /v1/audio/speech compatible."""
import io
import re
import shutil
import subprocess
import threading
import wave

import numpy as np

from . import catalog, state

_lock = threading.Lock()
_engine = None
_error = None


def model_paths(quality: str):
    name = catalog.KOKORO_FILES.get(quality, catalog.KOKORO_FILES["int8"])[0]
    return state.MODELS / name, state.MODELS / catalog.KOKORO_FILES["voices"][0]


def available(quality: str) -> bool:
    m, v = model_paths(quality)
    return m.exists() and v.exists()


def engine(quality: str):
    global _engine, _error
    with _lock:
        if _engine is None:
            from kokoro_onnx import Kokoro  # imported lazily: onnxruntime is slow to import
            m, v = model_paths(quality)
            if not (m.exists() and v.exists()):
                raise FileNotFoundError("Voice model not downloaded yet. Run: holding-local setup")
            _engine = Kokoro(str(m), str(v))
        return _engine


def resolve_voice(k, spec: str):
    """'af_heart' | 'af_nicole+am_michael' | 'af_nicole:0.6+am_michael:0.4' | archetype id | OpenAI alias."""
    spec = (spec or catalog.DEFAULT_VOICE).strip()
    preset = catalog.ARCHETYPE_VOICES.get(spec)
    speed_hint = None
    if preset:
        spec, speed_hint = preset["voice"], preset["speed"]
    spec = catalog.OPENAI_VOICE_ALIASES.get(spec, spec)
    names = set(k.get_voices())
    parts = [p for p in spec.split("+") if p]
    if len(parts) == 1 and ":" not in parts[0]:
        if parts[0] not in names:
            raise ValueError(f"Unknown voice '{parts[0]}'")
        return parts[0], speed_hint
    styles, weights = [], []
    for p in parts:
        name, _, w = p.partition(":")
        if name not in names:
            raise ValueError(f"Unknown voice '{name}'")
        styles.append(k.get_voice_style(name))
        weights.append(float(w) if w else 1.0)
    weights = np.array(weights, dtype=np.float32)
    weights /= weights.sum()
    blended = sum(s * w for s, w in zip(styles, weights))
    return blended.astype(np.float32), speed_hint


def _lang_for(voice_spec: str) -> str:
    first = re.split(r"[+:]", voice_spec or "a")[0]
    return "en-gb" if first.startswith("b") else "en-us"


def synthesize(text: str, voice: str, speed: float | None, quality: str):
    k = engine(quality)
    v, speed_hint = resolve_voice(k, voice)
    spd = float(speed if speed is not None else (speed_hint or 1.0))
    spd = min(max(spd, 0.5), 2.0)
    preset = catalog.ARCHETYPE_VOICES.get(voice or "")
    lang = _lang_for(preset["voice"] if preset else catalog.OPENAI_VOICE_ALIASES.get(voice, voice))
    samples, sr = k.create(text, voice=v, speed=spd, lang=lang)
    return np.asarray(samples, dtype=np.float32), sr


def to_wav(samples: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def encode(samples: np.ndarray, sr: int, fmt: str):
    """Returns (bytes, media_type). mp3/opus/aac/flac need ffmpeg; without it we send WAV."""
    fmt = (fmt or "wav").lower()
    if fmt == "pcm":
        return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes(), "audio/pcm"
    wav = to_wav(samples, sr)
    codecs = {"mp3": ("mp3", "audio/mpeg"), "opus": ("ogg", "audio/ogg"),
              "aac": ("adts", "audio/aac"), "flac": ("flac", "audio/flac")}
    if fmt in codecs and shutil.which("ffmpeg"):
        container, media = codecs[fmt]
        extra = ["-c:a", "libopus"] if fmt == "opus" else []
        p = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", *extra,
                            "-f", container, "pipe:1"], input=wav, capture_output=True)
        if p.returncode == 0 and p.stdout:
            return p.stdout, media
    return wav, "audio/wav"


def voices(quality: str) -> list[str]:
    try:
        return sorted(engine(quality).get_voices())
    except Exception:
        return []
