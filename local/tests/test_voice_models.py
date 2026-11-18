"""Voice models: the manager endpoints, the Chatterbox and Turbo loops (with stand-in
ONNX sessions), the Mac voices' plumbing, and with real weights:

    uv run --with pytest pytest -q tests/test_voice_models.py
    HOLDING_REAL_CHATTERBOX=1 uv run --with pytest pytest -q -k real_chatterbox   # Chatterbox + Turbo
    HOLDING_REAL_MLX=1 HOLDING_MLX_MODELS=qwen3-tts-small,csm uv run ... -k real_mac  # on a Mac
"""
import os

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from holding_local import chatterbox, expressive, mlx_voices, state, voice_models
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


def fake_chatterbox_files(mid="chatterbox"):
    for p in chatterbox.file_paths(mid):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * 1000)


def test_listing_and_auth(home):
    c, _ = client(home)
    assert c.get("/v1/voice-models").status_code == 401
    data = c.get("/v1/voice-models", headers=AUTH).json()
    by = {m["id"]: m for m in data["models"]}
    assert list(by)[:3] == ["kokoro", "chatterbox", "chatterbox-turbo"]
    assert {"qwen3-tts", "qwen3-tts-small", "chatterbox-mac", "chatterbox-turbo-mac", "orpheus", "csm", "dia"} <= set(by)
    cb = by["chatterbox"]
    assert cb["downloaded"] is False and cb["bytes"] == 0 and cb["deletable"] and cb["feeling"] and cb["runs_here"]
    assert by["chatterbox-turbo"]["feeling"] is False and by["chatterbox-turbo"]["group"] == "any"
    assert by["qwen3-tts"]["group"] == "mac" and by["qwen3-tts"]["feeling"]
    assert by["qwen3-tts"]["runs_here"] == mlx_voices.supported()
    assert data["selected"] == "kokoro" and data["disk"]["free_bytes"] > 0
    assert by["kokoro"]["deletable"] is False


def test_select_needs_download_then_delete_frees_space(home):
    c, cfg = client(home)
    r = c.post("/v1/voice-models/select", json={"id": "chatterbox"}, headers=AUTH)
    assert r.status_code == 409
    fake_chatterbox_files()
    info = voice_models.info("chatterbox", cfg)
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
        return [type("I", (), {"name": n, "type": "tensor(float)"})() for n in self._inputs]


def fake_engine(script, mid="chatterbox", layers=30):
    """A Chatterbox (or Turbo) whose language model emits `script` then the stop token."""
    turbo = mid == "chatterbox-turbo"
    e = chatterbox.Chatterbox.__new__(chatterbox.Chatterbox)
    e.variant = chatterbox.VARIANTS[mid]
    e.tokenizer = type("T", (), {"encode": lambda self, t: type("E", (), {"ids": [255, 10, 11, 0, chatterbox.START_SPEECH_TOKEN]})()})()
    seen = {"steps": 0, "exaggeration": None, "speech": None, "positions": []}

    def embed(feeds):
        if "exaggeration" in feeds:
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
        if "position_ids" in feeds:
            seen["positions"].append(feeds["position_ids"].tolist())
        present = [np.zeros((1, 16, n, 64), dtype=np.float32) for _ in range(2 * layers)]
        return [logits, *present]

    def dec(feeds):
        seen["speech"] = feeds["speech_tokens"].tolist()
        return [np.full((1, 4800), 0.5, dtype=np.float32)]

    past = [f"past_key_values.{i}.{kv}" for i in range(layers) for kv in ("key", "value")]
    e.embed_tokens = FakeSession(embed, ["input_ids"] if turbo else ["input_ids", "position_ids", "exaggeration"])
    e.language_model = FakeSession(lm, ["inputs_embeds", "attention_mask", *(["position_ids"] if turbo else []), *past])
    e.decoder = FakeSession(dec)
    e._init_io()
    e._voices = {}
    import threading
    e._lock = threading.Lock()
    return e, seen


