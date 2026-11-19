"""First-run setup: detect hardware, pull the chat model, download the voice."""
import json
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx
import psutil

from . import catalog, state


def detect_hardware() -> dict:
    ram_gb = psutil.virtual_memory().total / 2**30
    vram_gb, gpu = 0.0, None
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
            if out:
                name, mem = out[0].rsplit(",", 1)
                gpu, vram_gb = name.strip(), float(mem) / 1024
        except Exception:
            pass
    apple = platform.system() == "Darwin" and platform.machine() == "arm64"
    if apple:
        gpu = "Apple Silicon (unified memory)"
    return {"ram_gb": round(ram_gb, 1), "vram_gb": round(vram_gb, 1), "gpu": gpu, "apple_silicon": apple,
            "os": platform.system(), "arch": platform.machine()}


# When the Mac app runs setup it passes --json: progress then comes as one JSON
# object per line ({"event": "step" | "plan" | "progress" | "done" | "error", ...})
# so the app can draw real progress bars. Other printed lines are just log text.
JSON = False


def emit(**ev):
    if JSON:
        print(json.dumps(ev), flush=True)


def _bar(done: int, total: int, label: str):
    if JSON:
        emit(event="progress", label=label, done=done, total=total)
        return
    if not total:
        sys.stdout.write(f"\r  {label}: {done / 2**20:,.0f} MB")
    else:
        pct = done / total
        n = int(pct * 30)
        sys.stdout.write(f"\r  {label}: [{'#' * n}{'.' * (30 - n)}] {pct:5.1%} of {total / 2**20:,.0f} MB")
    sys.stdout.flush()


def download(url: str, dest: Path, label: str):
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  {label}: already downloaded")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with httpx.stream("GET", url, headers=headers, follow_redirects=True, timeout=60) as r:
        if r.status_code == 416:  # already complete
            part.rename(dest)
            return
        r.raise_for_status()
        if r.status_code == 200:
            have = 0
        total = int(r.headers.get("content-length", 0)) + have
        with open(part, "ab" if have else "wb") as f:
            done = have
            last = 0.0
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if time.time() - last > 0.2:
                    _bar(done, total, label)
                    last = time.time()
        _bar(done, total, label)
    print()
    part.rename(dest)


def kokoro_from_hf(quality: str):
    import numpy as np
    model_name = catalog.KOKORO_FILES[quality][0]
    download(f"{catalog.HF_KOKORO}/{catalog.HF_KOKORO_MODEL[quality]}", state.MODELS / model_name, model_name)
    voices_path = state.MODELS / catalog.KOKORO_FILES["voices"][0]
    if voices_path.exists():
        return
    tmp = state.MODELS / "hf-voices"
    styles = {}
    for v in catalog.HF_VOICES:
        f = tmp / f"{v}.bin"
        download(f"{catalog.HF_KOKORO}/voices/{v}.bin", f, f"voice {v}")
        styles[v] = np.fromfile(f, dtype=np.float32).reshape(-1, 1, 256)
    with open(voices_path, "wb") as out:  # npz content; kokoro-onnx loads it with np.load
        np.savez(out, **styles)


def fetch_voice(quality: str):
    try:
        for key in (quality, "voices"):
            name, url = catalog.KOKORO_FILES[key]
            download(url, state.MODELS / name, name)
    except Exception as e:
        print(f"\n  GitHub download failed ({e}); trying the Hugging Face mirror.")
        kokoro_from_hf(quality)


def wait_for_ollama(url: str, seconds: int = 60) -> bool:
    for _ in range(seconds):
        try:
            httpx.get(f"{url}/api/version", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False


def start_ollama_if_needed(url: str) -> bool:
    if wait_for_ollama(url, 1):
        return True
    if platform.system() == "Darwin" and Path("/Applications/Ollama.app").exists():
        subprocess.Popen(["open", "-a", "Ollama"])
    elif shutil.which("ollama"):
        kw = {"creationflags": 0x08000000} if platform.system() == "Windows" else {"start_new_session": True}
        subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)
    else:
        return False
    return wait_for_ollama(url, 60)


def pull(url: str, tag: str):
    print(f"  Downloading chat model {tag} (one time)...")
    with httpx.stream("POST", f"{url}/api/pull", json={"model": tag, "stream": True}, timeout=None) as r:
        r.raise_for_status()
        last = 0.0
        for line in r.iter_lines():
            if not line:
                continue
            ev = json.loads(line)
            if ev.get("error"):
                raise RuntimeError(ev["error"])
            if ev.get("total") and time.time() - last > 0.2:
                _bar(ev.get("completed", 0), ev["total"], tag)
                last = time.time()
    print(f"\n  {tag}: ready")


