"""Chat model manager and the Mac app's JSON setup progress. No Ollama needed."""
import json

import pytest

import httpx
from fastapi.testclient import TestClient

from holding_local import chat_models, cli, setup, state
from holding_local.server import create_app

TAGS = [
    {"name": "gemma4:e4b", "size": 9_600_000_000, "details": {"family": "gemma4", "parameter_size": "8B"}},
    {"name": "qwen3.5:4b", "size": 3_400_000_000, "details": {"family": "qwen3", "parameter_size": "4B"}},
    {"name": "nomic-embed-text:latest", "size": 274_000_000, "details": {"family": "nomic-bert"}},
]


def fake_ollama(log):
    models = [dict(m) for m in TAGS]

    def handler(request: httpx.Request):
        log.append((request.method, request.url.path, request.content))
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": models})
        if request.url.path == "/api/delete":
            name = json.loads(request.content)["model"]
            models[:] = [m for m in models if m["name"] != name]
            return httpx.Response(200)
        if request.url.path == "/api/pull":
            lines = [{"status": "pulling manifest"}, {"status": "downloading", "total": 100, "completed": 40},
                     {"status": "downloading", "total": 100, "completed": 100}, {"status": "success"}]
            return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode())
        return httpx.Response(404)
    return handler


def client(tmp_path, monkeypatch, log):
    monkeypatch.setattr(state, "save", lambda c: None)
    (tmp_path / "index.html").write_text("app")
    cfg = dict(state.DEFAULTS, llm_model="gemma4:e4b", token="ABCD-2345", app_dir=str(tmp_path),
               ollama_url="http://ollama")
    app = create_app(cfg)
    app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(fake_ollama(log)))
    return TestClient(app, headers={"authorization": "Bearer ABCD-2345"}), cfg


def test_same_name():
    assert chat_models.same("nomic-embed-text", "nomic-embed-text:latest")
    assert chat_models.same("hf.co/a/b", "hf.co/a/b:latest")
    assert not chat_models.same("gemma4:e4b", "gemma4:12b")


def test_describe_marks_in_use_and_embed():
    d = chat_models.describe(TAGS, {"llm_model": "gemma4:e4b"}, ram_gb=16)
    first = d["models"][0]
    assert first["name"] == "gemma4:e4b" and first["in_use"] and not first["deletable"]
    embed = next(m for m in d["models"] if m["kind"] == "embed")
    assert embed["deletable"] and "notes" in embed["note"]
    assert d["total_bytes"] == sum(m["size"] for m in TAGS)
    sug = {s["name"]: s for s in d["suggested"]}
    assert "gemma4:e4b" not in sug and "qwen3.5:4b" not in sug
    assert sug["gemma4:12b"]["fits"] is False and sug["gemma4:26b"]["fits"] is False


def test_list_delete_select(tmp_path, monkeypatch):
    log = []
    c, cfg = client(tmp_path, monkeypatch, log)
    d = c.get("/v1/chat-models").json()
    assert [m["name"] for m in d["models"]][0] == "gemma4:e4b" and d["selected"] == "gemma4:e4b"
    # The model in use can't be deleted.
    r = c.delete("/v1/chat-models/gemma4:e4b")
    assert r.status_code == 409 and "Pick another" in r.json()["detail"]
    r = c.delete("/v1/chat-models/qwen3.5:4b")
    assert r.status_code == 200 and r.json()["deleted"] == "qwen3.5:4b" and r.json()["freed_bytes"] > 0
    assert ("DELETE", "/api/delete") in [(m, p) for m, p, _ in log]
    assert c.delete("/v1/chat-models/qwen3.5:4b").status_code == 404
    # 'nomic-embed-text' matches 'nomic-embed-text:latest'
    assert c.delete("/v1/chat-models/nomic-embed-text").status_code == 200
    assert c.post("/v1/chat-models/select", json={"name": "gemma4:12b"}).status_code == 409
    # Needs the pairing code from another device.
    assert TestClient(c.app).get("/v1/chat-models").status_code == 401


