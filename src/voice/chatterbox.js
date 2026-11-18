// Chatterbox in the browser: an expressive neural voice with an emotion dial,
// on the graphics chip (WebGPU). About 1.5 GB, downloaded once into the
// browser's model cache; after that it speaks fully on this computer.
// Too big for phones: they use Holding Local's Chatterbox over Wi-Fi instead.
//
// Each parent keeps their own voice: Chatterbox copies the voice from a short
// reference clip. The clip comes from, in order:
//   1. the parent's pre-recorded lines (already in their Kokoro voice, no work),
//   2. a sentence rendered by Kokoro in the picked voice (if Kokoro is downloaded or can be),
//   3. Chatterbox's own built-in voice.
import { registerTTSProvider, getTTSProvider } from './providers.js';
import { KOKORO_VOICES } from './kokoro.js';
import { createChatterbox, CHATTERBOX_SR, DEFAULT_VOICE_URL, joinClips, resample } from './chatterbox-core.js';
import { canRun, keepDownloads } from './models.js';
import { DEFAULT_FEELING } from './feeling.js';

import { TRANSFORMERS_VERSION } from './chatterbox-version.js';

export { TRANSFORMERS_VERSION };
// The bundled build (no bare imports); ONNX Runtime's wasm/webgpu files come from jsDelivr too.
const LIB_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;
const LIB_TIMEOUT_MS = 45000;
const PHRASE_GAP_MS = 650;
export const BUILTIN_VOICE = 'chatterbox_default';
const REF_TEXT = 'I\'m right here with you. There\'s no hurry at all. Take whatever time you need, and I\'ll stay.';

let libPromise = null;
function loadLib() {
  if (!libPromise) {
    libPromise = Promise.race([
      import(/* @vite-ignore */ LIB_URL),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out loading the voice library. Check your connection (needed only for the first download).')), LIB_TIMEOUT_MS)),
    ]).catch((err) => { libPromise = null; throw err instanceof Error ? err : new Error(String(err)); });
  }
  return libPromise;
}

let engine = null; let loading = null;
let ctx = null; let analyser = null; let gain = null;
let current = null;
/** Seconds of audio per second of work on the last line (above 1 = faster than real time). */
export let lastSpeed = 0;

function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.3;
    gain = ctx.createGain();
    analyser.connect(gain).connect(ctx.destination);
  }
  return ctx;
}

async function decodeAt24k(arrayBuffer) {
  // decodeAudioData resamples to the context's rate.
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const buf = await new OAC(1, 1, CHATTERBOX_SR).decodeAudioData(arrayBuffer);
  const ch = buf.getChannelData(0);
  return buf.sampleRate === CHATTERBOX_SR ? new Float32Array(ch) : resample(ch, buf.sampleRate);
}

