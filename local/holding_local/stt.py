"""Optional speech-to-text via faster-whisper (pip extra 'stt')."""
import tempfile
import threading

_lock = threading.Lock()
_models = {}


def installed() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def transcribe(data: bytes, size: str, language: str | None = None, prompt: str | None = None) -> dict:
    from faster_whisper import WhisperModel
    with _lock:
        m = _models.get(size)
        if m is None:
            m = WhisperModel(size, device="auto", compute_type="int8")
            _models[size] = m
    with tempfile.NamedTemporaryFile(suffix=".audio") as f:
        f.write(data)
        f.flush()
        segments, info = m.transcribe(f.name, language=language or None, initial_prompt=prompt,
                                      vad_filter=True, beam_size=1)
        segs = list(segments)
    text = " ".join(s.text.strip() for s in segs).strip()
    return {"text": text, "language": info.language, "duration": info.duration}
