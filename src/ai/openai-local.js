// OpenAI-compatible local server provider: Ollama, LM Studio, llama.cpp server,
// vLLM, Jan, or anything else that speaks POST /v1/chat/completions on the user's
// own machine. Nothing here talks to a hosted service unless the user types its URL.
//
// cfg: { baseUrl = 'http://localhost:11434/v1', model = 'llama3.2:3b', apiKey = '' }
//
// Common base URLs:
//   Ollama      http://localhost:11434/v1   (needs OLLAMA_ORIGINS=* for browser access)
//   LM Studio   http://localhost:1234/v1    (enable CORS in the server tab)
//   llama.cpp   http://localhost:8080/v1    (llama-server, CORS on by default)
import { registerLLMProvider } from './providers.js';

export const DEFAULTS = Object.freeze({ baseUrl: 'http://localhost:11434/v1', model: 'gemma4:e4b', apiKey: '' });
const PROBE_TIMEOUT_MS = 2500;
const GENERATE_TIMEOUT_MS = 60000;

/** @param {object} [cfg] */
function resolve(cfg = {}) {
  const baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  return { baseUrl, model: String(cfg.model || DEFAULTS.model).trim(), apiKey: String(cfg.apiKey || '').trim() };
}

function headers(c, json) {
  const h = { Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  if (c.token) h['X-Pair-Token'] = c.token;
  if (c.apiKey) h.Authorization = `Bearer ${c.apiKey}`;
  return h;
}

/** Combine an optional caller signal with a timeout. Returns {signal, done, timedOut()} */
function withTimeout(ms, outer) {
  const ctrl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    done() { clearTimeout(t); outer?.removeEventListener?.('abort', onAbort); },
  };
}

function isOllama(baseUrl) { return /:11434(\/|$)/.test(baseUrl); }

/** Turn a fetch failure into a message a person can act on. */
function explainNetworkError(err, c, timedOut) {
  if (timedOut) return `No answer from ${c.baseUrl} in time. Is the server running?`;
  if (err && err.name === 'AbortError') return 'Cancelled.';
  const pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:';
  const target = /^http:/i.test(c.baseUrl) && !/\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(c.baseUrl);
  if (pageIsHttps && target) {
    return `This page is served over https, so the browser blocks plain-http addresses like ${c.baseUrl}. Use localhost on the same computer, or open the app over http on your network.`;
  }
  // Browsers report CORS rejections and refused connections as the same TypeError.
  const cors = isOllama(c.baseUrl)
    ? 'If Ollama is running, allow browser access: set OLLAMA_ORIGINS=* (for example `OLLAMA_ORIGINS=* ollama serve`, or `launchctl setenv OLLAMA_ORIGINS "*"` on macOS) and restart Ollama.'
    : 'If the server is running, turn on CORS for it (LM Studio: Server settings, "Enable CORS"; llama.cpp server allows it by default).';
  return `Could not reach ${c.baseUrl}. Check the server is running and the address is right. ${cors}`;
}

async function readError(res) {
  let detail = '';
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); detail = j?.error?.message || j?.error || j?.message || t; } catch { detail = t; }
  } catch { /* ignore */ }
  detail = String(detail || '').slice(0, 300);
  return detail;
}