def test_generation_loop_feeds_the_decoder():
    e, seen = fake_engine([100, 200, 300])
    cond = (np.zeros((1, 3, 4), np.float32), np.array([[7, 8]], np.int64), np.zeros((1, 192), np.float32),
            np.zeros((1, 10, 80), np.float32))
    wav = e.generate("Hi", cond, exaggeration=0.7)
    assert seen["speech"] == [[7, 8, 100, 200, 300]]  # prompt tokens + generated, no start/stop
    assert seen["exaggeration"] == pytest.approx(0.7)
    assert seen["steps"] == 4 and wav.dtype == np.float32 and len(wav) > 0


def test_turbo_loop_pads_silence_and_tracks_positions():
    e, seen = fake_engine([100, 200], mid="chatterbox-turbo", layers=24)
    cond = (np.zeros((1, 3, 4), np.float32), np.array([[7, 8]], np.int64), np.zeros((1, 192), np.float32),
            np.zeros((1, 10, 80), np.float32))
    e.generate("Hi", cond)
    s = chatterbox.SILENCE_TOKEN
    assert seen["speech"] == [[7, 8, 100, 200, s, s, s]]
    assert seen["exaggeration"] is None  # Turbo has no dial
    # 3 conditioning + 5 text positions first, then one new position a step
    assert seen["positions"][0] == [list(range(8))] and seen["positions"][1] == [[8]] and seen["positions"][2] == [[9]]


def test_split_long_and_budget():
    assert chatterbox.split_long("Short.") == ["Short."]
    parts = chatterbox.split_long("One sentence here. " * 40, limit=100)
    assert all(len(p) <= 100 for p in parts) and len(parts) > 5
    assert chatterbox.token_budget("x" * 1000) == 1000


@pytest.mark.skipif(os.environ.get("HOLDING_REAL_CHATTERBOX") != "1", reason="downloads the real models")
@pytest.mark.parametrize("mid", ["chatterbox", "chatterbox-turbo"])
def test_real_chatterbox_speaks(mid):
    """Real weights, the path the app takes: Kokoro renders the parent's voice, the model copies it
    and speaks a line (at two feelings when it has a dial). Set HOLDING_SAMPLES_DIR to keep the WAVs."""
    import time
    from holding_local import tts
    cfg = dict(state.DEFAULTS)
    for m in ("kokoro", mid):
        if not voice_models.info(m, cfg)["downloaded"]:
            job = voice_models.download(m, cfg, wait=True)
            assert job["error"] is None, job["error"]
    dest = os.environ.get("HOLDING_SAMPLES_DIR")
    lines = {
        "steady-grandmother": "Oh, sweetheart. I'm right here. You don't have to say anything at all.",
        "gentle-giant": "That sounds like it really hurt. Of course you're tired. Come sit with me a while.",
    }
    feelings = (0.35, 0.8) if expressive.has_feeling(mid) else (0.55,)
    for arch, text in lines.items():
        for ex in feelings:
            t0 = time.time()
            wav, sr = expressive.synthesize(mid, text, arch, ex, cfg["tts_quality"])
            secs = len(wav) / sr
            took = time.time() - t0
            print(f"{mid} {arch} feeling {ex}: {secs:.2f}s of audio in {took:.2f}s ({secs / took:.2f}x real time)")
            assert sr == chatterbox.SR
            assert 1.5 < secs < 20.0, secs  # a real sentence, not silence or a runaway
            # Nobody says it faster than about 22 characters a second: shorter means the line was cut.
            assert secs > 0.045 * len(text), f"{secs:.2f}s for {len(text)} characters"
            assert np.abs(wav).max() > 0.05
            if dest:
                os.makedirs(dest, exist_ok=True)
                tag = f"-feeling-{ex}" if len(feelings) > 1 else ""
                with open(os.path.join(dest, f"{arch}-{mid}{tag}.wav"), "wb") as f:
                    f.write(tts.to_wav(wav, sr))
        t0 = time.time()
        again, _ = expressive.synthesize(mid, text, arch, feelings[-1], cfg["tts_quality"])
        print(f"{mid} {arch} repeat (kept line): {time.time() - t0:.3f}s")
        assert time.time() - t0 < 1.0 and len(again) == len(wav)
        if dest and not os.path.exists(os.path.join(dest, f"{arch}-kokoro.wav")):
            k, ksr = tts.synthesize(text, arch, None, cfg["tts_quality"])
            with open(os.path.join(dest, f"{arch}-kokoro.wav"), "wb") as f:
                f.write(tts.to_wav(np.asarray(k), ksr))


