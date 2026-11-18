"""Voice models: the manager endpoints, the Chatterbox loop (with stand-in ONNX
sessions), and, with HOLDING_REAL_CHATTERBOX=1, the real 1.5 GB model.

    uv run --with pytest pytest -q tests/test_voice_models.py
    HOLDING_REAL_CHATTERBOX=1 uv run --with pytest pytest -q -k real   # downloads the model
"""
import os

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from holding_local import chatterbox, state, voice_models
from holding_local.server import create_app

AUTH = {"authorization": "Bearer ABCD-2345"}


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "MODELS", tmp_path / "models")
    monkeypatch.setattr(state, "save", lambda cfg: None)
    voice_models._jobs.clear()
    return tmp_path


def client(home):
    (home / "index.html").write_text("<!doctype html>app")
    cfg = dict(state.DEFAULTS, token="ABCD-2345", app_dir=str(home), ollama_url="http://ollama")
    app = create_app(cfg)
    app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(404)))
    return TestClient(app), cfg


def fake_chatterbox_files():
    for p in chatterbox.file_paths():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * 1000)


def test_listing_and_auth(home):
    c, _ = client(home)
    assert c.get("/v1/voice-models").status_code == 401
    data = c.get("/v1/voice-models", headers=AUTH).json()
    ids = [m["id"] for m in data["models"]]
    assert ids == ["kokoro", "chatterbox"]
    cb = data["models"][1]
    assert cb["downloaded"] is False and cb["bytes"] == 0 and cb["deletable"] and cb["feeling"]
    assert data["selected"] == "kokoro" and data["disk"]["free_bytes"] > 0
    assert data["models"][0]["deletable"] is False


def test_select_needs_download_then_delete_frees_space(home):
    c, cfg = client(home)
    r = c.post("/v1/voice-models/select", json={"id": "chatterbox"}, headers=AUTH)
    assert r.status_code == 409
    fake_chatterbox_files()
    info = c.get("/v1/voice-models", headers=AUTH).json()["models"][1]
    assert info["downloaded"] and info["bytes"] == 1000 * len(chatterbox.FILES)
    assert c.post("/v1/voice-models/select", json={"id": "chatterbox"}, headers=AUTH).json() == {"selected": "chatterbox"}
    assert cfg["tts_engine"] == "chatterbox"
    r = c.delete("/v1/voice-models/chatterbox", headers=AUTH).json()
    assert r["freed_bytes"] == 1000 * len(chatterbox.FILES) and r["selected"] == "kokoro"
    assert not chatterbox.folder().exists()
    assert c.delete("/v1/voice-models/kokoro", headers=AUTH).status_code == 409
    assert c.delete("/v1/voice-models/nope", headers=AUTH).status_code == 404


def test_download_resumes_and_reports_progress(home, monkeypatch):
    payload = b"0123456789" * 100

    def handler(request):
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-length": str(len(payload))})
        rng = request.headers.get("range")
        if rng:
            start = int(rng.split("=")[1].rstrip("-"))
            return httpx.Response(206, content=payload[start:])
        return httpx.Response(200, content=payload)

    real_client = httpx.Client
    monkeypatch.setattr(voice_models.httpx, "Client", lambda *a, **k: real_client(transport=httpx.MockTransport(handler)))
    first = chatterbox.file_paths()[0]
    first.parent.mkdir(parents=True, exist_ok=True)
    first.with_suffix(first.suffix + ".part").write_bytes(payload[:300])  # an interrupted download
    job = voice_models.download("chatterbox", dict(state.DEFAULTS), wait=True)
    assert job["error"] is None and not job["running"]
    assert job["total"] == len(payload) * len(chatterbox.FILES) == job["done"]
    assert first.read_bytes() == payload
    assert chatterbox.available()


def test_speech_falls_back_to_kokoro_when_chatterbox_missing(home, monkeypatch):
    from holding_local import tts
    monkeypatch.setattr(tts, "synthesize", lambda text, voice, speed, q: (np.zeros(2400, dtype=np.float32), 24000))
    c, _ = client(home)
    r = c.post("/v1/audio/speech", json={"model": "chatterbox", "input": "I'm here.", "voice": "af_heart"}, headers=AUTH)
    assert r.status_code == 200 and r.headers["x-voice-model"] == "kokoro"


class FakeSession:
    def __init__(self, fn, inputs=()):
        self.fn, self._inputs = fn, inputs

    def run(self, _, feeds):
        return self.fn(feeds)

    def get_inputs(self):
        return [type("I", (), {"name": n})() for n in self._inputs]


