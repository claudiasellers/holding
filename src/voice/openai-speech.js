// TTS from an OpenAI-compatible /v1/audio/speech endpoint on the user's own
// machine (the local-AI companion server, Kokoro-FastAPI, etc.). Never a paid API by default.
import { registerTTSProvider } from './providers.js';

let cfgSaved = { baseUrl: 'http://127.0.0.1:8787/v1', model: 'kokoro', token: '' };
let ctx = null, current = null;

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
  async listVoices() {
    return ['af_heart', 'af_nicole', 'af_sarah', 'am_michael', 'am_adam', 'bf_emma', 'bm_george'].map((id) => ({ id, label: id, gender: id[1] === 'f' ? 'f' : 'm' }));
  },
  async speak(text, opts = {}) {
    const c = cfgSaved;
    const phrases = String(text).split(/…|\.\.\./).map((p) => p.trim()).filter(Boolean);
    for (const p of phrases) {
      if (opts.signal?.aborted) return;
      const r = await fetch(`${c.baseUrl.replace(/\/$/, '')}/audio/speech`, {
        method: 'POST', signal: opts.signal,
        headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}`, 'X-Pair-Token': c.token } : {}) },
        body: JSON.stringify({ model: c.model, input: p, voice: opts.voiceId || opts.archetype?.voice?.kokoro || 'af_heart', speed: opts.rate ?? 1, response_format: 'wav' }),
      });
      if (!r.ok) throw new Error(`speech server ${r.status}`);
      const buf = await audioCtx().decodeAudioData(await r.arrayBuffer());
      await new Promise((resolve) => {
        const src = ctx.createBufferSource(); src.buffer = buf;
        const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an); an.connect(ctx.destination);
        const data = new Uint8Array(an.fftSize); current = src;
        const iv = setInterval(() => { an.getByteTimeDomainData(data); let s = 0; for (const v of data) s += ((v - 128) / 128) ** 2; opts.onLevel?.(Math.min(1, Math.sqrt(s / data.length) * 5)); }, 33);
        const fin = () => { clearInterval(iv); opts.onLevel?.(0); resolve(); };
        src.onended = fin; opts.signal?.addEventListener('abort', () => { try { src.stop(); } catch {} fin(); }, { once: true });
        src.start();
      });
      await new Promise((r2) => setTimeout(r2, 650));
    }
  },
  stop() { try { current?.stop(); } catch {} },
};
registerTTSProvider(provider);
export default provider;
