"""OpenAI /v1/chat/completions on top of Ollama's native /api/chat.

We use the native endpoint (not Ollama's own /v1) because it is the one that
reliably honours "think": false, which reasoning-capable models such as
Qwen3.5 need so the parent answers immediately instead of deliberating."""
import json
import re
import time
import uuid

import httpx

from . import catalog

THINK_RE = re.compile(r"<think>.*?(</think>|$)", re.S)


class ThinkStripper:
    """Removes <think>...</think> spans from a stream of text chunks."""

    def __init__(self):
        self.buf = ""
        self.inside = False

    def feed(self, s: str) -> str:
        self.buf += s
        out = []
        while self.buf:
            if self.inside:
                end = self.buf.find("</think>")
                if end < 0:
                    self.buf = self.buf[-8:]
                    return "".join(out)
                self.buf = self.buf[end + 8:]
                self.inside = False
            else:
                start = self.buf.find("<think>")
                if start < 0:
                    # keep a possible partial "<think" tail
                    keep = 0
                    for n in range(min(6, len(self.buf)), 0, -1):
                        if "<think>".startswith(self.buf[-n:]):
                            keep = n
                            break
                    out.append(self.buf[: len(self.buf) - keep])
                    self.buf = self.buf[len(self.buf) - keep:]
                    return "".join(out)
                out.append(self.buf[:start])
                self.buf = self.buf[start + 7:]
                self.inside = True
        return "".join(out)

    def flush(self) -> str:
        rest = "" if self.inside else self.buf
        self.buf = ""
        return rest


def _content(c):
    if isinstance(c, str):
        return c, []
    text, images = [], []
    for part in c or []:
        if part.get("type") == "text":
            text.append(part.get("text", ""))
        elif part.get("type") == "image_url":
            url = (part.get("image_url") or {}).get("url", "")
            if url.startswith("data:") and "," in url:
                images.append(url.split(",", 1)[1])
    return "\n".join(text), images


def to_ollama(body: dict, default_model: str) -> dict:
    model = body.get("model") or default_model
    if model in ("default", "auto", "local", ""):
        model = default_model
    msgs = []
    for m in body.get("messages", []):
        text, images = _content(m.get("content"))
        om = {"role": m.get("role", "user"), "content": text}
        if images:
            om["images"] = images
        msgs.append(om)
    opts = {}
    for src, dst in (("temperature", "temperature"), ("top_p", "top_p"), ("seed", "seed"),
                     ("presence_penalty", "presence_penalty"), ("frequency_penalty", "frequency_penalty")):
        if body.get(src) is not None:
            opts[dst] = body[src]
    mt = body.get("max_completion_tokens") or body.get("max_tokens")
    if mt:
        opts["num_predict"] = int(mt)
    if body.get("stop"):
        opts["stop"] = body["stop"] if isinstance(body["stop"], list) else [body["stop"]]
    opts.setdefault("num_ctx", 8192)
    out = {"model": model, "messages": msgs, "stream": bool(body.get("stream")), "options": opts,
           "keep_alive": "30m"}
    think = body.get("think")
    if think is None:
        think = body.get("reasoning_effort") not in (None, "none") if "reasoning_effort" in body else False
    # Only send "think" to models that understand it; others reject the field.
    if catalog.needs_think_off(model) or think:
        out["think"] = bool(think)
    return out


def _chunk(cid, model, delta, finish=None):
    return {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


async def stream(client: httpx.AsyncClient, ollama_url: str, payload: dict):
    cid = "chatcmpl-" + uuid.uuid4().hex[:24]
    model = payload["model"]
    strip = ThinkStripper()
    yield "data: " + json.dumps(_chunk(cid, model, {"role": "assistant", "content": ""})) + "\n\n"
    async with client.stream("POST", f"{ollama_url}/api/chat", json=payload, timeout=None) as r:
        if r.status_code != 200:
            err = (await r.aread()).decode(errors="replace")
            yield "data: " + json.dumps({"error": {"message": err, "code": r.status_code}}) + "\n\n"
            yield "data: [DONE]\n\n"
            return
        async for line in r.aiter_lines():
            if not line.strip():
                continue
            ev = json.loads(line)
            if ev.get("error"):
                yield "data: " + json.dumps({"error": {"message": ev["error"]}}) + "\n\n"
                break
            text = strip.feed((ev.get("message") or {}).get("content", ""))
            if text:
                yield "data: " + json.dumps(_chunk(cid, model, {"content": text})) + "\n\n"
            if ev.get("done"):
                tail = strip.flush()
                if tail:
                    yield "data: " + json.dumps(_chunk(cid, model, {"content": tail})) + "\n\n"
                reason = "length" if ev.get("done_reason") == "length" else "stop"
                yield "data: " + json.dumps(_chunk(cid, model, {}, reason)) + "\n\n"
                break
    yield "data: [DONE]\n\n"


async def complete(client: httpx.AsyncClient, ollama_url: str, payload: dict) -> dict:
    r = await client.post(f"{ollama_url}/api/chat", json=payload, timeout=None)
    r.raise_for_status()
    ev = r.json()
    text = THINK_RE.sub("", (ev.get("message") or {}).get("content", "")).strip()
    pt, ct = ev.get("prompt_eval_count", 0), ev.get("eval_count", 0)
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:24], "object": "chat.completion", "created": int(time.time()),
        "model": payload["model"],
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                     "finish_reason": "length" if ev.get("done_reason") == "length" else "stop"}],
        "usage": {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct},
    }