def test_line_cache_and_prerender(home, monkeypatch):
    """Rendered lines are kept and reused at a nearby feeling; pre-rendering skips what's cached."""
    monkeypatch.setattr(state, "HOME", home)
    calls = []

    class E:
        def condition(self, key, fn):
            return ("cond",)

        def generate(self, text, cond, ex):
            calls.append((text, ex))
            return np.full(24000, 0.25, dtype=np.float32)

    monkeypatch.setattr(chatterbox, "engine", lambda mid="chatterbox": E())
    syn = expressive.synthesize
    wav, sr = syn("chatterbox", "I'm  here.", "bf_emma", 0.55, "int8")
    assert sr == chatterbox.SR and len(calls) == 1
    wav2, _ = syn("chatterbox", "I'm here.", "bf_emma", 0.6, "int8")  # same line, close feeling: cached
    assert len(calls) == 1 and np.allclose(wav, wav2, atol=1e-3)
    syn("chatterbox", "I'm here.", "bf_emma", 0.9, "int8")  # far feeling: new render
    syn("chatterbox", "I'm here.", "am_michael", 0.55, "int8")  # other voice: new render
    assert len(calls) == 3
    syn("chatterbox-turbo", "I'm here.", "bf_emma", 0.3, "int8")  # other model: its own take
    syn("chatterbox-turbo", "I'm here.", "bf_emma", 0.9, "int8")  # no dial: one take serves every feeling
    assert len(calls) == 4
    job = expressive.prerender("chatterbox", ["I'm here.", "Still here.", "Still here.", "  "], "bf_emma", 0.55, "int8", wait=True)
    assert job["total"] == 2 and job["done"] == 2 and job["rendered"] == 1 and not job["running"]
    assert expressive.cache_bytes("chatterbox") > 0 and expressive.cache_bytes("chatterbox-turbo") > 0


def test_prerender_endpoint_and_delete_clears_lines(home, monkeypatch):
    monkeypatch.setattr(state, "HOME", home)
    c, _ = client(home)
    assert c.post("/v1/voice-prerender", json={"texts": ["Hi."]}, headers=AUTH).status_code == 409
    fake_chatterbox_files()
    seen = {}
    monkeypatch.setattr(expressive, "prerender", lambda mid, texts, voice, ex, q: seen.update(mid=mid, texts=texts, voice=voice, ex=ex) or {"running": True})
    r = c.post("/v1/voice-prerender", json={"model": "chatterbox", "texts": ["Hi.", " "], "voice": "bf_emma", "exaggeration": 0.7}, headers=AUTH)
    assert r.status_code == 200 and seen == {"mid": "chatterbox", "texts": ["Hi."], "voice": "bf_emma", "ex": 0.7}
    expressive.store("chatterbox", "Hi.", "bf_emma", 0.7, np.zeros(100, np.float32), 24000)
    assert expressive.cache_bytes("chatterbox") > 0
    r = c.delete("/v1/voice-models/chatterbox", headers=AUTH).json()
    assert expressive.cache_bytes("chatterbox") == 0 and r["freed_bytes"] > 1000 * len(chatterbox.FILES)


# ---------- Mac voices (mlx-audio) ----------
def test_mac_voice_helpers():
    assert mlx_voices.gender("af_nicole:0.55+am_michael:0.45") == "female"
    assert mlx_voices.gender("af_nicole:0.3+am_michael:0.7") == "male"
    assert mlx_voices.gender("bm_george") == "male" and mlx_voices.gender("") == "female"
    calm, mid, warm = (mlx_voices.instruction(x) for x in (0.3, 0.55, 0.9))
    assert len({calm, mid, warm}) == 3 and "softly" in calm


