"""Voices that run on a Mac's GPU through mlx-audio (Apple silicon only).

Each one is an optional download from Settings → Voice. The first time one is
downloaded, Holding Local installs mlx-audio into its own environment (about
300 MB of Python packages, once). Model files live in the Hugging Face cache
(~/.cache/huggingface/hub), one folder per repository, so deleting a voice
removes exactly its folders and any helper folder no other downloaded voice needs.
Deleting the last Mac voice also uninstalls the packages that installing mlx-audio added.

How each model gets a parent's voice and feeling:
- clone:    copies the parent's voice from a Kokoro rendering of REF_TEXT
            (Chatterbox, Chatterbox Turbo, Sesame CSM, Dia).
- preset:   the model's own voices, picked by the parent's gender
            (Qwen3-TTS CustomVoice, Orpheus).
- feeling:  Chatterbox takes the dial as `exaggeration`; Qwen3-TTS takes a
            spoken-style instruction written from the dial.
"""
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

from . import state

MLX_AUDIO = "mlx-audio==0.6.6"

# The Hugging Face downloader can keep a second copy of what it fetches in a chunk
# cache (~/.cache/huggingface/xet) that Delete would not see. Keep it off.
os.environ.setdefault("HF_XET_CHUNK_CACHE_SIZE_BYTES", "0")
WARMUP_TEXT = "I'm here."

CATALOG = {
    "qwen3-tts": {
        "name": "Qwen3-TTS",
        "blurb": "The most directable: it takes the feeling as a spoken instruction (\"softly, reassuring\"). "
                 "Its own warm voices, not the parent's. 1.7B, 8-bit.",
        "size_note": "about 3.1 GB",
        "approx": 3_100_000_000,
        "repo": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
        "helpers": [],
        "style": "instruct", "feeling": True,
    },
    "qwen3-tts-small": {
        "name": "Qwen3-TTS small",
        "blurb": "The same instruction-driven feeling in a smaller, faster model. 0.6B, 8-bit.",
        "size_note": "about 2 GB",
        "approx": 1_970_000_000,
        "repo": "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "helpers": [],
        "style": "instruct", "feeling": True,
    },
    "chatterbox-mac": {
        "name": "Chatterbox on the Mac's GPU",
        "blurb": "Chatterbox with its feeling dial and each parent's own voice, run on the GPU, "
                 "so it speaks several times sooner than the version that runs on any computer.",
        "size_note": "about 1.4 GB",
        "approx": 1_400_000_000,
        "repo": "mlx-community/chatterbox-8bit",
        "helpers": ["mlx-community/S3TokenizerV2", "ResembleAI/chatterbox"],
        "style": "clone", "feeling": True,
    },
    "chatterbox-turbo-mac": {
        "name": "Chatterbox Turbo on the Mac's GPU",
        "blurb": "Turbo on the GPU: the quickest voice with each parent's own voice. Understands [sigh] and [chuckle]. No feeling dial.",
        "size_note": "about 1.2 GB",
        "approx": 1_200_000_000,
        "repo": "mlx-community/chatterbox-turbo-8bit",
        "helpers": ["mlx-community/S3TokenizerV2"],
        "style": "clone", "feeling": False,
    },
    "orpheus": {
        "name": "Orpheus",
        "blurb": "Very natural and emotive, with sighs and laughs when the text has <sigh> or <laugh>. "
                 "Its own voices (Tara, Leo), not the parent's. 3B, 4-bit, so it needs a Mac with 16 GB or more.",
        "size_note": "about 2 GB",
        "approx": 2_000_000_000,
        "repo": "mlx-community/orpheus-3b-0.1-ft-4bit",
        "helpers": ["mlx-community/snac_24khz", "mlx-community/orpheus-3b-0.1-ft-bf16"],
        "style": "preset", "feeling": False,
    },
    "csm": {
        "name": "Sesame CSM",
        "blurb": "Conversational: built to sound like someone talking with you, not reading. "
                 "Copies each parent's voice. 1B, 8-bit.",
        "size_note": "about 2.2 GB",
        "approx": 2_200_000_000,
        "repo": "mlx-community/csm-1b-8bit",
        "helpers": ["kyutai/moshiko-pytorch-bf16", "unsloth/Llama-3.2-1B"],
        "style": "clone_text", "feeling": False,
    },
    "dia": {
        "name": "Dia",
        "blurb": "Dialogue model with natural (laughs) and (sighs). Copies each parent's voice. "
                 "Large: 1.6B at full precision, so it needs a Mac with 16 GB or more and is the slowest here.",
        "size_note": "about 6.5 GB",
        "approx": 6_500_000_000,
        "repo": "mlx-community/Dia-1.6B",
        "helpers": ["mlx-community/descript-audio-codec-44khz"],
        "style": "clone_dia", "feeling": False,
    },
}

