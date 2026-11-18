"""Run with: uv run --with pytest pytest -q   (no models or Ollama needed)."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from holding_local import catalog, llm, state
from holding_local.server import create_app


def test_tiers():
    assert catalog.pick_tier(8)["tag"] == "qwen3.5:4b"
    assert catalog.pick_tier(16)["tag"] == "gemma4:e4b"
    assert catalog.pick_tier(16, 12)["tag"] == "gemma4:12b"
    assert catalog.pick_tier(32)["tag"] == "gemma4:12b"
    assert catalog.pick_tier(64)["tag"] == "gemma4:26b"
    assert catalog.pick_tier(8, 24)["tag"] == "gemma4:26b"


@pytest.mark.parametrize("chunks", [
    ["<think>a</think>Hi"], ["<thi", "nk>x</th", "ink>Hi"], ["Hi"], ["H", "i"], ["<think>never closed"],
])
def test_think_stripper(chunks):
    s = llm.ThinkStripper()
    out = "".join(s.feed(c) for c in chunks) + s.flush()
    assert out == ("" if chunks == ["<think>never closed"] else "Hi")


def test_to_ollama_think_flag():
    p = llm.to_ollama({"model": "qwen3.5:4b", "messages": [{"role": "user", "content": "hi"}]}, "gemma4:e4b")
    assert p["think"] is False
    p = llm.to_ollama({"model": "default", "messages": [], "max_tokens": 40}, "gemma4:e4b")
    assert p["model"] == "gemma4:e4b" and "think" not in p and p["options"]["num_predict"] == 40


def test_short_code():
    cfg = {}
    state.save = lambda c: None
    code = state.ensure_token(cfg)
    assert len(code) == 9 and code[4] == "-"
    assert state.normalize_code(code.lower().replace("-", " ")) == state.normalize_code(code)


def make_client(tmp_path, handler):
    (tmp_path / "index.html").write_text("<!doctype html>app")
    cfg = dict(state.DEFAULTS, llm_model="gemma4:e4b", token="ABCD-2345", app_dir=str(tmp_path),
               ollama_url="http://ollama")
    app = create_app(cfg)
    app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return TestClient(app)


def fake_ollama(request: httpx.Request):
    if request.url.path == "/api/tags":
        return httpx.Response(200, json={"models": [{"name": "gemma4:e4b"}]})
    if request.url.path == "/api/chat":
        body = json.loads(request.content)
        if body["stream"]:
            lines = [{"message": {"content": "<think>x</think>There"}, "done": False},
                     {"message": {"content": " you are."}, "done": False},
                     {"message": {"content": ""}, "done": True, "done_reason": "stop"}]
            return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode())
        return httpx.Response(200, json={"message": {"content": "There you are."}, "done": True})
    return httpx.Response(404)


def test_chat_stream_and_auth(tmp_path):
    c = make_client(tmp_path, fake_ollama)
    r = c.post("/v1/chat/completions", json={"stream": True, "messages": [{"role": "user", "content": "hi"}]},
               headers={"authorization": "Bearer ABCD-2345"})
    text = "".join(json.loads(l[6:])["choices"][0]["delta"].get("content", "")
                   for l in r.text.splitlines() if l.startswith("data: {"))
    assert text == "There you are."
    assert r.text.strip().endswith("[DONE]")
    assert c.post("/v1/chat/completions", json={"messages": []}).status_code == 401
    # TestClient's client host is "testclient", i.e. remote: token required
    assert c.get("/v1/models").status_code == 401
    assert c.get("/v1/models", headers={"authorization": "Bearer abcd2345"}).status_code == 200
    assert c.get("/health").status_code == 200
    assert c.get("/").text == "<!doctype html>app"
    assert c.get("/deep/link").text == "<!doctype html>app"
    pre = c.options("/v1/audio/speech", headers={"origin": "https://example.github.io",
                                                  "access-control-request-method": "POST"})
    assert pre.status_code == 204 and pre.headers["access-control-allow-private-network"] == "true"


def test_hidden_paths(tmp_path):
    (tmp_path / ".env").write_text("SECRET")
    (tmp_path / "local").mkdir()
    (tmp_path / "local" / "x.py").write_text("src")
    c = make_client(tmp_path, fake_ollama)
    assert c.get("/.env").status_code == 404
    assert c.get("/local/x.py").status_code == 404
    assert c.get("/.git/config").status_code == 404
