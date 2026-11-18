// Chatterbox Turbo (Resemble AI, MIT) on ONNX Runtime, with no DOM code, so the
// browser provider (onnxruntime-web on WebGPU) and the Node smoke test
// (onnxruntime-node on CPU) share it. Transformers.js has no Turbo class, so this
// runs the model card's four-session loop directly.
//
// Turbo is a 350M GPT-2 that writes speech tokens, plus an encoder that reads a
// reference voice and a one-step decoder that turns tokens into 24 kHz audio in
// that voice. It has no emotion dial, but reads tags such as [sigh] and [chuckle].

export const TURBO_REPO = 'ResembleAI/chatterbox-turbo-ONNX';
export const TURBO_SR = 24000;
export const START_SPEECH_TOKEN = 6561;
export const STOP_SPEECH_TOKEN = 6562;
export const SILENCE_TOKEN = 4299;
const KV_HEADS = 16; const HEAD_DIM = 64;
const REPETITION_PENALTY = 1.2;
const MAX_REF_SECONDS = 10;

/**
 * The build both engines use: a 4-bit language model, 8-bit everything else. About 960 MB.
 * Each graph's weights sit beside it in <file>_data.
 */
export const TURBO_GRAPHS = Object.freeze({
  speech_encoder: 'speech_encoder_quantized.onnx',
  embed_tokens: 'embed_tokens_quantized.onnx',
  language_model: 'language_model_q4.onnx',
  conditional_decoder: 'conditional_decoder_quantized.onnx',
});
export const TURBO_FILES = Object.freeze([
  'tokenizer.json', 'tokenizer_config.json',
  ...Object.values(TURBO_GRAPHS).flatMap((f) => [`onnx/${f}`, `onnx/${f}_data`]),
]);
export const turboUrl = (path) => `https://huggingface.co/${TURBO_REPO}/resolve/main/${path}`;

/** Speech tokens run at 25 per second; budget for slow, gentle delivery. */
export function tokenBudget(text) {
  return Math.min(1000, 80 + Math.ceil(String(text).length * 3));
}

/** No stop before this many speech tokens (one per character: faster than anyone talks). */
export function minTokens(text) {
  return String(text).split(/\s+/).filter(Boolean).join(' ').length;
}

/** Penalise tokens already spoken (in place), then pick the most likely: greedy, like the card. */
export function pickNext(logits, seen, penalty = REPETITION_PENALTY) {
  for (const id of seen) {
    const v = logits[id];
    logits[id] = v < 0 ? v * penalty : v / penalty;
  }
  let best = 0; let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) { max = logits[i]; best = i; }
  return best;
}

/** [1, a, d] + [1, b, d] -> [1, a + b, d] */
function concatSeq(ort, x, y) {
  const d = x.dims[2];
  const out = new x.data.constructor(x.data.length + y.data.length);
  out.set(x.data, 0); out.set(y.data, x.data.length);
  return new ort.Tensor(x.type, out, [1, x.dims[1] + y.dims[1], d]);
}

const i64 = (ort, arr, dims) => new ort.Tensor('int64', BigInt64Array.from(arr, (v) => BigInt(v)), dims);

async function dataOf(t) {
  return typeof t.getData === 'function' ? t.getData(true) : t.data;
}

function inputType(session, name) {
  const meta = session.inputMetadata;
  if (Array.isArray(meta)) {
    const m = meta.find((x) => x.name === name);
    if (m?.type) return m.type;
  }
  return 'float32';
}

/**
 * @param {object} o
 * @param {object} o.ort  onnxruntime (web or node)
 * @param {{ encode: (text: string) => number[] }} o.tokenizer
 * @param {(key: keyof TURBO_GRAPHS) => Promise<object>} o.createSession  an InferenceSession for a graph
 */