QWEN_SPEAKERS = {"female": "serena", "male": "ryan"}
ORPHEUS_SPEAKERS = {"female": "tara", "male": "leo"}


def supported() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


def unsupported_reason() -> str:
    if supported():
        return ""
    return "Needs a Mac with Apple silicon (M1 or newer)."


def engine_installed() -> bool:
    try:
        import importlib.util
        return importlib.util.find_spec("mlx_audio") is not None
    except (ImportError, ValueError):
        return False


def _uv() -> str | None:
    for c in (shutil.which("uv"), str(Path.home() / ".local" / "bin" / "uv"), str(Path.home() / ".cargo" / "bin" / "uv")):
        if c and Path(c).exists():
            return c
    return None


def _installed_dists() -> set[str]:
    from importlib import metadata
    return {(d.metadata["Name"] or "").lower() for d in metadata.distributions() if d.metadata["Name"]}


def _engine_record() -> Path:
    return state.MODELS / "mac-voices" / "engine.json"


def install_engine():
    """Install mlx-audio into the Python that runs Holding Local, and note which packages
    that added, so deleting the last Mac voice can take them out again."""
    if engine_installed():
        return
    before = _installed_dists()
    if sys.version_info < (3, 11):
        raise RuntimeError("The Mac voices need Python 3.11 or newer. Reinstall Holding Local to update it.")
    uv = _uv()
    cmd = ([uv, "pip", "install", "--python", sys.executable, MLX_AUDIO] if uv
           else [sys.executable, "-m", "pip", "install", MLX_AUDIO])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
        raise RuntimeError("Could not install the Mac voice engine: " + " ".join(tail))
    import importlib
    importlib.invalidate_caches()
    added = sorted(_installed_dists() - before)
    _engine_record().parent.mkdir(parents=True, exist_ok=True)
    _engine_record().write_text(json.dumps({"packages": added}))


_engine_size: dict = {}


def engine_bytes() -> int:
    """Disk used by the packages Holding Local added for the Mac voices."""
    from importlib import metadata
    try:
        rec = _engine_record()
        key = rec.stat().st_mtime
        if _engine_size.get("key") == key:
            return _engine_size["n"]
        names = set(json.loads(rec.read_text())["packages"])
    except (OSError, ValueError, KeyError):
        return 0
    n = 0
    for d in metadata.distributions():
        if (d.metadata["Name"] or "").lower() in names:
            for f in d.files or []:
                try:
                    n += Path(d.locate_file(f)).stat().st_size
                except OSError:
                    pass
    _engine_size.update(key=key, n=n)
    return n


def uninstall_engine() -> int:
    """Remove the packages install_engine added. Only the ones it added: anything that was
    already here stays. Returns bytes freed."""
    try:
        names = json.loads(_engine_record().read_text())["packages"]
    except (OSError, ValueError, KeyError):
        return 0
    freed = engine_bytes()
    if names:
        uv = _uv()
        cmd = ([uv, "pip", "uninstall", "--python", sys.executable, *names] if uv
               else [sys.executable, "-m", "pip", "uninstall", "-y", *names])
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            return 0  # keep the record so the next delete tries again
    for k in [k for k in sys.modules if k == "mlx_audio" or k.startswith(("mlx_audio.", "mlx.", "mlx_lm"))]:
        sys.modules.pop(k, None)
    import importlib
    importlib.invalidate_caches()
    _engine_record().unlink(missing_ok=True)
    return freed


