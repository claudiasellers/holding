// Kokoro-82M neural TTS running in the browser via kokoro-js (Transformers.js +
// ONNX Runtime Web). The model (~92 MB at q8, ~330 MB at fp32) downloads once
// from Hugging Face into the browser cache, then speaks fully on this device.
// The library is loaded lazily from the CDN so it is not part of the app bundle.
//
// cfg: { device: 'auto'|'wasm'|'webgpu' = 'auto', dtype?: 'q8'|'fp32'|'fp16'|'q4'|'q4f16' }
import { registerTTSProvider } from './providers.js';

export const KOKORO_VERSION = '1.2.1';
// dist/kokoro.web.js is the package's self-contained browser bundle (it includes
// Transformers.js); ONNX Runtime's .wasm files are fetched from jsDelivr by it.
const KOKORO_URL = `https://cdn.jsdelivr.net/npm/kokoro-js@${KOKORO_VERSION}/dist/kokoro.web.js`;
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const LIB_TIMEOUT_MS = 30000;
const PHRASE_GAP_MS = 700;

/**
 * English voices shipped with kokoro-js 1.2.1, with the library's own quality
 * grades. a = American, b = British; f = female, m = male.
 */
export const KOKORO_VOICES = Object.freeze([
  ['af_heart', 'Heart', 'A'], ['af_bella', 'Bella', 'A-'], ['af_nicole', 'Nicole', 'B-'], ['af_aoede', 'Aoede', 'C+'],
  ['af_kore', 'Kore', 'C+'], ['af_sarah', 'Sarah', 'C+'], ['af_alloy', 'Alloy', 'C'], ['af_nova', 'Nova', 'C'],
  ['af_sky', 'Sky', 'C-'], ['af_jessica', 'Jessica', 'D'], ['af_river', 'River', 'D'],
  ['am_fenrir', 'Fenrir', 'C+'], ['am_michael', 'Michael', 'C+'], ['am_puck', 'Puck', 'C+'], ['am_echo', 'Echo', 'D'],
  ['am_eric', 'Eric', 'D'], ['am_liam', 'Liam', 'D'], ['am_onyx', 'Onyx', 'D'], ['am_santa', 'Santa', 'D-'], ['am_adam', 'Adam', 'F+'],
  ['bf_emma', 'Emma', 'B-'], ['bf_isabella', 'Isabella', 'C'], ['bf_alice', 'Alice', 'D'], ['bf_lily', 'Lily', 'D'],
  ['bm_fable', 'Fable', 'C'], ['bm_george', 'George', 'C'], ['bm_lewis', 'Lewis', 'D+'], ['bm_daniel', 'Daniel', 'D'],
].map(([id, name, grade]) => ({
  id,
  label: `${name} (${id[0] === 'b' ? 'British' : 'American'}, grade ${grade})`,
  lang: id[0] === 'b' ? 'en-GB' : 'en-US',
  gender: id[1] === 'f' ? 'f' : 'm',
  grade,
})));

let libPromise = null;
function loadLib() {
  if (!libPromise) {
    libPromise = Promise.race([
      import(/* @vite-ignore */ KOKORO_URL),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out loading the neural voice library. Check your connection (needed only for the first download).')), LIB_TIMEOUT_MS)),
    ]).catch((err) => { libPromise = null; throw err instanceof Error ? err : new Error(String(err)); });
  }
  return libPromise;
}

let tts = null; let ttsKey = ''; let loading = null;
let ctx = null; let analyser = null; let gain = null;

function audioCtx() {
  if (!ctx) {
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) throw new Error('This browser cannot play generated audio (no Web Audio).');
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.3;
    gain = ctx.createGain();
    analyser.connect(gain).connect(ctx.destination);
  }
  return ctx;
}

/** Call from a user gesture (first tap) so iOS/Chrome allow audio later. */
export function unlockAudio() {
  try {
    const c = audioCtx();
    if (c.state === 'suspended') c.resume();
    const b = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = b; src.connect(c.destination); src.start(0);
  } catch { /* ignore */ }
}

async function pickDevice(pref) {
  if (pref === 'wasm' || pref === 'webgpu') return pref;
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const a = await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 2000))]);
      if (a) return 'webgpu';
    }
  } catch { /* fall through */ }
  return 'wasm';
}

function splitPhrases(text) {
  return String(text || '').split(/\s*(?:…|\.\.\.)\s*/).map((p) => p.trim()).filter(Boolean);
}

