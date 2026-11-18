// Chatterbox (Resemble AI, MIT) text-to-speech on Transformers.js, with no DOM
// code, so the browser provider and the Node smoke test share it.
//
// Chatterbox is a 0.5B Llama that writes speech tokens, plus an encoder that
// reads a few seconds of a reference voice and a decoder that turns tokens into
// 24 kHz audio in that voice. "exaggeration" is its emotion dial.
//
// lib: the Transformers.js module (>= 4.0), passed in so the caller decides
// where it comes from (CDN in the browser, npm in Node).

export const CHATTERBOX_REPO = 'onnx-community/chatterbox-ONNX';
export const CHATTERBOX_SR = 24000;
export const DEFAULT_VOICE_URL = `https://huggingface.co/${CHATTERBOX_REPO}/resolve/main/default_voice.wav`;
const MAX_REF_SECONDS = 10;

/** Speech tokens run at 25 per second; budget for slow, gentle delivery. */
export function tokenBudget(text) {
  return Math.min(1000, 80 + Math.ceil(String(text).length * 3));
}

/** Per-file precision. The language model is the only part with 4-bit builds. */
export function dtypesFor(device, { f16 = false } = {}) {
  return {
    embed_tokens: 'fp32',
    speech_encoder: 'fp32',
    language_model: device === 'webgpu' && f16 ? 'q4f16' : 'q4',
    conditional_decoder: 'fp32',
  };
}

export function createChatterbox(lib, { device = 'webgpu', f16 = false, repo = CHATTERBOX_REPO } = {}) {
  // ChatterboxModel by name: AutoModel does not map model_type 'chatterbox' to its four sessions.
  const { ChatterboxModel, AutoProcessor, Tensor } = lib;
  if (!ChatterboxModel) throw new Error('This Transformers.js has no Chatterbox support (needs 4.0 or later).');
  let model = null; let processor = null;
  const voices = new Map(); // key -> Promise<speaker conditioning>

  return {
    get loaded() { return !!model; },

    async load(progress_callback) {
      if (model) return;
      [model, processor] = await Promise.all([
        ChatterboxModel.from_pretrained(repo, { device, dtype: dtypesFor(device, { f16 }), progress_callback }),
        AutoProcessor.from_pretrained(repo, { progress_callback }),
      ]);
    },

    /**
     * Read a reference voice once and keep what the encoder makes of it.
     * @param {string} key  cache key, e.g. the Kokoro voice id it was rendered from
     * @param {() => Promise<Float32Array>} getAudio  mono audio at 24 kHz
     */
    voice(key, getAudio) {
      if (!voices.has(key)) {
        const p = (async () => {
          let audio = await getAudio();
          if (audio.length > MAX_REF_SECONDS * CHATTERBOX_SR) audio = audio.subarray(0, MAX_REF_SECONDS * CHATTERBOX_SR);
          const cond = await model.encode_speech(new Tensor('float32', Float32Array.from(audio), [1, audio.length]));
          return { audio_features: cond.audio_features, audio_tokens: cond.audio_tokens, speaker_embeddings: cond.speaker_embeddings, speaker_features: cond.speaker_features };
        })();
        voices.set(key, p);
        p.catch(() => voices.delete(key));
      }
      return voices.get(key);
    },

    /** Text to 24 kHz mono audio in a voice from voice(). */
    async synthesize(text, cond, { exaggeration = 0.5 } = {}) {
      const inputs = await processor(String(text));
      const waveform = await model.generate({ ...inputs, ...cond, exaggeration, max_new_tokens: tokenBudget(text) });
      const data = waveform.data instanceof Float32Array ? waveform.data : Float32Array.from(waveform.data);
      return limitPeak(trimSilence(data));
    },

    async dispose() {
      voices.clear();
      try { await model?.dispose?.(); } catch { /* ignore */ }
      model = null; processor = null;
    },
  };
}

/** Chatterbox can overshoot full scale on emphatic lines; scale down instead of clipping. */
export function limitPeak(a, ceiling = 0.95) {
  let peak = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > peak) peak = v; }
  if (peak <= ceiling) return a;
  const k = ceiling / peak; const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * k;
  return out;
}

/** Drop leading and trailing near-silence so phrase gaps stay even. */
export function trimSilence(a, threshold = 0.006, padMs = 60) {
  let s = 0; let e = a.length - 1;
  while (s < a.length && Math.abs(a[s]) < threshold) s++;
  while (e > s && Math.abs(a[e]) < threshold) e--;
  if (s >= e) return a;
  const pad = Math.round(CHATTERBOX_SR * padMs / 1000);
  return a.subarray(Math.max(0, s - pad), Math.min(a.length, e + pad));
}

/** Join clips with short pauses, up to a length: a reference read from several lines. */
export function joinClips(clips, { gapSeconds = 0.35, maxSeconds = MAX_REF_SECONDS } = {}) {
  const gap = new Float32Array(Math.round(gapSeconds * CHATTERBOX_SR));
  const parts = []; let n = 0; const max = maxSeconds * CHATTERBOX_SR;
  for (const c of clips) {
    if (n >= max) break;
    if (parts.length) { parts.push(gap); n += gap.length; }
    const take = c.subarray(0, Math.max(0, max - n));
    parts.push(take); n += take.length;
  }
  const out = new Float32Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Linear resample, enough for a reference clip. */
export function resample(a, from, to = CHATTERBOX_SR) {
  if (from === to) return a;
  const n = Math.floor(a.length * to / from); const out = new Float32Array(n); const r = from / to;
  for (let i = 0; i < n; i++) { const x = i * r; const j = Math.floor(x); const f = x - j; out[i] = (a[j] || 0) * (1 - f) + (a[j + 1] || 0) * f; }
  return out;
}