# ---------- files ----------
def hub_cache() -> Path:
    try:
        from huggingface_hub import constants
        return Path(constants.HF_HUB_CACHE)
    except ImportError:
        base = os.environ.get("HF_HOME") or str(Path.home() / ".cache" / "huggingface")
        return Path(os.environ.get("HF_HUB_CACHE") or Path(base) / "hub")


def repo_dir(repo: str) -> Path:
    return hub_cache() / ("models--" + repo.replace("/", "--"))


def _dir_bytes(d: Path) -> int:
    if not d.exists():
        return 0
    n = 0
    for p in d.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                n += p.stat().st_size
        except OSError:
            pass
    return n


def _marker(mid: str) -> Path:
    return state.MODELS / "mac-voices" / f"{mid}.ready"


def downloaded(mid: str) -> bool:
    return _marker(mid).exists() and repo_dir(CATALOG[mid]["repo"]).exists()


def helpers(mid: str) -> list[str]:
    """Helper repositories a voice uses: the known ones, plus any its first line fetched."""
    found = []
    try:
        found = json.loads(_marker(mid).read_text()).get("fetched", [])
    except (OSError, ValueError, AttributeError):
        pass
    return list(dict.fromkeys([*CATALOG[mid]["helpers"], *(r for r in found if r != CATALOG[mid]["repo"])]))


def _helper_owners(repo: str, exclude: str) -> list[str]:
    return [k for k in CATALOG if k != exclude and downloaded(k) and (repo in helpers(k) or repo == CATALOG[k]["repo"])]


def _hub_repos() -> set[str]:
    d = hub_cache()
    if not d.exists():
        return set()
    return {p.name[len("models--"):].replace("--", "/", 1) for p in d.glob("models--*") if p.is_dir()}


def bytes_on_disk(mid: str) -> int:
    m = CATALOG[mid]
    n = _dir_bytes(repo_dir(m["repo"]))
    for h in helpers(mid):
        # A helper shared with another downloaded voice is counted once, on the first voice that has it.
        owners = [k for k in CATALOG if h in helpers(k) and downloaded(k)]
        if not owners or owners[0] == mid:
            n += _dir_bytes(repo_dir(h))
    return n


def _remote_total(repo: str, fallback: int) -> int:
    try:
        from huggingface_hub import HfApi
        from mlx_audio.utils import DEFAULT_ALLOW_PATTERNS
        import fnmatch
        info = HfApi().model_info(repo, files_metadata=True)
        total = sum((s.size or 0) for s in info.siblings
                    if any(fnmatch.fnmatch(s.rfilename, p) for p in DEFAULT_ALLOW_PATTERNS))
        return total or fallback
    except Exception:
        return fallback


# ---------- the engine ----------
_models: dict[str, object] = {}
_gen_lock = threading.Lock()


def _load(mid: str):
    if mid in _models:
        return _models[mid]
    install_engine()  # back after an update that cleared it
    if os.environ.get("HOLDING_MLX_CPU") == "1":  # for machines without Metal (CI runners)
        import mlx.core as mx
        mx.set_default_device(mx.cpu)
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import get_model_path
    path = get_model_path(CATALOG[mid]["repo"])
    _models.clear()  # one Mac voice in memory at a time
    import gc
    gc.collect()
    _models[mid] = load_model(path)
    return _models[mid]


def unload(mid: str | None = None):
    with _gen_lock:
        if mid is None:
            _models.clear()
        else:
            _models.pop(mid, None)


def gender(voice: str) -> str:
    """Kokoro ids start af_/bf_ (female) or am_/bm_ (male); a blend goes by its heaviest part."""
    best, weight = (voice or "af_heart"), -1.0
    for part in str(voice or "af_heart").split("+"):
        name, _, w = part.partition(":")
        try:
            wv = float(w) if w else 1.0
        except ValueError:
            wv = 1.0
        if wv > weight:
            best, weight = name.strip(), wv
    return "male" if len(best) > 1 and best[1] == "m" else "female"


def instruction(feeling: float) -> str:
    """Qwen3-TTS reads delivery from plain words. The dial picks how much feeling to ask for."""
    if feeling < 0.4:
        return "Speak softly and calmly, slow and steady, like a parent quietly comforting their child."
    if feeling < 0.7:
        return "Speak warmly and gently, with tender affection, like a loving parent reassuring their child."
    return "Speak with heartfelt warmth and open emotion, tender and caring, like a parent holding their child close."