def test_pull_progress(tmp_path, monkeypatch):
    log = []
    c, cfg = client(tmp_path, monkeypatch, log)
    assert c.post("/v1/chat-models/pull", json={}).status_code == 400
    with c:  # keep one event loop so the background pull can run
        r = c.post("/v1/chat-models/pull", json={"name": "gemma4:12b"})
        assert r.status_code == 200 and r.json()["name"] == "gemma4:12b"
        for _ in range(50):
            p = c.get("/v1/chat-models").json()["pull"]
            if not p["running"]:
                break
        assert p["status"] == "success" and p["done"] == 100 and p["total"] == 100


def test_ollama_down(tmp_path, monkeypatch):
    c, cfg = client(tmp_path, monkeypatch, [])
    c.app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("no"))))
    r = c.get("/v1/chat-models")
    assert r.status_code == 503 and "Ollama" in r.json()["detail"]


def test_setup_json_events(monkeypatch, capsys):
    monkeypatch.setattr(state, "save", lambda c: None)
    monkeypatch.setattr(state, "load", lambda: dict(state.DEFAULTS))
    monkeypatch.setattr(setup, "detect_hardware", lambda: {"ram_gb": 16.0, "vram_gb": 0, "gpu": None})
    monkeypatch.setattr(setup, "download", lambda url, dest, label: setup._bar(5, 10, label))
    monkeypatch.setattr(setup, "start_ollama_if_needed", lambda url: False)
    try:
        cli.main(["setup", "--json", "--no-start"])
    finally:
        setup.JSON = False
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    kinds = [e["event"] for e in events]
    assert kinds[0] == "plan" and events[0]["model"] == "gemma4:e4b"
    assert {"event": "progress", "label": "kokoro-v1.0.int8.onnx", "done": 5, "total": 10} in events
    assert kinds[-1] == "error" and "Ollama" in events[-1]["message"]


def test_setup_reuses_models_already_downloaded(monkeypatch, capsys, tmp_path):
    """Models from an earlier install (or plain Ollama) are used, not downloaded again."""
    saved = {}
    monkeypatch.setattr(state, "save", lambda c: saved.update(c))
    monkeypatch.setattr(state, "load", lambda: dict(state.DEFAULTS))
    monkeypatch.setattr(state, "MODELS", tmp_path)
    for name in ("kokoro-v1.0.int8.onnx", "voices-v1.0.bin"):
        (tmp_path / name).write_bytes(b"x")
    monkeypatch.setattr(setup, "detect_hardware", lambda: {"ram_gb": 16.0, "vram_gb": 0, "gpu": None})
    monkeypatch.setattr(setup, "start_ollama_if_needed", lambda url: True)
    # A 16 GB machine would pick gemma4:e4b, but qwen3.5:4b is already here, plus a bigger one that doesn't fit.
    monkeypatch.setattr(setup, "installed_models", lambda url: ["qwen3.5:4b", "gemma4:26b", "nomic-embed-text:latest"])
    pulled = []
    monkeypatch.setattr(setup, "pull", lambda url, tag: pulled.append(tag))
    monkeypatch.setattr(setup, "download", lambda *a: pytest.fail("voice was downloaded again"))
    try:
        cli.main(["setup", "--json", "--no-start"])
    finally:
        setup.JSON = False
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    plan = events[0]
    assert plan["event"] == "plan" and plan["model"] == "qwen3.5:4b" and plan["have"] and plan["download"] is None
    steps = {e["id"]: e for e in events if e["event"] == "step"}
    assert steps["voice"]["have"] and steps["model"]["have"] and steps["embed"]["have"]
    assert pulled == [] and saved["llm_model"] == "qwen3.5:4b"
    assert events[-1]["event"] == "done"


def test_pick_model_order():
    hw = {"ram_gb": 32.0, "vram_gb": 0}
    assert setup.pick_model("x:1", {"llm_model": "y"}, hw, []) == ("x:1", "chosen")
    assert setup.pick_model(None, {"llm_model": "y"}, hw, ["gemma4:12b"])[0] == "y"
    assert setup.pick_model(None, {}, hw, ["gemma4:e4b", "gemma4:12b"])[0] == "gemma4:12b"
    assert setup.pick_model(None, {}, hw, ["llama3:8b"])[0] == "gemma4:12b"
