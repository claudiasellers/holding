"""Model tiers and voice presets. Kept in one place so the app, the docs and the
RAG/fine-tune skill can all read the same choices (see GET /v1/catalog)."""

# Ollama tags, smallest first. min_gb is total system RAM (or unified memory on
# Apple Silicon); vram_gb is dedicated GPU memory that also qualifies a tier.
LLM_TIERS = [
    {"id": "low", "tag": "qwen3.5:4b", "min_gb": 0, "vram_gb": 0, "download": "3.3-4.0 GB",
     "note": "8 GB machines. Thinking is forced off."},
    {"id": "default", "tag": "gemma4:e4b", "min_gb": 15, "vram_gb": 8, "download": "6.6-9.5 GB",
     "note": "16 GB RAM, 16 GB Apple Silicon, or an 8 GB GPU."},
    {"id": "mid", "tag": "gemma4:12b", "min_gb": 30, "vram_gb": 12, "download": "7.7-8.0 GB",
     "note": "32 GB Mac or a 12-16 GB GPU."},
    {"id": "high", "tag": "gemma4:26b", "min_gb": 46, "vram_gb": 22, "download": "16-19 GB",
     "note": "48 GB+ Mac or a 24 GB GPU. Mixture-of-experts, so fast for its size."},
]
ALTERNATES = ["qwen3.5:2b", "qwen3.5:9b", "qwen3.5:27b", "gemma4:e2b"]
EMBED_TAG = "nomic-embed-text"

# Exact WebLLM prebuilt ids (present in @mlc-ai/web-llm >= 0.2.87) for the
# browser/phone path, which the app runs itself.
WEBLLM = {
    "phone_low": {"id": "Qwen3.5-0.8B-q4f16_1-MLC", "vram_mb": 1629},
    "phone_default": {"id": "Qwen3.5-2B-q4f16_1-MLC", "vram_mb": 2245},
    "phone_roleplay": {"id": "Hermes-3-Llama-3.2-3B-q4f16_1-MLC", "vram_mb": 2264},
    "laptop": {"id": "gemma-4-E2B-it-q4f16_1-MLC", "vram_mb": 3387},
    "laptop_alt": {"id": "Qwen3.5-4B-q4f16_1-MLC", "vram_mb": 3868},
}

# Kokoro voices per archetype preset used by the app. "a+b" blends two voices
# 50/50 (server only); "a:0.7+b:0.3" sets weights. browser_voice is the closest
# single voice for kokoro-js, which has no blending.
ARCHETYPE_VOICES = {
    "steady-grandmother": {"voice": "bf_emma", "speed": 0.88, "browser_voice": "bf_emma"},
    "gentle-giant": {"voice": "am_michael", "speed": 0.88, "browser_voice": "am_michael"},
    "warm-aunt": {"voice": "af_heart", "speed": 0.95, "browser_voice": "af_heart"},
    "calm-elder": {"voice": "af_nicole:0.55+am_michael:0.45", "speed": 0.86, "browser_voice": "af_nicole"},
    "protective-mother": {"voice": "af_bella:0.6+af_heart:0.4", "speed": 0.93, "browser_voice": "af_bella"},
    "wise-mentor": {"voice": "bm_george", "speed": 0.88, "browser_voice": "bm_george"},
    "cheerful-uncle": {"voice": "am_puck", "speed": 1.0, "browser_voice": "am_puck"},
    "abstract-light": {"voice": "af_nicole:0.7+af_sky:0.3", "speed": 0.85, "browser_voice": "af_nicole"},
}
DEFAULT_VOICE = "af_heart"

# OpenAI voice names some clients send by default, mapped to warm Kokoro voices.
OPENAI_VOICE_ALIASES = {
    "alloy": "af_heart", "nova": "af_bella", "shimmer": "af_nicole", "echo": "am_michael",
    "onyx": "am_fenrir", "fable": "bm_fable", "sage": "bf_emma", "coral": "af_heart",
    "ash": "am_michael", "ballad": "bm_george", "verse": "am_puck",
}

KOKORO_FILES = {
    # int8 is ~88 MB and nearly indistinguishable; fp32 is ~310 MB.
    "int8": ("kokoro-v1.0.int8.onnx",
             "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.int8.onnx"),
    "fp32": ("kokoro-v1.0.onnx",
             "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx"),
    "voices": ("voices-v1.0.bin",
               "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin"),
}

WHISPER_DEFAULT = "small"  # faster-whisper size; "base" on 8 GB machines


def pick_tier(ram_gb: float, vram_gb: float = 0.0) -> dict:
    chosen = LLM_TIERS[0]
    for tier in LLM_TIERS:
        if ram_gb >= tier["min_gb"] or (tier["vram_gb"] and vram_gb >= tier["vram_gb"]):
            chosen = tier
    return chosen


def needs_think_off(model: str) -> bool:
    m = model.lower()
    return m.startswith(("qwen3", "deepseek-r1", "gpt-oss", "magistral", "gemma4")) or "think" in m

# Mirror used if GitHub is unreachable: the same Kokoro v1.0 weights from
# Hugging Face, with per-voice raw float32 files assembled into voices-v1.0.bin.
HF_KOKORO = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main"
HF_KOKORO_MODEL = {"int8": "onnx/model_quantized.onnx", "fp32": "onnx/model.onnx"}
HF_VOICES = ["af_heart", "af_bella", "af_nicole", "af_sky", "af_kore", "af_sarah", "am_michael", "am_puck",
             "am_fenrir", "am_eric", "bf_emma", "bf_isabella", "bm_george", "bm_fable", "bm_lewis"]