def generate(mid: str, text: str, voice: str, feeling: float, reference_wav: Path | None,
             ref_text: str) -> tuple[np.ndarray, int]:
    m = CATALOG[mid]
    if not downloaded(mid):
        raise FileNotFoundError(f"{m['name']} is not downloaded. Download it in Settings → Voice.")
    style = m["style"]
    kw: dict = {"verbose": False}
    if style == "instruct":
        kw.update(voice=QWEN_SPEAKERS[gender(voice)], instruct=instruction(feeling), lang_code="english")
    elif style == "preset":
        kw.update(voice=ORPHEUS_SPEAKERS[gender(voice)])
    elif style == "clone":
        kw.update(ref_audio=str(reference_wav))
        if m["feeling"]:
            kw.update(exaggeration=float(feeling))
    elif style == "clone_text":
        kw.update(ref_audio=str(reference_wav), ref_text=ref_text)
    elif style == "clone_dia":
        kw.update(ref_audio=str(reference_wav), ref_text=f"[S1] {ref_text}")
        text = f"[S1] {text}"
    with _gen_lock:
        model = _load(mid)
        chunks, sr = [], None
        for r in model.generate(text=text, **kw):
            chunks.append(np.asarray(r.audio, dtype=np.float32).reshape(-1))
            sr = r.sample_rate
    if not chunks:
        raise RuntimeError(f"{m['name']} made no audio.")
    return np.concatenate(chunks), int(sr or getattr(model, "sample_rate", 24000))


# ---------- download / delete ----------
def download(mid: str, job: dict, reference_wav_fn):
    """Runs in the download thread. Installs mlx-audio, fetches the model, then speaks one
    short line so every helper file it needs is fetched too and we know it works."""
    m = CATALOG[mid]
    if not supported():
        raise RuntimeError(unsupported_reason())
    job["phase"] = "installing"
    install_engine()
    seen_before = _hub_repos()
    from huggingface_hub import snapshot_download
    from mlx_audio.utils import DEFAULT_ALLOW_PATTERNS
    job["phase"] = "downloading"
    total = _remote_total(m["repo"], m["approx"])
    job["total"] = total
    start = _dir_bytes(repo_dir(m["repo"]))
    stop = threading.Event()

    def watch():
        while not stop.wait(0.5):
            job["done"] = min(total, _dir_bytes(repo_dir(m["repo"])))
    threading.Thread(target=watch, daemon=True).start()
    try:
        snapshot_download(m["repo"], allow_patterns=DEFAULT_ALLOW_PATTERNS)
    finally:
        stop.set()
    job["done"] = max(start, total)
    if job.get("cancel"):
        raise RuntimeError("cancelled")
    job["phase"] = "preparing"
    _marker(mid).parent.mkdir(parents=True, exist_ok=True)
    _marker(mid).write_text(json.dumps({"at": time.time(), "fetched": []}))
    try:
        from .chatterbox import REF_TEXT
        generate(mid, WARMUP_TEXT, "af_heart", 0.55, reference_wav_fn(), REF_TEXT)
    except Exception:
        _marker(mid).unlink(missing_ok=True)
        raise
    finally:
        # Whatever the download and first line pulled into the cache belongs to this voice,
        # so Delete removes it even if it isn't in the catalogue's helper list.
        fetched = sorted(_hub_repos() - seen_before - {m["repo"]})
        if _marker(mid).exists():
            _marker(mid).write_text(json.dumps({"at": time.time(), "fetched": fetched}))


def delete(mid: str) -> int:
    m = CATALOG[mid]
    unload(mid)
    freed = 0
    repos = [r for r in [m["repo"], *helpers(mid)] if not _helper_owners(r, mid)]
    for r in repos:
        d = repo_dir(r)
        freed += _dir_bytes(d)
        shutil.rmtree(d, ignore_errors=True)
    _marker(mid).unlink(missing_ok=True)
    if not any(downloaded(k) for k in CATALOG):
        unload()
        freed += uninstall_engine()
    return freed