/**
 * List models the server offers (GET {baseUrl}/models).
 * @param {object} [cfg]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function listModels(cfg = {}, signal) {
  const c = resolve(cfg);
  const to = withTimeout(PROBE_TIMEOUT_MS, signal);
  let res;
  try {
    res = await fetch(`${c.baseUrl}/models`, { method: 'GET', headers: headers(c, false), signal: to.signal });
  } catch (err) {
    throw new Error(explainNetworkError(err, c, to.timedOut()));
  } finally { to.done(); }
  if (!res.ok) {
    const d = await readError(res);
    if (res.status === 401 || res.status === 403) throw new Error(`The server at ${c.baseUrl} refused the request (${res.status}). Check the API key field.${d ? ' ' + d : ''}`);
    throw new Error(`The server at ${c.baseUrl} answered ${res.status} for /models.${d ? ' ' + d : ''}`);
  }
  let body;
  try { body = await res.json(); } catch { throw new Error(`The server at ${c.baseUrl} did not return JSON for /models. Is this an OpenAI-compatible address (often ending in /v1)?`); }
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return list.map((m) => (typeof m === 'string' ? m : m?.id || m?.name || m?.model)).filter(Boolean);
}

function hasModel(models, want) {
  const base = (m) => m.replace(/:latest$/, '');
  return models.some((m) => m === want || base(m) === base(want) || (!want.includes(':') && m.split(':')[0] === want));
}

const openaiLocal = {
  _cfg: null,
  id: 'openai-local',
  label: 'Your computer (Ollama, LM Studio, llama.cpp)',
  local: true,

  /** @returns {Promise<{ok:boolean, reason?:string, models?:string[]}>} */
  async isAvailable(cfg = {}) {
    const c = resolve(cfg);
    try {
      const models = await listModels(c);
      if (models.length && c.model && !hasModel(models, c.model)) {
        return {
          ok: false, models,
          reason: `Connected, but the model "${c.model}" is not on this server. Available: ${models.slice(0, 8).join(', ')}${models.length > 8 ? '…' : ''}.${isOllama(c.baseUrl) ? ` Run \`ollama pull ${c.model}\` to get it.` : ''}`,
        };
      }
      return { ok: true, models };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  },

  /** Remember cfg for generate(); the contract passes cfg to init, not to generate. */
  async init(cfg = {}, onProgress) {
    openaiLocal._cfg = { ...cfg };
    onProgress?.({ text: 'Connecting to your local server…', progress: 0 });
    const r = await this.isAvailable(cfg);
    if (!r.ok) throw new Error(r.reason);
    onProgress?.({ text: 'Connected', progress: 1 });
  },

  /**
   * @param {{system:string, messages:{role:string,content:string}[], maxTokens:number, temperature:number, signal?:AbortSignal}} req
   * @param {object} [cfg] optional override; defaults to the cfg given to init()
   */
  async generate(req, cfg) {
    cfg = cfg || openaiLocal._cfg || {};
    const c = resolve(cfg);
    const messages = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages || []) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') });
    const want = req.maxTokens ?? 160;
    const key = `${c.baseUrl}|${c.model}`;
    const to = withTimeout(cfg.timeoutMs || GENERATE_TIMEOUT_MS, req.signal);
    const ask = async (maxTokens) => {
      const body = {
        model: c.model,
        messages,
        max_tokens: maxTokens,
        temperature: req.temperature ?? 0.7,
        stream: false,
        // Thinking models (Gemma 4, Qwen 3.5) otherwise reason first, and the
        // hidden reasoning counts against max_tokens. Holding Local honours this;
        // servers that don't know the field ignore it.
        think: false,
      };
      let res;
      try {
        res = await fetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers: headers(c, true), body: JSON.stringify(body), signal: to.signal });
      } catch (err) {
        throw new Error(explainNetworkError(err, c, to.timedOut()));
      }
      if (!res.ok) {
        const d = await readError(res);
        if (res.status === 404) throw new Error(`Model "${c.model}" was not found on ${c.baseUrl}.${isOllama(c.baseUrl) ? ` Try \`ollama pull ${c.model}\`.` : ''}${d ? ' ' + d : ''}`);
        throw new Error(`Local server error ${res.status}.${d ? ' ' + d : ''}`);
      }
      const j = await res.json();
      return { text: parseReply(j), cut: finishReason(j) === 'length' };
    };
    try {
      // A server that still lets the model think spends a short budget on the
      // thinking and returns nothing. Ask again with room for it, and remember.
      let r = await ask(ROOMY.has(key) ? Math.max(want, ROOMY_TOKENS) : want);
      if (!r.text && r.cut && !ROOMY.has(key)) {
        ROOMY.add(key);
        console.info(`[holding] ${c.model} used its whole reply budget thinking; asking again with room to think`);
        r = await ask(Math.max(want, ROOMY_TOKENS));
      }
      if (!r.text) throw new Error(r.cut ? `The model on ${c.baseUrl} used its whole reply on thinking and said nothing.` : `The model on ${c.baseUrl} sent an empty reply.`);
      const out = r.cut ? wholeSentences(r.text) : r.text;
      if (!out) throw new Error(`The model on ${c.baseUrl} was cut off before it finished a sentence.`);
      return out;
    } catch (err) {
      if (to.timedOut()) throw new Error(`The model on ${c.baseUrl} took too long to answer.`);
      throw err;
    } finally { to.done(); }
  },
};

// Servers whose model thinks no matter what (an older Holding Local, plain
// Ollama /v1): ask for this much so the reply survives the thinking.
const ROOMY_TOKENS = 1024;
const ROOMY = new Set();
export function _resetRoomy() { ROOMY.clear(); }

function finishReason(j) { return j?.choices?.[0]?.finish_reason || (j?.done_reason === 'length' ? 'length' : ''); }

/** A reply cut off by max_tokens: keep the whole sentences, drop the dangling end. */
export function wholeSentences(t) {
  const m = String(t).match(/^[\s\S]*[.!?…]["”')\]]*(?=\s|$)/);
  return (m ? m[0] : '').trim();
}

/** Extract text from an OpenAI chat completion (or Ollama native) response. */
export function parseReply(j) {
  const msg = j?.choices?.[0]?.message;
  let text = msg?.content ?? j?.choices?.[0]?.text ?? j?.message?.content ?? j?.reply ?? '';
  if (Array.isArray(text)) text = text.map((p) => p?.text || '').join('');
  // Strip reasoning blocks some local models emit.
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

registerLLMProvider(openaiLocal);
export default openaiLocal;
