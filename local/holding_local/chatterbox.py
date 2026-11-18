"""Chatterbox and Chatterbox Turbo (Resemble AI, MIT) on ONNX Runtime, on any computer.

- Chatterbox (onnx-community/chatterbox-ONNX): an emotion dial ("exaggeration").
  4-bit language model, encoder and decoder at fp32. About 1.5 GB.
- Chatterbox Turbo (ResembleAI/chatterbox-turbo-ONNX): smaller and much faster,
  with a one-step decoder and tags such as [sigh] and [chuckle], but no dial.
  4-bit language model, 8-bit encoder and decoder. About 960 MB.

Both copy a voice from a few seconds of reference audio. Holding Local renders
that reference with Kokoro in the parent's own voice (blends included), so every
parent keeps sounding like themselves. No PyTorch.

Generation loop adapted from the model cards' reference scripts and the
chatterbox-onnx package (MIT): greedy decoding with a repetition penalty.
"""
import re
import threading
from dataclasses import dataclass

import numpy as np

from . import state

SR = 24000
START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562
SILENCE_TOKEN = 4299  # Turbo: padded after the speech so the last word isn't clipped
KV_HEADS, HEAD_DIM = 16, 64
REPETITION_PENALTY = 1.2
DEFAULT_EXAGGERATION = 0.55
REF_TEXT = ("I'm right here with you. There's no hurry at all. "
            "Take whatever time you need, and I'll stay right here.")


@dataclass(frozen=True)
class Variant:
    id: str
    repo: str
    # (path inside the repo, approximate size in bytes). Each .onnx needs its .onnx_data beside it.
    files: tuple
    encoder: str
    embed: str
    lm: str
    decoder: str
    turbo: bool

    @property
    def base_url(self):
        return f"https://huggingface.co/{self.repo}/resolve/main"


def _graph(name, onnx_kb, data_bytes):
    return ((f"onnx/{name}", onnx_kb * 1000), (f"onnx/{name}_data", data_bytes))


VARIANTS = {
    "chatterbox": Variant(
        id="chatterbox", repo="onnx-community/chatterbox-ONNX",
        files=(("tokenizer.json", 200_000),
               *_graph("speech_encoder.onnx", 1180, 591_000_000),
               *_graph("embed_tokens.onnx", 13, 61_600_000),
               *_graph("language_model_q4.onnx", 228, 354_000_000),
               *_graph("conditional_decoder.onnx", 6350, 534_000_000)),
        encoder="speech_encoder.onnx", embed="embed_tokens.onnx",
        lm="language_model_q4.onnx", decoder="conditional_decoder.onnx", turbo=False),
    "chatterbox-turbo": Variant(
        id="chatterbox-turbo", repo="ResembleAI/chatterbox-turbo-ONNX",
        files=(("tokenizer.json", 3_560_000),
               *_graph("speech_encoder_quantized.onnx", 1210, 355_000_000),
               *_graph("embed_tokens_quantized.onnx", 3, 67_300_000),
               *_graph("language_model_q4.onnx", 275, 204_000_000),
               *_graph("conditional_decoder_quantized.onnx", 2200, 327_000_000)),
        encoder="speech_encoder_quantized.onnx", embed="embed_tokens_quantized.onnx",
        lm="language_model_q4.onnx", decoder="conditional_decoder_quantized.onnx", turbo=True),
}
FILES = list(VARIANTS["chatterbox"].files)
BASE_URL = VARIANTS["chatterbox"].base_url


def folder(mid: str = "chatterbox"):
    return state.MODELS / mid


def file_paths(mid: str = "chatterbox"):
    return [folder(mid) / rel for rel, _ in VARIANTS[mid].files]


def available(mid: str = "chatterbox") -> bool:
    return all(p.exists() and p.stat().st_size > 0 for p in file_paths(mid))


def token_budget(text: str) -> int:
    """Speech tokens run at 25 a second; leave room for slow, gentle delivery."""
    return min(1000, 80 + 3 * len(text))


def min_tokens(text: str) -> int:
    """No stop before this many speech tokens: 25 a second, so one per character allows up to
    25 characters a second, faster than anyone talks. Greedy decoding can otherwise stop mid-line."""
    return len(" ".join(str(text).split()))


