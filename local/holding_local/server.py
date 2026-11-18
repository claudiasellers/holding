"""Holding Local: one origin that serves the app and an OpenAI-compatible local API."""
import hmac
import ipaddress
import time
from collections import deque
from pathlib import Path

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import __version__, catalog, llm, net, state, stt, tts

API_PREFIXES = ("/v1/", "/health")
HIDDEN_DIRS = {"node_modules", "local", "android", "ios", "tools", "scripts", "__pycache__"}
PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "forwarded", "tailscale-user-login",
                 "x-real-ip", "cf-connecting-ip")


def find_app_dir(cfg: dict) -> Path | None:
    here = Path(__file__).resolve().parent
    candidates = [cfg.get("app_dir")] if cfg.get("app_dir") else []
    root = here.parent  # holding/local/
    # app/ = a packaged download; ../dist = the built app; .. = the app root in development
    candidates += [root / "app", root.parent / "dist", root.parent]
    for c in candidates:
        if c and (Path(c) / "index.html").exists():
            return Path(c).resolve()
    return None


def is_local_request(request: Request) -> bool:
    """True only for a browser on this same machine talking to us directly.
    Anything relayed (tailscale serve, a reverse proxy) counts as remote even
    though it arrives from 127.0.0.1."""
    if any(h in request.headers for h in PROXY_HEADERS):
        return False
    hostname = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
    if hostname not in ("127.0.0.1", "localhost", "::1"):
        return False  # e.g. Host: mymac.tailnet.ts.net through tailscale serve
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def create_app(cfg: dict | None = None) -> FastAPI:
    cfg = cfg or state.load()
    @asynccontextmanager
    async def lifespan(app):
        yield
        await app.state.http.aclose()

    app = FastAPI(title="Holding Local", version=__version__, docs_url="/v1/docs", openapi_url="/v1/openapi.json",
                  lifespan=lifespan)
    app.state.cfg = cfg
    app.state.public_urls = []  # set by the CLI when phone access is on
    app.state.http = httpx.AsyncClient()
    origins = cfg.get("cors_origins") or ["*"]
    failures: deque = deque()  # timestamps of wrong pairing codes, for rate limiting

    def token_ok(given: str) -> bool:
        token = cfg.get("token")
        if not token:
            return False
        return hmac.compare_digest(state.normalize_code(given).encode(), state.normalize_code(token).encode())

    def cors_headers(request: Request) -> dict:
        origin = request.headers.get("origin")
        if not origin:
            return {}
        if "*" not in origins and origin not in origins:
            return {}
        return {
            "Access-Control-Allow-Origin": origin,
            "Vary": "Origin",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers")
            or "Authorization, Content-Type",
            "Access-Control-Allow-Private-Network": "true",  # Chrome Private Network Access preflight
            "Access-Control-Max-Age": "600",
        }

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        is_api = path.startswith(API_PREFIXES)
        if request.method == "OPTIONS" and is_api:
            return Response(status_code=204, headers=cors_headers(request))
        if is_api and path not in ("/health",) and not is_local_request(request):
            auth = request.headers.get("authorization", "")
            given = (auth[7:] if auth.lower().startswith("bearer ") else
                     request.headers.get("x-pair-token") or request.query_params.get("token", ""))
            now = time.monotonic()
            while failures and now - failures[0] > 60:
                failures.popleft()
            if len(failures) >= 20:
                resp = JSONResponse({"error": {"message": "Too many wrong pairing codes. Wait a minute.",
                                               "code": 429}}, status_code=429)
                resp.headers.update(cors_headers(request))
                return resp
            if not token_ok(given):
                if given:
                    failures.append(now)
                resp = JSONResponse({"error": {"message": "Pairing token required. Scan the QR code shown by "
                                               "'holding-local start --lan' or add ?token=.", "code": 401}},
                                    status_code=401)
                resp.headers.update(cors_headers(request))
                return resp
        resp = await call_next(request)
        if is_api:
            resp.headers.update(cors_headers(request))
        return resp

    async def ollama_ok() -> tuple[bool, list[str]]:
        try:
            r = await app.state.http.get(f"{cfg['ollama_url']}/api/tags", timeout=2)
            return True, [m["name"] for m in r.json().get("models", [])]
        except Exception:
            return False, []

    def llm_model() -> str:
        return cfg.get("llm_model") or catalog.LLM_TIERS[1]["tag"]

    @app.get("/health")
    async def health():
        up, models = await ollama_ok()
        want = llm_model()
        have = any(m == want or m == want + ":latest" for m in models)
        return {
            "ok": up and have and tts.available(cfg["tts_quality"]),
            "version": __version__,
            "llm": {"runtime": "ollama", "reachable": up, "model": want, "downloaded": have},
            "tts": {"engine": "kokoro-82m-v1.0", "ready": tts.available(cfg["tts_quality"])},
            "stt": {"engine": "faster-whisper", "installed": stt.installed(), "model": cfg["whisper_model"]},
            "endpoints": ["/v1/chat/completions", "/v1/audio/speech", "/v1/audio/transcriptions",
                          "/v1/models", "/v1/voices", "/v1/catalog"],
        }

    @app.get("/v1/models")
    async def models():
        _, names = await ollama_ok()
        data = [{"id": n, "object": "model", "owned_by": "ollama"} for n in names]
        data.append({"id": "kokoro", "object": "model", "owned_by": "local-tts"})
        if stt.installed():
            data.append({"id": "whisper-1", "object": "model", "owned_by": "local-stt"})
        return {"object": "list", "data": data, "default": llm_model()}

    @app.get("/v1/catalog")
    async def get_catalog():
        return {"llm_tiers": catalog.LLM_TIERS, "alternates": catalog.ALTERNATES, "embed": catalog.EMBED_TAG,
                "webllm": catalog.WEBLLM, "archetype_voices": catalog.ARCHETYPE_VOICES,
                "default_voice": catalog.DEFAULT_VOICE, "current_model": llm_model()}

    @app.get("/v1/voices")
    async def get_voices():
        return {"voices": await run_in_threadpool(tts.voices, cfg["tts_quality"]),
                "archetypes": catalog.ARCHETYPE_VOICES, "aliases": catalog.OPENAI_VOICE_ALIASES}

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        body = await request.json()
        payload = llm.to_ollama(body, llm_model())
        try:
            if payload["stream"]:
                return StreamingResponse(llm.stream(app.state.http, cfg["ollama_url"], payload),
                                         media_type="text/event-stream",
                                         headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
            return await llm.complete(app.state.http, cfg["ollama_url"], payload)
        except httpx.ConnectError:
            raise HTTPException(503, "Ollama is not running. Open the Ollama app or run 'ollama serve'.")
        except httpx.HTTPStatusError as e:
            raise HTTPException(e.response.status_code, e.response.text)

    @app.post("/v1/embeddings")
    async def embeddings(request: Request):
        body = await request.json()
        inp = body.get("input")
        payload = {"model": body.get("model") or catalog.EMBED_TAG, "input": inp}
        try:
            r = await app.state.http.post(f"{cfg['ollama_url']}/api/embed", json=payload, timeout=None)
        except httpx.ConnectError:
            raise HTTPException(503, "Ollama is not running.")
        if r.status_code != 200:
            raise HTTPException(r.status_code, r.text)
        embs = r.json().get("embeddings", [])
        return {"object": "list", "model": payload["model"],
                "data": [{"object": "embedding", "index": i, "embedding": e} for i, e in enumerate(embs)]}

    @app.post("/v1/audio/speech")
    async def speech(request: Request):
        body = await request.json()
        text = (body.get("input") or "").strip()
        if not text:
            raise HTTPException(400, "'input' is empty")
        if len(text) > 4096:
            raise HTTPException(400, "'input' is longer than 4096 characters")
        try:
            samples, sr = await run_in_threadpool(tts.synthesize, text, body.get("voice"), body.get("speed"),
                                                  cfg["tts_quality"])
        except FileNotFoundError as e:
            raise HTTPException(503, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        data, media = await run_in_threadpool(tts.encode, samples, sr, body.get("response_format", "wav"))
        return Response(data, media_type=media, headers={"X-Sample-Rate": str(sr)})

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(file: UploadFile = File(...), model: str = Form("whisper-1"),
                             language: str | None = Form(None), prompt: str | None = Form(None),
                             response_format: str = Form("json")):
        if not stt.installed():
            raise HTTPException(501, "Listening is not installed. Re-run setup with listening enabled.")
        data = await file.read()
        size = cfg["whisper_model"] if model in ("whisper-1", "default", "") else model
        result = await run_in_threadpool(stt.transcribe, data, size, language, prompt)
        if response_format == "text":
            return Response(result["text"], media_type="text/plain")
        return result if response_format == "verbose_json" else {"text": result["text"]}

    @app.get("/v1/pair")
    async def pair_info(request: Request):
        """Pairing details for the QR page. Only answers a browser on this computer."""
        if not is_local_request(request):
            raise HTTPException(403, "Open this on the computer running Holding Local.")
        urls = app.state.public_urls or []
        token = cfg.get("token")
        if not token or not urls:
            return {"enabled": False, "message": "Phone access is off. Start with: holding-local start --lan"}
        best = next((u for u in urls if u.startswith("https://")), urls[0])
        link = net.pair_url(best, token)
        return {"enabled": True, "url": link, "code": token, "urls": [net.pair_url(u, token) for u in urls],
                "secure": best.startswith("https://"), "qr_svg": net.qr_svg(link).decode()}

    @app.get("/pair", include_in_schema=False)
    async def pair_page():
        return Response(PAIR_PAGE, media_type="text/html")

    app_dir = find_app_dir(cfg)
    app.state.app_dir = app_dir

    @app.get("/{path:path}", include_in_schema=False)
    async def static(path: str):
        if path.startswith("v1/"):
            raise HTTPException(404)
        if app_dir is None:
            return Response(PLACEHOLDER, media_type="text/html")
        parts = Path(path).parts
        if any(p.startswith(".") for p in parts) or (parts and parts[0] in HIDDEN_DIRS):
            raise HTTPException(404)  # never serve .git, .env, node_modules or this companion's source
        target = (app_dir / path).resolve()
        if app_dir not in target.parents and target != app_dir:
            raise HTTPException(404)
        if target.is_dir():
            target = target / "index.html"
        if not target.exists():
            if "." in Path(path).name:
                raise HTTPException(404)
            target = app_dir / "index.html"  # single-page-app fallback
        headers = {"Cache-Control": "no-cache"} if target.name in ("index.html", "sw.js", "service-worker.js") else {}
        media = {".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
                 ".mjs": "text/javascript"}.get(target.suffix)
        return FileResponse(target, media_type=media, headers=headers)

    return app


PLACEHOLDER = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Holding Local</title><style>body{font:16px/1.5 system-ui;margin:2rem auto;max-width:36rem;padding:0 1rem;
background:#faf7f2;color:#2b2622}code{background:#eee6da;padding:.1em .3em;border-radius:4px}</style>
<h1>Holding Local is running</h1><p>The local AI is ready at <code>/v1</code>, but the app files were not found.
Put the built app in the <code>app</code> folder next to this companion, or start with
<code>holding-local start --app-dir PATH</code>.</p><p><a href="/health">Status</a> · <a href="/v1/docs">API</a></p>"""

PAIR_PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Pair a phone</title><style>:root{--bg:#faf7f2;--fg:#2b2622;--muted:#6b6259;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1d1a17;--fg:#f1ebe3;--muted:#b5aa9e;--card:#2a2622}}
body{font:16px/1.5 system-ui;margin:0;background:var(--bg);color:var(--fg)}main{max-width:30rem;margin:2rem auto;padding:0 16px}
#qr{background:#fff;border-radius:16px;padding:12px;width:min(320px,100%)}#qr svg{width:100%;height:auto;display:block}
.muted{color:var(--muted)}code{word-break:break-all}.warn{background:var(--card);border-left:4px solid #d08a3a;padding:.6rem .8rem;border-radius:6px}</style>
<main><h1>Pair your phone</h1><div id=body class=muted>Loading...</div></main>
<script>
fetch('/v1/pair').then(r=>r.json()).then(d=>{const b=document.getElementById('body');
if(!d.enabled){b.textContent=d.message||d.detail;return}
b.className='';b.innerHTML='<p>Scan with your phone camera. Your phone must be '+(d.secure?'signed in to the same Tailscale account':'on the same Wi-Fi')+'.</p><div id=qr>'+d.qr_svg+'</div><p>Pairing code for the installed app: <b style=\"font-size:1.6em;letter-spacing:.08em\">'+d.code+'</b></p><p class=muted>Or open: <code>'+d.url+'</code></p>'+
(d.secure?'':'<p class=warn>This is a plain http link. Phones block the camera, microphone and Add to Home Screen on http, so mirroring and talking will not work. Text and voice playback still do. For everything, run <code>holding-local start --tailscale</code>.</p>')
}).catch(()=>{document.getElementById('body').textContent='Open this page on the computer running Holding Local.'})
</script>"""
