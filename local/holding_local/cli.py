"""holding-local: setup | start [--lan|--tailscale] | status | model TAG | pair"""
import argparse
import json
import sys
import threading
import time
import webbrowser

from . import catalog, net, state


def cmd_setup(a):
    from . import setup
    setup.run(model=a.model, quality=a.voice_quality, embed=not a.no_embed)
    if not a.no_start:
        a.lan = a.tailscale = False
        a.port = a.app_dir = None
        a.no_browser = False
        cmd_start(a)


def cmd_start(a):
    import uvicorn
    from .server import create_app
    from .setup import start_ollama_if_needed

    cfg = state.load()
    if a.port:
        cfg["port"] = a.port
    if a.app_dir:
        cfg["app_dir"] = a.app_dir
    port = cfg["port"]
    if not start_ollama_if_needed(cfg["ollama_url"]):
        print("Warning: Ollama is not running, so the parent can't talk yet (scripted mode still works).")

    remote = a.lan or a.tailscale
    urls = []
    if remote:
        state.ensure_token(cfg, rotate=getattr(a, "new_token", False))
        if a.tailscale:
            https, msg = net.tailscale_https(port)
            print(msg)
            if https:
                urls.append(https)
        if a.lan:
            ip = net.lan_ip()
            if ip:
                urls.append(f"http://{ip}:{port}")
    app = create_app(cfg)
    app.state.public_urls = urls
    host = "0.0.0.0" if a.lan else "127.0.0.1"  # tailscale serve proxies to loopback

    local = f"http://127.0.0.1:{port}"
    print(f"\nHolding Local is running at {local}")
    print(f"  Chat model: {cfg.get('llm_model')}   Voice: Kokoro   API: {local}/v1")
    if app.state.app_dir is None:
        print("  (App files not found; serving the API only. Use --app-dir PATH.)")
    if urls:
        best = next((u for u in urls if u.startswith("https://")), urls[0])
        link = net.pair_url(best, cfg["token"])
        print("\nScan this with your phone:\n")
        print(net.qr_ascii(link))
        print(f"  {link}")
        print(f"\n  Pairing code (type this in the installed app): {cfg['token']}")
        if not best.startswith("https://"):
            print("  Note: phones disable camera, microphone and install on plain http. Use --tailscale for those.")
        print(f"  Or open {local}/pair on this computer for a bigger QR code.")
    print("\nLeave this window open. Press Ctrl+C to stop.\n")

    if not a.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(local)).start()
    uvicorn.run(app, host=host, port=port, log_level="warning")


def cmd_status(a):
    import httpx
    cfg = state.load()
    try:
        print(json.dumps(httpx.get(f"http://127.0.0.1:{cfg['port']}/health", timeout=5).json(), indent=2))
    except Exception:
        from .setup import detect_hardware
        print("Holding Local is not running.")
        hw = detect_hardware()
        print(json.dumps({"hardware": hw, "suggested_model": catalog.pick_tier(hw["ram_gb"], hw["vram_gb"])["tag"],
                          "configured_model": cfg.get("llm_model")}, indent=2))


def cmd_model(a):
    from . import setup
    cfg = state.load()
    cfg["llm_model"] = a.tag
    state.save(cfg)
    if setup.start_ollama_if_needed(cfg["ollama_url"]) and not setup.have_model(cfg["ollama_url"], a.tag):
        setup.pull(cfg["ollama_url"], a.tag)
    print(f"Chat model set to {a.tag}. Restart Holding Local to use it.")


def cmd_catalog(a):
    print(json.dumps({"llm_tiers": catalog.LLM_TIERS, "webllm": catalog.WEBLLM,
                      "archetype_voices": catalog.ARCHETYPE_VOICES}, indent=2))


def main(argv=None):
    p = argparse.ArgumentParser(prog="holding-local", description="Free, private, local AI for the Holding app.")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("setup", help="download models for this computer, then start")
    s.add_argument("--model", help="Ollama tag to use instead of the automatic pick")
    s.add_argument("--voice-quality", choices=["int8", "fp32"])
    s.add_argument("--no-embed", action="store_true", help="skip the embedding model used by RAG")
    s.add_argument("--no-start", action="store_true")
    s.set_defaults(fn=cmd_setup)

    st = sub.add_parser("start", help="run the app and local API")
    st.add_argument("--lan", action="store_true", help="let phones on the same Wi-Fi connect (http)")
    st.add_argument("--tailscale", action="store_true", help="HTTPS for your phone through Tailscale (recommended)")
    st.add_argument("--new-token", action="store_true", help="make a new pairing code (unpairs old phones)")
    st.add_argument("--port", type=int)
    st.add_argument("--app-dir")
    st.add_argument("--no-browser", action="store_true")
    st.set_defaults(fn=cmd_start)

    sub.add_parser("status", help="show what is running and downloaded").set_defaults(fn=cmd_status)
    m = sub.add_parser("model", help="switch the chat model, e.g. gemma4:12b")
    m.add_argument("tag")
    m.set_defaults(fn=cmd_model)
    sub.add_parser("catalog", help="print the recommended models and voices").set_defaults(fn=cmd_catalog)

    a = p.parse_args(argv)
    if not a.cmd:
        a = p.parse_args(["start"])
    try:
        a.fn(a)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