def test_mac_voice_generate_maps_style(monkeypatch, tmp_path):
    seen = {}

    class M:
        sample_rate = 24000

        def generate(self, text, **kw):
            seen[text] = kw
            yield type("R", (), {"audio": np.ones(2400, np.float32), "sample_rate": 44100})()

    monkeypatch.setattr(mlx_voices, "downloaded", lambda mid: True)
    monkeypatch.setattr(mlx_voices, "_load", lambda mid: M())
    ref = tmp_path / "ref.wav"
    wav, sr = mlx_voices.generate("qwen3-tts", "Hi.", "am_michael", 0.3, None, "ref")
    assert sr == 44100 and len(wav) == 2400
    assert seen["Hi."]["voice"] == "ryan" and "softly" in seen["Hi."]["instruct"]
    mlx_voices.generate("chatterbox-mac", "A.", "af_heart", 0.8, ref, "ref")
    assert seen["A."]["ref_audio"] == str(ref) and seen["A."]["exaggeration"] == 0.8
    mlx_voices.generate("chatterbox-turbo-mac", "B.", "af_heart", 0.8, ref, "ref")
    assert "exaggeration" not in seen["B."]
    mlx_voices.generate("orpheus", "C.", "af_heart", 0.8, None, "ref")
    assert seen["C."]["voice"] == "tara"
    mlx_voices.generate("csm", "D.", "af_heart", 0.8, ref, "the ref")
    assert seen["D."]["ref_text"] == "the ref"
    mlx_voices.generate("dia", "E.", "af_heart", 0.8, ref, "the ref")
    assert seen["[S1] E."]["ref_text"] == "[S1] the ref"


def test_mac_voice_delete_keeps_shared_helpers(home, monkeypatch, tmp_path):
    hub = tmp_path / "hub"
    monkeypatch.setattr(mlx_voices, "hub_cache", lambda: hub)

    def fake_repo(repo, n):
        d = mlx_voices.repo_dir(repo) / "blobs"
        d.mkdir(parents=True, exist_ok=True)
        (d / "x").write_bytes(b"x" * n)

    for mid in ("chatterbox-mac", "chatterbox-turbo-mac"):
        fake_repo(mlx_voices.CATALOG[mid]["repo"], 1000)
        mlx_voices._marker(mid).parent.mkdir(parents=True, exist_ok=True)
        mlx_voices._marker(mid).write_text("1")
    fake_repo("mlx-community/S3TokenizerV2", 500)  # shared by both
    assert mlx_voices.downloaded("chatterbox-mac")
    # the shared helper is counted once
    assert mlx_voices.bytes_on_disk("chatterbox-mac") + mlx_voices.bytes_on_disk("chatterbox-turbo-mac") == 2500
    assert mlx_voices.delete("chatterbox-mac") == 1000  # helper kept: Turbo still needs it
    assert mlx_voices.repo_dir("mlx-community/S3TokenizerV2").exists()
    assert mlx_voices.bytes_on_disk("chatterbox-turbo-mac") == 1500
    assert mlx_voices.delete("chatterbox-turbo-mac") == 1500
    assert not mlx_voices.repo_dir("mlx-community/S3TokenizerV2").exists()


@pytest.mark.skipif(mlx_voices.supported(), reason="checks the non-Mac path")
def test_mac_voices_say_why_off_mac(home):
    c, cfg = client(home)
    r = c.post("/v1/voice-models/select", json={"id": "qwen3-tts"}, headers=AUTH)
    assert r.status_code == 409 and "Apple silicon" in r.json()["detail"]
    job = voice_models.download("qwen3-tts", cfg, wait=True)
    assert "Apple silicon" in job["error"]