def split_long(text: str, limit: int = 280) -> list[str]:
    """Chatterbox is best on a sentence or two at a time."""
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    parts, cur = [], ""
    for s in re.split(r"(?<=[.!?…])\s+", text):
        if cur and len(cur) + len(s) + 1 > limit:
            parts.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        parts.append(cur)
    return parts


def apply_repetition_penalty(scores: np.ndarray, ids: np.ndarray, penalty: float = REPETITION_PENALTY):
    picked = np.take_along_axis(scores, ids, axis=1)
    picked = np.where(picked < 0, picked * penalty, picked / penalty)
    out = scores.copy()
    np.put_along_axis(out, ids, picked, axis=1)
    return out


def resample(a: np.ndarray, src: int, dst: int = SR) -> np.ndarray:
    if src == dst:
        return a.astype(np.float32)
    n = int(len(a) * dst / src)
    x = np.linspace(0, len(a) - 1, n)
    return np.interp(x, np.arange(len(a)), a).astype(np.float32)


class Chatterbox:
    def __init__(self, mid: str = "chatterbox", threads: int | None = None):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.variant = v = VARIANTS[mid]
        d = folder(mid)
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        providers = ["CPUExecutionProvider"]

        def session(name):
            return ort.InferenceSession(str(d / "onnx" / name), sess_options=opts, providers=providers)

        self.tokenizer = Tokenizer.from_file(str(d / "tokenizer.json"))
        self.speech_encoder = session(v.encoder)
        self.embed_tokens = session(v.embed)
        self.language_model = session(v.lm)
        self.decoder = session(v.decoder)
        self._init_io()
        self._voices: dict[str, tuple] = {}
        self._lock = threading.Lock()

    def _init_io(self):
        self._embed_inputs = {i.name for i in self.embed_tokens.get_inputs()}
        lm_inputs = self.language_model.get_inputs()
        self._lm_inputs = {i.name for i in lm_inputs}
        # Cache inputs by name, in the order the model lists them (its outputs follow the same order).
        self._past = [(i.name, np.float16 if i.type == "tensor(float16)" else np.float32)
                      for i in lm_inputs if "past_key_values" in i.name]

    def condition(self, key: str, audio_24k_fn):
        """Encode a reference voice once; audio_24k_fn() returns mono float32 at 24 kHz."""
        if key not in self._voices:
            audio = np.asarray(audio_24k_fn(), dtype=np.float32)[: SR * 10]
            outs = self.speech_encoder.run(None, {"audio_values": audio[np.newaxis, :]})
            self._voices[key] = tuple(outs)  # cond_emb, prompt_token, speaker_embeddings, speaker_features
            if len(self._voices) > 32:
                self._voices.pop(next(iter(self._voices)))
        return self._voices[key]

    def generate(self, text: str, cond, exaggeration: float = DEFAULT_EXAGGERATION) -> np.ndarray:
        cond_emb, prompt_token, speaker_embeddings, speaker_features = cond
        turbo = self.variant.turbo
        input_ids = np.array([self.tokenizer.encode(text).ids], dtype=np.int64)
        position_ids = np.where(input_ids >= START_SPEECH_TOKEN, 0,
                                np.arange(input_ids.shape[1])[np.newaxis, :] - 1).astype(np.int64)
        embed_in = {"input_ids": input_ids, "position_ids": position_ids,
                    "exaggeration": np.array([exaggeration], dtype=np.float32)}
        embed_in = {k: v for k, v in embed_in.items() if k in self._embed_inputs}
        tokens = np.array([[START_SPEECH_TOKEN]], dtype=np.int64)
        past, mask, pos = None, None, None
        with self._lock:
            floor = min(min_tokens(text), token_budget(text) - 1)
            for i in range(token_budget(text)):
                embeds = self.embed_tokens.run(None, embed_in)[0]
                if i == 0:
                    embeds = np.concatenate((cond_emb, embeds), axis=1)
                    batch, seq, _ = embeds.shape
                    past = {name: np.zeros([batch, KV_HEADS, 0, HEAD_DIM], dtype=dt) for name, dt in self._past}
                    mask = np.ones((batch, seq), dtype=np.int64)
                    pos = np.arange(seq, dtype=np.int64)[np.newaxis, :]
                lm_in = dict(inputs_embeds=embeds, attention_mask=mask, **past)
                if "position_ids" in self._lm_inputs:
                    lm_in["position_ids"] = pos
                logits, *present = self.language_model.run(None, lm_in)
                # Penalise every speech token so far, as both model cards and Transformers.js do.
                # Penalising only the last one let greedy decoding fall into a loop of near-silence
                # that never reached the stop token (a 4 s line came out as 0.9 s after trimming).
                scores = apply_repetition_penalty(logits[:, -1, :], np.unique(tokens)[np.newaxis, :])
                if i < floor:
                    scores[:, STOP_SPEECH_TOKEN] = -np.inf
                nxt = np.argmax(scores, axis=-1, keepdims=True).astype(np.int64)
                tokens = np.concatenate((tokens, nxt), axis=-1)
                if (nxt.flatten() == STOP_SPEECH_TOKEN).all():
                    break
                embed_in["input_ids"] = nxt
                if "position_ids" in embed_in:
                    embed_in["position_ids"] = np.full((1, 1), i + 1, dtype=np.int64)
                mask = np.concatenate([mask, np.ones((mask.shape[0], 1), dtype=np.int64)], axis=1)
                pos = pos[:, -1:] + 1
                for j, key in enumerate(past):
                    past[key] = present[j]
            speech = tokens[:, 1:]
            if speech.shape[1] and speech[0, -1] == STOP_SPEECH_TOKEN:
                speech = speech[:, :-1]
            parts = [prompt_token.astype(np.int64), speech]
            if turbo:
                parts.append(np.full((speech.shape[0], 3), SILENCE_TOKEN, dtype=np.int64))
            speech = np.concatenate(parts, axis=1)
            wav = self.decoder.run(None, {"speech_tokens": speech, "speaker_embeddings": speaker_embeddings,
                                          "speaker_features": speaker_features})[0]
        return limit_peak(trim_silence(np.squeeze(wav, axis=0).astype(np.float32)))