export function createTurbo({ ort, tokenizer, createSession }) {
  let s = null; // { speech_encoder, embed_tokens, language_model, conditional_decoder }
  const voices = new Map();
  let chain = Promise.resolve(); // one generation at a time: the sessions are not re-entrant

  async function generate(text, cond) {
    const ids = tokenizer.encode(String(text));
    const lm = s.language_model;
    const pastNames = lm.inputNames.filter((n) => n.includes('past_key_values'));
    const usesPositions = lm.inputNames.includes('position_ids');
    const embedOut = s.embed_tokens.outputNames[0];
    const generated = [START_SPEECH_TOKEN];
    const seen = new Set(generated);
    let past = Object.fromEntries(pastNames.map((n) => {
      const type = inputType(lm, n);
      const data = type === 'float16' ? new Uint16Array(0) : new Float32Array(0);
      return [n, new ort.Tensor(type, data, [1, KV_HEADS, 0, HEAD_DIM])];
    }));
    let inputIds = i64(ort, ids, [1, ids.length]);
    let total = 0; let pos = 0;
    const budget = tokenBudget(text);
    const floor = Math.min(minTokens(text), budget - 1);
    try {
      for (let i = 0; i < budget; i++) {
        let embeds = (await s.embed_tokens.run({ input_ids: inputIds }))[embedOut];
        if (i === 0) embeds = concatSeq(ort, cond.cond_emb, embeds);
        const n = embeds.dims[1];
        total += n;
        const feeds = { inputs_embeds: embeds, attention_mask: i64(ort, new Array(total).fill(1), [1, total]), ...past };
        if (usesPositions) feeds.position_ids = i64(ort, Array.from({ length: n }, (_, k) => pos + k), [1, n]);
        pos += n;
        const out = await lm.run(feeds);
        const logitsT = out[lm.outputNames[0]];
        const all = await dataOf(logitsT);
        const vocab = logitsT.dims[2];
        const last = Float32Array.from(all.subarray((logitsT.dims[1] - 1) * vocab, logitsT.dims[1] * vocab));
        if (i < floor) last[STOP_SPEECH_TOKEN] = -Infinity;
        const next = pickNext(last, seen);
        generated.push(next); seen.add(next);
        const fresh = {};
        for (const name of lm.outputNames.slice(1)) fresh[name.replace('present', 'past_key_values')] = out[name];
        for (const t of Object.values(past)) t.dispose?.();
        past = fresh;
        if (next === STOP_SPEECH_TOKEN) break;
        inputIds = i64(ort, [next], [1, 1]);
      }
    } finally {
      for (const t of Object.values(past)) t.dispose?.();
    }
    const speech = generated.slice(1);
    if (speech[speech.length - 1] === STOP_SPEECH_TOKEN) speech.pop();
    const prompt = Array.from(await dataOf(cond.prompt_token), Number);
    const tokens = [...prompt, ...speech, SILENCE_TOKEN, SILENCE_TOKEN, SILENCE_TOKEN];
    const dec = s.conditional_decoder;
    const wav = (await dec.run({
      speech_tokens: i64(ort, tokens, [1, tokens.length]),
      speaker_embeddings: cond.speaker_embeddings,
      speaker_features: cond.speaker_features,
    }))[dec.outputNames[0]];
    const data = await dataOf(wav);
    return { audio: data instanceof Float32Array ? data : Float32Array.from(data), tokens: speech.length };
  }

  return {
    get loaded() { return !!s; },

    async load() {
      if (s) return;
      const names = Object.keys(TURBO_GRAPHS);
      const sessions = [];
      for (const k of names) sessions.push(await createSession(k)); // one at a time: less peak memory
      s = Object.fromEntries(names.map((k, i) => [k, sessions[i]]));
    },

    /**
     * Read a reference voice once and keep what the encoder makes of it.
     * @param {string} key
     * @param {() => Promise<Float32Array>} getAudio  mono audio at 24 kHz
     */
    voice(key, getAudio) {
      if (!voices.has(key)) {
        const p = (async () => {
          let audio = await getAudio();
          if (audio.length > MAX_REF_SECONDS * TURBO_SR) audio = audio.subarray(0, MAX_REF_SECONDS * TURBO_SR);
          const enc = s.speech_encoder;
          const out = await enc.run({ audio_values: new ort.Tensor('float32', Float32Array.from(audio), [1, audio.length]) });
          const [cond_emb, prompt_token, speaker_embeddings, speaker_features] = enc.outputNames.map((n) => out[n]);
          return { cond_emb, prompt_token, speaker_embeddings, speaker_features };
        })();
        voices.set(key, p);
        p.catch(() => voices.delete(key));
      }
      return voices.get(key);
    },

    /** Text to 24 kHz mono audio in a voice from voice(). Turbo ignores the feeling. */
    synthesize(text, cond) {
      const run = chain.then(() => generate(text, cond));
      chain = run.catch(() => {});
      return run.then((r) => limitPeak(trimSilence(r.audio)));
    },

    async dispose() {
      voices.clear();
      for (const x of Object.values(s || {})) { try { await x.release?.(); } catch { /* ignore */ } }
      s = null;
    },
  };
}

export function limitPeak(a, ceiling = 0.95) {
  let peak = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > peak) peak = v; }
  if (peak <= ceiling) return a;
  const k = ceiling / peak; const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * k;
  return out;
}

export function trimSilence(a, threshold = 0.006, padMs = 60) {
  let st = 0; let e = a.length - 1;
  while (st < a.length && Math.abs(a[st]) < threshold) st++;
  while (e > st && Math.abs(a[e]) < threshold) e--;
  if (st >= e) return a;
  const pad = Math.round(TURBO_SR * padMs / 1000);
  return a.subarray(Math.max(0, st - pad), Math.min(a.length, e + pad));
}
