// TTS from an OpenAI-compatible /v1/audio/speech endpoint on the user's own
// machine (the local-AI companion server, Kokoro-FastAPI, etc.). Never a paid API by default.
import { registerTTSProvider } from './providers.js';
import { KOKORO_VOICES } from './kokoro.js';

let cfgSaved = { baseUrl: 'http://127.0.0.1:8787/v1', model: 'kokoro', token: '' };
let ctx = null, current = null, stopped = false, speakGen = 0;

function audioCtx() { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); return ctx; }

const provider = {
  id: 'openai-speech', label: 'Voice from my computer (local server)', local: true,
  async isAvailable(cfg = {}) {
    const c = { ...cfgSaved, ...cfg };
    try {
      const r = await fetch(`${c.baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(2500), headers: c.token ? { Authorization: `Bearer ${c.token}`, 'X-Pair-Token': c.token } : {} });
      return { ok: r.ok, reason: r.ok ? '' : `server answered ${r.status}` };
    } catch (e) { return { ok: false, reason: `Can't reach ${c.baseUrl}. Is the local server running?` }; }
  },
  async init(cfg = {}) { cfgSaved = { ...cfgSaved, ...cfg }; },
  // The Holding Local server runs the same Kokoro voices; ask it which it has,
  // and fall back to the standard English set.
  async listVoices(cfg = {}) {
    const c = { ...cfgSaved, ...cfg };
    let names = null;
    try {
      const r = await fetch(`${c.baseUrl.replace(/\/$/, '')}/voices`, { signal: AbortSignal.timeout(2500), headers: c.token ? { Authorization: `Bearer ${c.token}`, 'X-Pair-Token': c.token } : {} });
      if (r.ok) { const j = await r.json(); names = (Array.isArray(j) ? j : j.voices || []).map((v) => (typeof v === 'string' ? v : v?.id || v?.name)).filter(Boolean); }
    } catch { /* server older or offline */ }
    const known = KOKORO_VOICES.map((v) => ({ ...v }));
    if (!names?.length) return known;
    const set = new Set(names);
    const list = known.filter((v) => set.has(v.id));
    for (const n of names) if (/^[ab][fm]_/.test(n) && !list.some((v) => v.id === n)) list.push({ id: n, label: n, gender: n[1] === 'f' ? 'f' : 'm' });
    return list.length ? list : known;
  },
  async speak(text, opts = {}) {
    provider.stop();
    const gen = ++speakGen;
    stopped = false;
    const c = cfgSaved;
    const phrases = String(text).split(/…|\.\.\./).map((p) => p.trim()).filter(Boolean);
    const base = c.baseUrl.replace(/\/$/, '');
    const headers = { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}`, 'X-Pair-Token': c.token } : {}) };
    // "exaggeration" is a Holding Local extension (Chatterbox's feeling dial); other servers ignore it.
    const fetchAudio = async (p) => {
      const r = await fetch(`${base}/audio/speech`, {
        method: 'POST', signal: opts.signal, headers,
        body: JSON.stringify({ model: c.model || 'kokoro', input: p, voice: opts.voiceId || opts.archetype?.voice?.kokoro || 'af_heart', speed: opts.rate ?? 1, response_format: 'wav', ...(Number.isFinite(opts.feeling) ? { exaggeration: opts.feeling } : {}) }),
      });
      if (!r.ok) throw new Error(`speech server ${r.status}`);
      return audioCtx().decodeAudioData(await r.arrayBuffer());
    };
    // Ask for the next phrase while this one plays: slower voices then flow without gaps.
    let next = phrases.length ? fetchAudio(phrases[0]) : null;
    for (let i = 0; i < phrases.length; i++) {
      if (opts.signal?.aborted || stopped || gen !== speakGen) return;
      const buf = await next;
      // Stopped while the audio was downloading or decoding: an abort listener
      // added after this point would never fire, so the phrase would play in full.
      if (opts.signal?.aborted || stopped || gen !== speakGen) return;
      next = i + 1 < phrases.length ? fetchAudio(phrases[i + 1]) : null;
      next?.catch(() => {});
      if (i > 0) await new Promise((r2) => { const t = setTimeout(r2, 650); opts.signal?.addEventListener('abort', () => { clearTimeout(t); r2(); }, { once: true }); });
      if (opts.signal?.aborted || stopped || gen !== speakGen) return;
      await new Promise((resolve) => {
        const src = ctx.createBufferSource(); src.buffer = buf;
        const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an); an.connect(ctx.destination);
        const data = new Uint8Array(an.fftSize); current = src;
        const iv = setInterval(() => { an.getByteTimeDomainData(data); let s = 0; for (const v of data) s += ((v - 128) / 128) ** 2; opts.onLevel?.(Math.min(1, Math.sqrt(s / data.length) * 5)); }, 33);
        const fin = () => { clearInterval(iv); opts.onLevel?.(0); resolve(); };
        src.onended = fin; opts.signal?.addEventListener('abort', () => { try { src.stop(); } catch {} fin(); }, { once: true });
        src.start();
      });
      if (opts.signal?.aborted || stopped || gen !== speakGen) return;
    }
  },
  // Stops the phrase playing now and every phrase after it in the same line.
  stop() { stopped = true; try { current?.stop(); } catch {} current = null; },
};
registerTTSProvider(provider);
export default provider;