def limit_peak(a: np.ndarray, ceiling: float = 0.95) -> np.ndarray:
    """Chatterbox can overshoot full scale on emphatic lines; scale down instead of clipping."""
    peak = float(np.abs(a).max()) if a.size else 0.0
    return a * (ceiling / peak) if peak > ceiling else a


def trim_silence(a: np.ndarray, threshold: float = 0.006, pad_ms: int = 60, sr: int = SR) -> np.ndarray:
    idx = np.flatnonzero(np.abs(a) >= threshold)
    if idx.size == 0:
        return a
    pad = sr * pad_ms // 1000
    return a[max(0, idx[0] - pad): min(len(a), idx[-1] + pad)]


_engines: dict[str, Chatterbox] = {}
_engine_lock = threading.Lock()


def engine(mid: str = "chatterbox") -> Chatterbox:
    with _engine_lock:
        if mid not in _engines:
            if not available(mid):
                raise FileNotFoundError(f"{mid} is not downloaded. Download it in Settings → Voice, "
                                        f"or run: holding-local voice download {mid}")
            # One expressive model in memory at a time.
            _engines.clear()
            _engines[mid] = Chatterbox(mid)
        return _engines[mid]


def unload(mid: str | None = None):
    with _engine_lock:
        if mid is None:
            _engines.clear()
        else:
            _engines.pop(mid, None)


def generate(mid: str, text: str, reference_24k_fn, voice_key: str, exaggeration: float) -> tuple[np.ndarray, int]:
    """Speak `text` in the voice that reference_24k_fn() renders. Long text goes a sentence or two at a time."""
    e = engine(mid)
    cond = e.condition(voice_key, reference_24k_fn)
    gap = np.zeros(int(SR * 0.3), dtype=np.float32)
    out = []
    for part in split_long(text):
        if out:
            out.append(gap)
        out.append(e.generate(part, cond, exaggeration))
    return (np.concatenate(out) if out else np.zeros(1, dtype=np.float32)), SR
