// Companion skill server provider. The skill (skill/ in this repo) runs a small
// server on the user's own machine that adds retrieval (RAG) over the user's
// own notes and can serve a fine-tuned local model. Nothing leaves the machine.
//
// Contract (PLAN.md §10):
//   GET  /health -> { ok: true, models?: string[] }
//   POST /chat   { archetype, messages, use_rag, system, max_tokens, temperature }
//             -> { reply }  or OpenAI shape { choices: [{ message: { content } }] }
//
// cfg: { baseUrl = 'http://127.0.0.1:8765', useRag = true }
import { registerLLMProvider } from './providers.js';

export const DEFAULTS = Object.freeze({ baseUrl: 'http://127.0.0.1:8765', useRag: true });
const PROBE_TIMEOUT_MS = 2500;
const GENERATE_TIMEOUT_MS = 60000;

function resolve(cfg = {}) {
  return {
    baseUrl: String(cfg.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, ''),
    useRag: cfg.useRag !== false,
    timeoutMs: cfg.timeoutMs || GENERATE_TIMEOUT_MS,
  };
}

function withTimeout(ms, outer) {
  const ctrl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: ctrl.signal, timedOut: () => timedOut, done() { clearTimeout(t); outer?.removeEventListener?.('abort', onAbort); } };
}

function networkMessage(err, c, timedOut) {
  if (timedOut) return `The Holding companion server at ${c.baseUrl} did not answer in time.`;
  if (err && err.name === 'AbortError') return 'Cancelled.';
  return `Could not reach the Holding companion server at ${c.baseUrl}. Start it from the skill folder (see skill/README) and check the address. If it is running, its CORS setting must allow this page.`;
}

/** Pull reply text from either response shape. */
export function parseReply(j) {
  let text = j?.reply ?? j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? j?.message?.content ?? '';
  if (Array.isArray(text)) text = text.map((p) => p?.text || '').join('');
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

const holdingRag = {
  id: 'holding-rag',
  label: 'Holding companion server (your notes + your model)',
  local: true,
  _cfg: null,

  /** @returns {Promise<{ok:boolean, reason?:string, models?:string[]}>} */
  async isAvailable(cfg = {}) {
    const c = resolve(cfg);
    const to = withTimeout(PROBE_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${c.baseUrl}/health`, { method: 'GET', headers: { Accept: 'application/json', ...(c.token ? { 'X-Pair-Token': c.token } : {}) }, signal: to.signal });
    } catch (err) {
      return { ok: false, reason: networkMessage(err, c, to.timedOut()) };
    } finally { to.done(); }
    if (!res.ok) return { ok: false, reason: `The companion server answered ${res.status} on /health.` };
    let j;
    try { j = await res.json(); } catch { return { ok: false, reason: `${c.baseUrl}/health did not return JSON. Is this the Holding companion server?` }; }
    if (j && j.ok === false) return { ok: false, reason: j.reason || j.error || 'The companion server reports it is not ready (is its model loaded?).', models: j.models || [] };
    return { ok: true, models: Array.isArray(j?.models) ? j.models : [] };
  },

  async init(cfg = {}, onProgress) {
    holdingRag._cfg = { ...cfg };
    onProgress?.({ text: 'Connecting to the companion server…', progress: 0 });
    const r = await holdingRag.isAvailable(cfg);
    if (!r.ok) throw new Error(r.reason);
    onProgress?.({ text: 'Connected', progress: 1 });
  },

  /**
   * @param {{system:string, messages:{role:string,content:string}[], maxTokens:number, temperature:number, archetype:{id:string}, signal?:AbortSignal}} req
   * @param {object} [cfg] optional override; defaults to the cfg given to init()
   */
  async generate(req, cfg) {
    const c = resolve(cfg || holdingRag._cfg || {});
    const body = {
      archetype: req.archetype?.id || 'default',
      messages: (req.messages || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
      use_rag: c.useRag,
      system: req.system || '',
      max_tokens: req.maxTokens ?? 160,
      temperature: req.temperature ?? 0.7,
    };
    const to = withTimeout(c.timeoutMs, req.signal);
    let res;
    try {
      res = await fetch(`${c.baseUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(c.token ? { 'X-Pair-Token': c.token } : {}) },
        body: JSON.stringify(body),
        signal: to.signal,
      });
    } catch (err) {
      to.done();
      throw new Error(networkMessage(err, c, to.timedOut()));
    }
    try {
      if (!res.ok) {
        let d = '';
        try { const t = await res.text(); try { const j = JSON.parse(t); d = j.error || j.detail || j.message || t; } catch { d = t; } } catch { /* ignore */ }
        throw new Error(`Companion server error ${res.status}.${d ? ' ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300) : ''}`);
      }
      return parseReply(await res.json());
    } catch (err) {
      if (to.timedOut()) throw new Error('The companion server took too long to answer.');
      throw err;
    } finally { to.done(); }
  },
};

registerLLMProvider(holdingRag);
export default holdingRag;