@pytest.mark.skipif(os.environ.get("HOLDING_REAL_MLX") != "1", reason="downloads real Mac voices")
def test_real_mac_voices_speak():
    """On Apple silicon: install mlx-audio, download each model in HOLDING_MLX_MODELS, speak a line."""
    import time
    from holding_local import tts
    cfg = dict(state.DEFAULTS)
    if not voice_models.info("kokoro", cfg)["downloaded"]:
        assert voice_models.download("kokoro", cfg, wait=True)["error"] is None
    dest = os.environ.get("HOLDING_SAMPLES_DIR")
    text = "Oh, sweetheart. I'm right here. You don't have to say anything at all."
    failures = []
    for mid in [m for m in os.environ.get("HOLDING_MLX_MODELS", "qwen3-tts-small").split(",") if m]:
        t0 = time.time()
        job = voice_models.download(mid, cfg, wait=True)
        print(f"{mid}: download + first line in {time.time() - t0:.0f}s, error={job['error']}")
        if job["error"]:
            failures.append(f"{mid}: {job['error']}")
            continue
        for voice in ("steady-grandmother", "gentle-giant"):
            t0 = time.time()
            wav, sr = expressive.synthesize(mid, text, voice, 0.8, cfg["tts_quality"])
            secs, took = len(wav) / sr, time.time() - t0
            print(f"{mid} {voice}: {secs:.2f}s of audio in {took:.2f}s ({secs / took:.2f}x real time)")
            if not (1.5 < secs < 25.0 and np.abs(wav).max() > 0.02):
                failures.append(f"{mid} {voice}: {secs:.2f}s, peak {np.abs(wav).max():.3f}")
            if dest:
                os.makedirs(dest, exist_ok=True)
                with open(os.path.join(dest, f"{voice}-{mid}.wav"), "wb") as f:
                    f.write(tts.to_wav(wav, sr))
        if os.environ.get("HOLDING_MLX_DELETE_AFTER") == "1":
            print(f"{mid}: deleted, {voice_models.delete(mid, cfg) / 1e9:.2f} GB freed")
    assert not failures, failures


def test_a_line_cut_short_falls_back_and_is_not_kept(home, monkeypatch):
    monkeypatch.setattr(state, "HOME", home)

    class E:
        def condition(self, key, fn):
            return ("cond",)

        def generate(self, text, cond, ex):
            return np.full(int(0.9 * chatterbox.SR), 0.25, dtype=np.float32)  # 0.9 s for a long sentence

    monkeypatch.setattr(chatterbox, "engine", lambda mid="chatterbox": E())
    text = "That sounds like it really hurt. Of course you're tired. Come sit with me a while."
    with pytest.raises(RuntimeError, match="stopped early"):
        expressive.synthesize("chatterbox", text, "am_michael", 0.35, "int8")
    assert expressive.cache_bytes("chatterbox") == 0
    fake_chatterbox_files()
    from holding_local import tts
    monkeypatch.setattr(tts, "synthesize", lambda t, v, s, q: (np.zeros(48000, dtype=np.float32), 24000))
    c, _ = client(home)
    r = c.post("/v1/audio/speech", json={"model": "chatterbox", "input": text, "voice": "am_michael"}, headers=AUTH)
    assert r.status_code == 200 and r.headers["x-voice-model"] == "kokoro"


def test_penalty_covers_every_token_so_far():
    e, seen = fake_engine([100, 100, 100])  # a model that wants to repeat
    cond = (np.zeros((1, 3, 4), np.float32), np.array([[7]], np.int64), np.zeros((1, 192), np.float32),
            np.zeros((1, 10, 80), np.float32))
    e.generate("Hi.", cond)
    assert seen["speech"] == [[7, 100, 100, 100]]  # a strong preference still wins over the penalty


def test_no_stop_before_the_text_could_have_been_said():
    e, seen = fake_engine([100])  # wants to stop after one token
    cond = (np.zeros((1, 3, 4), np.float32), np.array([[7]], np.int64), np.zeros((1, 192), np.float32),
            np.zeros((1, 10, 80), np.float32))
    e.generate("Hello", cond)  # 5 characters: no stop before 5 speech tokens
    assert len(seen["speech"][0]) - 1 == 5 and seen["steps"] == 6