def have_model(url: str, tag: str) -> bool:
    try:
        names = [m["name"] for m in httpx.get(f"{url}/api/tags", timeout=5).json().get("models", [])]
    except Exception:
        return False
    return tag in names or f"{tag}:latest" in names


def installed_models(url: str) -> list[str]:
    try:
        return [m["name"] for m in httpx.get(f"{url}/api/tags", timeout=5).json().get("models", [])]
    except Exception:
        return []


def _has(names: list[str], tag: str) -> bool:
    return tag in names or f"{tag}:latest" in names


def pick_model(model: str | None, cfg: dict, hw: dict, names: list[str]) -> tuple[str, str]:
    """The chat model setup uses, and why. Prefers what's already on this computer:
    an explicit choice, then the earlier setup's pick, then the biggest model tier that's
    already downloaded and fits, and only then the tier for this hardware (a download)."""
    tier = catalog.pick_tier(hw["ram_gb"], hw["vram_gb"])
    if model:
        return model, "chosen"
    if cfg.get("llm_model"):
        return cfg["llm_model"], "from your earlier setup"
    fitting = [t for t in catalog.LLM_TIERS if t["min_gb"] <= tier["min_gb"]]
    for t in reversed(fitting):
        if _has(names, t["tag"]):
            return t["tag"], "already on this computer"
    return tier["tag"], f"picked for this hardware: {tier['note']}"


def run(model: str | None = None, quality: str | None = None, embed: bool = True, warm: bool = True) -> dict:
    cfg = state.load()
    hw = detect_hardware()
    print(f"This computer: {hw['ram_gb']} GB memory" + (f", {hw['gpu']}" if hw["gpu"] else "")
          + (f" ({hw['vram_gb']} GB)" if hw["vram_gb"] else ""))
    tier = catalog.pick_tier(hw["ram_gb"], hw["vram_gb"])
    ollama_up = start_ollama_if_needed(cfg["ollama_url"])
    names = installed_models(cfg["ollama_url"]) if ollama_up else []
    cfg["llm_model"], why = pick_model(model, cfg, hw, names)
    have_chat = _has(names, cfg["llm_model"])
    if hw["ram_gb"] < 12:
        cfg["whisper_model"] = "base"
    if quality:
        cfg["tts_quality"] = quality
    state.save(cfg)
    print(f"Chat model: {cfg['llm_model']}  ({why})")
    emit(event="plan", model=cfg["llm_model"], reason=why, have=have_chat,
         download=None if have_chat else tier["download"] if cfg["llm_model"] == tier["tag"] else None,
         ram_gb=hw["ram_gb"], gpu=hw["gpu"])

    print("\n1/3 Voice (Kokoro)")
    voice_files = [state.MODELS / catalog.KOKORO_FILES[k][0] for k in (cfg["tts_quality"], "voices")]
    have_voice = all(f.exists() and f.stat().st_size > 0 for f in voice_files)
    emit(event="step", id="voice", title="Voice", have=have_voice)
    if have_voice:
        print("  already downloaded")
    else:
        fetch_voice(cfg["tts_quality"])

    print("\n2/3 Chat model (Ollama)")
    emit(event="step", id="model", title="Chat model", model=cfg["llm_model"], have=have_chat)
    if not ollama_up:
        print("  Ollama is not installed or not running. Install it from https://ollama.com/download "
              "and run setup again.")
        emit(event="error", message="Ollama isn't running, so the chat model can't be downloaded.")
        return cfg
    if not have_chat:
        pull(cfg["ollama_url"], cfg["llm_model"])
    else:
        print(f"  {cfg['llm_model']}: already downloaded")
    if embed:
        have_embed = _has(names, catalog.EMBED_TAG)
        emit(event="step", id="embed", title="Memory model", model=catalog.EMBED_TAG, have=have_embed)
        if not have_embed:
            pull(cfg["ollama_url"], catalog.EMBED_TAG)

    print("\n3/3 Listening (Whisper)")
    emit(event="step", id="listening", title="Listening")
    from . import stt
    if stt.installed():
        print(f"  faster-whisper installed; the '{cfg['whisper_model']}' model downloads the first time you speak.")
    else:
        print("  Not installed (optional). The app works without it; you never have to speak.")

    if warm:
        emit(event="step", id="warm", title="Waking the parent up")
        try:
            httpx.post(f"{cfg['ollama_url']}/api/generate", json={"model": cfg["llm_model"], "prompt": "",
                                                                   "keep_alive": "30m"}, timeout=120)
        except Exception:
            pass
    print("\nSetup complete.")
    emit(event="done", model=cfg["llm_model"])
    return cfg