def fake_engine(script):
    """A Chatterbox whose language model emits `script` then the stop token."""
    e = chatterbox.Chatterbox.__new__(chatterbox.Chatterbox)
    e.tokenizer = type("T", (), {"encode": lambda self, t: type("E", (), {"ids": [255, 10, 11, 0, chatterbox.START_SPEECH_TOKEN]})()})()
    seen = {"steps": 0, "exaggeration": None, "speech": None}

    def embed(feeds):
        seen["exaggeration"] = float(feeds["exaggeration"][0])
        return [np.zeros((1, feeds["input_ids"].shape[1], 4), dtype=np.float32)]

    def lm(feeds):
        step = seen["steps"]
        seen["steps"] += 1
        logits = np.zeros((1, feeds["inputs_embeds"].shape[1], 6563), dtype=np.float32)
        tok = script[step] if step < len(script) else chatterbox.STOP_SPEECH_TOKEN
        logits[0, -1, tok] = 5.0
        n = feeds["attention_mask"].shape[1]
        assert feeds["past_key_values.0.key"].shape[2] == n - feeds["inputs_embeds"].shape[1]
        present = [np.zeros((1, 16, n, 64), dtype=np.float32) for _ in range(60)]
        return [logits, *present]

    def dec(feeds):
        seen["speech"] = feeds["speech_tokens"].tolist()
        return [np.full((1, 4800), 0.5, dtype=np.float32)]

    e.embed_tokens = FakeSession(embed, ["input_ids", "position_ids", "exaggeration"])
    e._embed_inputs = {"input_ids", "position_ids", "exaggeration"}
    e.language_model = FakeSession(lm)
    e.decoder = FakeSession(dec)
    e._voices = {}
    import threading
    e._lock = threading.Lock()
    return e, seen


def test_generation_loop_feeds_the_decoder():
    e, seen = fake_engine([100, 200, 300])
    cond = (np.zeros((1, 3, 4), np.float32), np.array([[7, 8]], np.int64), np.zeros((1, 192), np.float32),
            np.zeros((1, 10, 80), np.float32))
    wav = e.generate("I'm here.", cond, exaggeration=0.7)
    assert seen["speech"] == [[7, 8, 100, 200, 300]]  # prompt tokens + generated, no start/stop
    assert seen["exaggeration"] == pytest.approx(0.7)
    assert seen["steps"] == 4 and wav.dtype == np.float32 and len(wav) > 0


def test_split_long_and_budget():
    assert chatterbox.split_long("Short.") == ["Short."]
    parts = chatterbox.split_long("One sentence here. " * 40, limit=100)
    assert all(len(p) <= 100 for p in parts) and len(parts) > 5
    assert chatterbox.token_budget("x" * 1000) == 1000


@pytest.mark.skipif(os.environ.get("HOLDING_REAL_CHATTERBOX") != "1", reason="downloads the 1.5 GB model")
def test_real_chatterbox_speaks():
    """Real weights, the path the app takes: Kokoro renders the parent's voice, Chatterbox copies it
    and speaks a line at two feelings. Set HOLDING_SAMPLES_DIR to keep the WAVs for a listen."""
    import time
    from holding_local import tts
    cfg = dict(state.DEFAULTS)
    for mid in ("kokoro", "chatterbox"):
        if not voice_models.info(mid, cfg)["downloaded"]:
            job = voice_models.download(mid, cfg, wait=True)
            assert job["error"] is None, job["error"]
    dest = os.environ.get("HOLDING_SAMPLES_DIR")
    lines = {
        "steady-grandmother": "Oh, sweetheart. I'm right here. You don't have to say anything at all.",
        "gentle-giant": "That sounds like it really hurt. Of course you're tired. Come sit with me a while.",
    }
    for arch, text in lines.items():
        for ex in (0.35, 0.8):
            t0 = time.time()
            wav, sr = chatterbox.synthesize(text, arch, ex, cfg["tts_quality"])
            secs = len(wav) / sr
            took = time.time() - t0
            print(f"{arch} feeling {ex}: {secs:.2f}s of audio in {took:.2f}s ({secs / took:.2f}x real time)")
            assert sr == chatterbox.SR
            assert 1.5 < secs < 20.0, secs  # a real sentence, not silence or a runaway
            assert np.abs(wav).max() > 0.05
            if dest:
                os.makedirs(dest, exist_ok=True)
                with open(os.path.join(dest, f"{arch}-chatterbox-feeling-{ex}.wav"), "wb") as f:
                    f.write(tts.to_wav(wav, sr))
        if dest:
            k, ksr = tts.synthesize(text, arch, None, cfg["tts_quality"])
            with open(os.path.join(dest, f"{arch}-kokoro.wav"), "wb") as f:
                f.write(tts.to_wav(np.asarray(k), ksr))