let indexPromise = null;
async function recordedClips(voiceId, archetypeId) {
  indexPromise ??= fetch('audio/index.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const index = await indexPromise;
  const pool = [];
  // Prefer this parent's own lines, then any lines in the same voice.
  for (const [arch, lines] of Object.entries(index || {})) {
    for (const e of Object.values(lines || {})) {
      if (e?.src && e.voice === voiceId) pool.push({ own: arch === archetypeId, ...e });
    }
  }
  pool.sort((a, b) => (b.own - a.own) || ((b.seconds || 0) - (a.seconds || 0)));
  const clips = []; let secs = 0;
  for (const e of pool.slice(0, 6)) {
    if (secs >= 9) break;
    try {
      const r = await fetch(e.src);
      if (!r.ok) continue;
      const a = await decodeAt24k(await r.arrayBuffer());
      clips.push(a); secs += a.length / CHATTERBOX_SR;
    } catch { /* skip */ }
  }
  return secs >= 4 ? joinClips(clips) : null;
}

async function referenceFor(voiceId, archetype) {
  if (voiceId && voiceId !== BUILTIN_VOICE && KOKORO_VOICES.some((v) => v.id === voiceId)) {
    const rec = await recordedClips(voiceId, archetype?.id).catch(() => null);
    if (rec) return rec;
    const kokoro = getTTSProvider('kokoro');
    if (kokoro?.render) {
      try {
        const out = await kokoro.render(REF_TEXT, voiceId);
        return resample(out.audio, out.sampling_rate);
      } catch (e) { console.info('[holding] Kokoro reference failed, using the built-in voice:', e?.message); }
    }
  }
  const r = await fetch(DEFAULT_VOICE_URL);
  if (!r.ok) throw new Error('Could not download Chatterbox\'s built-in voice.');
  return decodeAt24k(await r.arrayBuffer());
}

function splitPhrases(text) {
  return String(text || '').split(/\s*(?:…|\.\.\.)\s*/).map((p) => p.trim()).filter(Boolean);
}

const sleep = (ms, signal) => new Promise((r) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); r(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

const chatterbox = {
  id: 'chatterbox',
  label: 'Expressive voice on this computer (Chatterbox, ~1.5 GB)',
  local: true,
  expressive: true,
  _cfg: {},

  async isAvailable() {
    const r = await canRun('chatterbox');
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  },

  async init(cfg = {}, onProgress) {
    chatterbox._cfg = { ...cfg };
    if (engine?.loaded) { onProgress?.({ text: 'Ready', progress: 1 }); return; }
    if (loading) return loading;
    loading = (async () => {
      const can = await canRun('chatterbox');
      if (!can.ok) throw new Error(can.reason);
      onProgress?.({ text: 'Loading voice library…', progress: 0 });
      const lib = await loadLib();
      let f16 = false;
      try { const a = await navigator.gpu.requestAdapter(); f16 = !!a?.features?.has?.('shader-f16'); } catch { /* q4 then */ }
      keepDownloads();
      const files = new Map();
      const progress_callback = (p) => {
        if (p?.status === 'progress' && p.file) {
          files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
          let l = 0; let t = 0; for (const f of files.values()) { l += f.loaded; t += f.total; }
          onProgress?.({ text: `Downloading Chatterbox… ${Math.round(l / 1e6)} / ${Math.round(t / 1e6)} MB`, progress: Math.min(0.99, t ? l / t : 0) });
        } else if (p?.status === 'ready') onProgress?.({ text: 'Preparing the voice…', progress: 0.99 });
      };
      const e = createChatterbox(lib, { device: 'webgpu', f16 });
      try { await e.load(progress_callback); } catch (err) {
        const msg = String(err?.message || err);
        if (/quota|storage/i.test(msg)) throw new Error('Not enough free space for Chatterbox (about 1.5 GB). Delete another voice or free some space.');
        if (/fetch|network|Failed to load/i.test(msg)) throw new Error('Could not download Chatterbox from Hugging Face. Check your connection; it is needed only once.');
        throw err;
      }
      engine = e;
      onProgress?.({ text: 'Ready', progress: 1 });
    })();
    try { await loading; } finally { loading = null; }
  },

  // Chatterbox copies a voice, so its "voices" are the Kokoro voices it copies from.
  async listVoices() {
    return [{ id: BUILTIN_VOICE, label: 'Chatterbox\'s own voice', gender: 'f' }, ...KOKORO_VOICES.map((v) => ({ ...v }))];
  },

  /**
   * @param {string} text
   * @param {{voiceId?:string, feeling?:number, archetype?:object, volume?:number, onStart?:()=>void, onEnd?:()=>void, onLevel?:(l:number)=>void, signal?:AbortSignal}} opts
   */
  async speak(text, opts = {}) {
    chatterbox.stop();
    const phrases = splitPhrases(text);
    if (!phrases.length) return;
    if (!engine?.loaded) await chatterbox.init(chatterbox._cfg);
    const c = audioCtx();
    if (c.state === 'suspended') { try { await c.resume(); } catch { /* needs a gesture */ } }
    gain.gain.value = Math.min(1, Math.max(0, opts.volume ?? 1));
    const voiceId = opts.voiceId || opts.archetype?.voice?.kokoro || 'af_heart';
    const cond = await engine.voice(voiceId, () => referenceFor(voiceId, opts.archetype));
    const exaggeration = Number.isFinite(opts.feeling) ? opts.feeling : DEFAULT_FEELING;

    const ctrl = new AbortController(); const signal = ctrl.signal;
    const outer = opts.signal; const onOuter = () => ctrl.abort();
    if (outer?.aborted) return;
    outer?.addEventListener('abort', onOuter, { once: true });
    let source = null;
    const me = { cancel: () => { ctrl.abort(); try { source?.stop(); } catch { /* ignore */ } } };
    current = me;

    const buf = new Float32Array(analyser.fftSize);
    let playing = false;
    const levelTimer = opts.onLevel ? setInterval(() => {
      if (!playing) { opts.onLevel(0); return; }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      opts.onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5));
    }, 33) : null;

    const gen = async (p) => {
      const t0 = performance.now();
      const a = await engine.synthesize(p, cond, { exaggeration });
      lastSpeed = (a.length / CHATTERBOX_SR) / Math.max(0.001, (performance.now() - t0) / 1000);
      return a;
    };
    let started = false;
    try {
      let next = gen(phrases[0]);
      for (let i = 0; i < phrases.length && !signal.aborted; i++) {
        const samples = await next;
        next = i + 1 < phrases.length ? gen(phrases[i + 1]) : null;
        next?.catch(() => {});
        if (signal.aborted) break;
        if (i > 0) await sleep(PHRASE_GAP_MS, signal);
        if (signal.aborted) break;
        const ab = c.createBuffer(1, samples.length, CHATTERBOX_SR);
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

  stop() { if (current) { const c = current; current = null; c.cancel(); } },

  async dispose() {
    chatterbox.stop();
    await engine?.dispose();
    engine = null;
  },
};

registerTTSProvider(chatterbox);
export default chatterbox;