const sleep = (ms, signal) => new Promise((r) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); r(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

let current = null;

const kokoro = {
  id: 'kokoro',
  label: 'Neural voice on this device (Kokoro, ~90 MB download)',
  local: true,
  _cfg: {},

  async isAvailable() {
    if (typeof WebAssembly === 'undefined') return { ok: false, reason: 'This browser has no WebAssembly.' };
    if (typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) return { ok: false, reason: 'This browser has no Web Audio.' };
    const mem = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
    if (mem && mem < 2) return { ok: false, reason: 'This device may not have enough memory for the neural voice. Device voices will be used.' };
    return { ok: true };
  },

  /** Download (first time) and load the model. */
  async init(cfg = {}, onProgress) {
    kokoro._cfg = { ...cfg };
    const device = await pickDevice(cfg.device || 'auto');
    // The kokoro-js README recommends fp32 on WebGPU; q8 is the small CPU build.
    const dtype = cfg.dtype || (device === 'webgpu' ? 'fp32' : 'q8');
    let key = `${device}:${dtype}`;
    if (tts && ttsKey === key) { onProgress?.({ text: 'Ready', progress: 1 }); return; }
    if (loading && loading.key === key) return loading.promise;
    const promise = (async () => {
      onProgress?.({ text: 'Loading voice library…', progress: 0 });
      const { KokoroTTS } = await loadLib();
      const files = new Map();
      const progress_callback = (p) => {
        // Transformers.js reports per file: {status:'progress', file, loaded, total, progress}
        if (p?.status === 'progress' && p.file) {
          files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
          let l = 0; let t = 0; for (const f of files.values()) { l += f.loaded; t += f.total; }
          const frac = t ? l / t : 0;
          onProgress?.({ text: `Downloading voice… ${Math.round(l / 1e6)} / ${Math.round(t / 1e6)} MB`, progress: Math.min(0.99, frac) });
        } else if (p?.status === 'ready') {
          onProgress?.({ text: 'Preparing voice…', progress: 0.99 });
        }
      };
      let model;
      try {
        model = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype, device, progress_callback });
      } catch (err) {
        if (device === 'webgpu' && cfg.device !== 'webgpu') {
          // Some GPUs fail at session creation; the CPU build always works.
          model = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'wasm', progress_callback });
          key = 'wasm:q8';
        } else {
          const msg = String(err?.message || err);
          if (/quota|storage/i.test(msg)) throw new Error('Not enough storage for the neural voice. Free some space or use device voices.');
          if (/fetch|network|Failed to load/i.test(msg)) throw new Error('Could not download the neural voice from Hugging Face. Check your connection; it is needed only once.');
          throw err;
        }
      }
      tts = model; ttsKey = key;
      onProgress?.({ text: 'Ready', progress: 1 });
    })();
    loading = { key: `${device}:${dtype}`, promise };
    try { await promise; } finally { loading = null; }
  },

  async listVoices() { return KOKORO_VOICES.map((v) => ({ ...v })); },

  /** Render text to raw audio without playing it: { audio: Float32Array, sampling_rate }. */
  async render(text, voiceId) {
    if (!tts) await kokoro.init(kokoro._cfg);
    const voice = KOKORO_VOICES.some((v) => v.id === voiceId) ? voiceId : 'af_heart';
    const out = await tts.generate(String(text), { voice, speed: 0.95 });
    return { audio: out.audio, sampling_rate: out.sampling_rate };
  },

  /**
   * @param {string} text
   * @param {{voiceId?:string, rate?:number, pitch?:number, volume?:number, onStart?:()=>void, onEnd?:()=>void, onLevel?:(l:number)=>void, signal?:AbortSignal}} opts
   */
  async speak(text, opts = {}) {
    kokoro.stop();
    const phrases = splitPhrases(text);
    if (!phrases.length) return;
    if (!tts) await kokoro.init(kokoro._cfg);
    const c = audioCtx();
    if (c.state === 'suspended') { try { await c.resume(); } catch { /* needs a gesture */ } }

    const voice = KOKORO_VOICES.some((v) => v.id === opts.voiceId) ? opts.voiceId : 'af_heart';
    // Kokoro has a native speed option, which keeps pitch natural (unlike playbackRate).
    const speed = Math.min(1.5, Math.max(0.5, Number(opts.rate) || 1));
    gain.gain.value = Math.min(1, Math.max(0, opts.volume ?? 1));

    const ctrl = new AbortController(); const signal = ctrl.signal;
    const outer = opts.signal; const onOuter = () => ctrl.abort();
    if (outer?.aborted) return;
    outer?.addEventListener('abort', onOuter, { once: true });
    let source = null;
    const me = { cancel: () => { ctrl.abort(); try { source?.stop(); } catch { /* ignore */ } } };
    current = me;

    // Real mouth level from RMS of the playing audio.
    const buf = new Float32Array(analyser.fftSize);
    let playing = false;
    const levelTimer = opts.onLevel ? setInterval(() => {
      if (!playing) { opts.onLevel(0); return; }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      opts.onLevel(Math.min(1, rms * 5));
    }, 33) : null;

    const gen = (p) => tts.generate(p, { voice, speed });
    let started = false;
    try {
      let next = gen(phrases[0]);
      for (let i = 0; i < phrases.length && !signal.aborted; i++) {
        const audio = await next;
        // Generate the following phrase while this one plays.
        next = i + 1 < phrases.length ? gen(phrases[i + 1]) : null;
        next?.catch(() => {});
        if (signal.aborted) break;
        if (i > 0) await sleep(PHRASE_GAP_MS, signal);
        if (signal.aborted) break;
        const samples = audio.audio; const sr = audio.sampling_rate;
        const ab = c.createBuffer(1, samples.length, sr);
        ab.copyToChannel(samples, 0);
        await new Promise((resolve) => {
          source = c.createBufferSource();
          source.buffer = ab;
          source.connect(analyser);
          const fin = () => { playing = false; signal.removeEventListener('abort', fin); resolve(); };
          source.onended = fin;
          signal.addEventListener('abort', fin, { once: true });
          playing = true;
          if (!started) { started = true; opts.onStart?.(); }
          source.start();
        });
        source = null;
      }
    } finally {
      playing = false;
      if (levelTimer) { clearInterval(levelTimer); opts.onLevel?.(0); }
      outer?.removeEventListener?.('abort', onOuter);
      if (current === me) current = null;
      opts.onEnd?.();
    }
  },

  stop() {
    if (current) { const c = current; current = null; c.cancel(); }
  },

  async dispose() {
    kokoro.stop();
    try { await tts?.model?.dispose?.(); } catch { /* ignore */ }
    tts = null; ttsKey = '';
  },
};

registerTTSProvider(kokoro);
export default kokoro;
