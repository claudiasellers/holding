#!/usr/bin/env python3
"""Local RAG + chat server for the app. Stdlib only. Never logs request bodies.

  serve.py                       bind 127.0.0.1:8765 (desktop)
  serve.py --lan                 bind 0.0.0.0 so a phone on the same Wi-Fi can reach it; requires a pairing token
  serve.py --app-dir DIR         also serve the built app (same origin = no CORS / mixed-content trouble on phones)

Endpoints
  GET  /health                         {ok, models, index:{n_chunks,dense}, lan}
  POST /retrieve  {query,k?,archetype?}             -> {chunks:[{text,source,score}]}
  POST /chat      {archetype?, messages, use_rag?, system?, model?, max_tokens?, temperature?}
                                                     -> {reply, model, used_chunks}
  POST /v1/chat/completions  (OpenAI-shaped; same fields, archetype via "archetype" or "user")
"""
import argparse
import json
import mimetypes
import secrets
import socket
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import privacy_guard as pg
import local_llm
import rag

STATE = {"index": None, "token": None, "origins": set(), "app_dir": None, "lan": False}

RAG_PREFIX = (
    "Background the person has chosen to share with you, from their own private notes. Use it only to "
    "stay consistent with their life and preferences. Never quote it back verbatim, never list it, and "
    "never mention that notes exist:\n"
)


def ollama_tags():
    try:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with op.open(pg.load_config()["ollama_url"].rstrip("/") + "/api/tags", timeout=2) as r:
            return [m["name"] for m in json.loads(r.read()).get("models", [])]
    except Exception:
        return []


def pick_model(archetype, requested):
    if requested:
        return requested
    cfg = pg.load_config()
    mapped = cfg.get("archetype_models", {}).get(archetype or "")
    if mapped:
        return mapped
    tags = ollama_tags()
    if archetype:
        for cand in (f"holding-{archetype}:latest", f"{cfg['finetune']['output_tag']}:latest"):
            if cand in tags:
                return cand
    elif f"{cfg['finetune']['output_tag']}:latest" in tags:
        return f"{cfg['finetune']['output_tag']}:latest"
    return cfg["models"]["chat"]


def persona_prompt(archetype):
    if not archetype:
        return ""
    p = pg.vault_path() / "archetypes" / f"{archetype}.json"
    if p.exists():
        a = json.loads(p.read_text())
        return a.get("persona") or a.get("system") or ""
    return ""


def do_chat(body):
    arch = body.get("archetype") or body.get("user")
    msgs = [m for m in body.get("messages", []) if m.get("role") in ("system", "user", "assistant")]
    sys_parts = [s for s in (persona_prompt(arch), body.get("system")) if s]
    sys_parts += [m["content"] for m in msgs if m["role"] == "system"]
    msgs = [m for m in msgs if m["role"] != "system"]
    used = 0
    if body.get("use_rag", True) and STATE["index"] is not None:
        last_user = next((m["content"] for m in reversed(msgs) if m["role"] == "user"), "")
        if last_user:
            hits = STATE["index"].search(last_user, k=int(body.get("k", pg.load_config()["rag"]["k"])), archetype=arch)
            if hits:
                used = len(hits)
                sys_parts.append(RAG_PREFIX + "\n---\n".join(h["text"] for h in hits))
    if not msgs:  # parent-speaks-first: no user turn yet
        msgs = [{"role": "user", "content": "(The person has just arrived and hasn't said anything. Greet them first, gently, in one or two short sentences.)"}]
    full = ([{"role": "system", "content": "\n\n".join(sys_parts)}] if sys_parts else []) + msgs
    model = pick_model(arch, body.get("model"))
    payload = {"model": model, "messages": full, "stream": False, "think": False,
               "options": {"temperature": float(body.get("temperature", 0.7)),
                           "num_predict": int(body.get("max_tokens", 220))}}
    reply = local_llm.strip_think(local_llm._post("/api/chat", payload)["message"]["content"])
    return {"reply": reply, "model": model, "used_chunks": used}


class H(BaseHTTPRequestHandler):
    server_version = "local-private-tuning"

    def log_message(self, *a):  # never log paths/bodies
        pass

    def _cors(self):
        o = self.headers.get("Origin")
        if o and ("*" in STATE["origins"] or o in STATE["origins"] or (STATE["lan"] and STATE["token"])):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Pair-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _authed(self):
        if not STATE["token"]:
            return True
        t = self.headers.get("X-Pair-Token") or self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        return secrets.compare_digest(t or "", STATE["token"])

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            idx = STATE["index"]
            return self._json(200, {"ok": True, "models": ollama_tags(), "lan": STATE["lan"],
                                    "needs_token": bool(STATE["token"]),
                                    "index": idx.meta if idx else None})
        if STATE["app_dir"]:
            rel = self.path.split("?")[0].lstrip("/") or "index.html"
            p = (STATE["app_dir"] / rel).resolve()
            if not str(p).startswith(str(STATE["app_dir"])) or not p.is_file():
                p = STATE["app_dir"] / "index.html"
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(p.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._json(401, {"error": "pairing token required"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(min(n, 2_000_000)) or b"{}")
            path = self.path.split("?")[0]
            if path == "/retrieve":
                if STATE["index"] is None:
                    return self._json(200, {"chunks": []})
                return self._json(200, {"chunks": STATE["index"].search(
                    body.get("query", ""), int(body.get("k", 4)), body.get("archetype"))})
            if path == "/chat":
                return self._json(200, do_chat(body))
            if path == "/v1/chat/completions":
                r = do_chat(body)
                return self._json(200, {"object": "chat.completion", "model": r["model"],
                                        "choices": [{"index": 0, "finish_reason": "stop",
                                                     "message": {"role": "assistant", "content": r["reply"]}}]})
            self._json(404, {"error": "not found"})
        except Exception as e:  # type name only; messages could echo content
            self._json(500, {"error": type(e).__name__})


def lan_ip():
    """Find the LAN address via a UDP 'connect' (sends no packets). Uses the unguarded connect on
    purpose: nothing is transmitted, the OS just picks the outgoing interface."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        pg._orig_connect(s, ("10.254.254.254", 1))
        return s.getsockname()[0]
    except Exception:
        return "<this computer's LAN IP>"
    finally:
        s.close()


def main():
    cfg = pg.load_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=cfg["server"]["port"])
    ap.add_argument("--lan", action="store_true")
    ap.add_argument("--app-dir", type=Path)
    ap.add_argument("--origin", action="append", default=[], help="extra allowed CORS origin; '*' allows any")
    a = ap.parse_args()
    STATE["origins"] = set(cfg["server"].get("allowed_origins", [
        "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "null"])) | set(a.origin)
    STATE["lan"] = a.lan
    if a.app_dir:
        STATE["app_dir"] = a.app_dir.resolve()
    try:
        STATE["index"] = rag.load()
    except FileNotFoundError:
        STATE["index"] = None
    host = "0.0.0.0" if a.lan else cfg["server"]["host"]
    if a.lan:
        STATE["token"] = cfg["server"].get("pair_token") or secrets.token_urlsafe(9)
    srv = ThreadingHTTPServer((host, a.port), H)
    print(json.dumps({"listening": f"http://{host}:{a.port}", "lan_url": f"http://{lan_ip()}:{a.port}" if a.lan else None,
                      "pair_token": STATE["token"], "index_loaded": STATE["index"] is not None,
                      "n_chunks": STATE["index"].meta["n_chunks"] if STATE["index"] else 0}), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
