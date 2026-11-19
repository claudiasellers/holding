// In-browser LLM via WebLLM (MLC) on WebGPU. The model downloads once into the
// browser's Cache Storage and then runs fully on this device, offline.
// The library is loaded lazily from the CDN so it is not part of the app bundle.
//
// cfg: { model = DEFAULT_WEBLLM_MODEL }
import { registerLLMProvider } from './providers.js';

export const WEBLLM_VERSION = '0.2.87';
const WEBLLM_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`;
const LIB_TIMEOUT_MS = 30000;

/**
 * Recommended models, all verified present in prebuiltAppConfig.model_list of
 * web-llm 0.2.87. sizeMB is the approximate one-time download; vramMB is the
 * library's own vram_required_MB figure.
 */
export const WEBLLM_MODELS = Object.freeze([
  { id: 'auto', label: 'Automatic (best for this device)', sizeMB: 0, vramMB: 0, note: 'Desktop: Gemma 4 E2B. Phones: a smaller model chosen from what this GPU and storage allow, with automatic fallback if one ever fails.' },
  { id: 'gemma-4-E2B-it-q4f16_1-MLC', label: 'Gemma 4 E2B (desktop default)', sizeMB: 3387, vramMB: 3387, note: 'Best in-browser choice on a laptop or desktop GPU.' },
  { id: 'Qwen3.5-4B-q4f16_1-MLC', label: 'Qwen 3.5 4B (desktop)', sizeMB: 3868, vramMB: 3868, thinking: true, note: 'Strong desktop alternative; thinking is switched off.' },
  { id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC', label: 'Hermes 3 (Llama 3.2 3B)', sizeMB: 2264, vramMB: 2264, note: 'Good at staying in character; runs on many phones too.' },
  { id: 'Qwen3.5-2B-q4f16_1-MLC', label: 'Qwen 3.5 2B (Android / laptops)', sizeMB: 2245, vramMB: 2245, thinking: true, note: 'Default for phones whose GPU allows large buffers (most recent Android).' },
  { id: 'Qwen3.5-0.8B-q4f16_1-MLC', label: 'Qwen 3.5 0.8B (small phones)', sizeMB: 1629, vramMB: 1629, thinking: true, note: 'Smallest; leans on the scripted lines more.' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B', sizeMB: 1630, vramMB: 1630, note: 'Older but light and reliable.' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B', sizeMB: 879, vramMB: 879, note: 'Lowest memory use of all.' },
]);
export const DEFAULT_WEBLLM_MODEL = 'auto';
const DESKTOP_MODEL = 'gemma-4-E2B-it-q4f16_1-MLC';

// Optional phone helpers from the mobile layer (device probe, model ladder, prompt budgets).
let mobileMod;
async function mobile() {
  if (mobileMod !== undefined) return mobileMod;
  try {
    const mods = import.meta.glob ? { ...import.meta.glob('../mobile/webllm-mobile.js'), ...import.meta.glob('../mobile/device.js') } : {};
    const [w, d] = await Promise.all([mods['../mobile/webllm-mobile.js']?.(), mods['../mobile/device.js']?.()]);
    mobileMod = w && d ? { ...w, probeDevice: d.probeDevice } : null;
  } catch { mobileMod = null; }
  return mobileMod;
}
let probe = null, chosen = null;
async function resolveModel(cfg) {
  const want = cfg.model && cfg.model !== 'auto' ? cfg.model : null;
  const m = await mobile();
  if (m) {
    probe = probe || await m.probeDevice().catch(() => null);
    if (!want && probe && !probe.isMobile && probe.bigBuffers) return { id: DESKTOP_MODEL, thinking: false };
    const pick = m.pickWebLLMModel(probe, { size: cfg.size || 'auto', override: want || undefined });
    if (pick) return pick;
  }
  const id = want || DESKTOP_MODEL;
  return { id, thinking: /qwen3/i.test(id) };
}

let libPromise = null;
/** Lazily import the WebLLM ES module from the CDN. */
export function loadWebLLM() {
  if (!libPromise) {
    libPromise = Promise.race([
      import(/* @vite-ignore */ WEBLLM_URL),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out loading the in-browser AI library. Check your connection (needed only for the first download).')), LIB_TIMEOUT_MS)),
    ]).catch((err) => {
      libPromise = null;
      throw err instanceof Error && /Timed out/.test(err.message) ? err : new Error(`Could not load the in-browser AI library: ${err?.message || err}`);
    });
  }
  return libPromise;
}

/** Tests only: stand in for the CDN library. */
export function _setLibForTest(lib) { libPromise = lib ? Promise.resolve(lib) : null; }

let engine = null;
let engineModel = null;
let loading = null;
let lastProgress = { text: '', progress: 0 };

/** Last init progress report ({text, progress 0..1}); handy for re-rendering Settings. */
export function getInitProgress() { return { ...lastProgress }; }

/** True when the given model's weights are already in the browser cache. */
export async function isModelCached(modelId = DEFAULT_WEBLLM_MODEL) {
  try { const lib = await loadWebLLM(); return await lib.hasModelInCache(modelId); } catch { return false; }
}

/** Remove a downloaded model from the browser cache. */
export async function deleteModel(modelId) {
  const lib = await loadWebLLM();
  if (engineModel === modelId) await webllm.dispose();
  await lib.deleteModelAllInfoInCache(modelId);
}

// Everyone currently waiting on a load hears its progress (a session screen,
// Settings, or nobody for the background warm-up).
const listeners = new Set();
function report(p) {
  lastProgress = { text: p.text || '', progress: typeof p.progress === 'number' ? p.progress : 0 };
  for (const fn of listeners) { try { fn({ ...lastProgress }); } catch { /* a closed screen */ } }
}

function startLoad(model) {
  const promise = (async () => {
    const lib = await loadWebLLM();
    if (!lib.prebuiltAppConfig.model_list.some((m) => m.model_id === model)) {
      throw new Error(`"${model}" is not a WebLLM ${WEBLLM_VERSION} prebuilt model.`);
    }
    report({ text: 'Starting…', progress: 0 });
    if (engine) {
      engine.setInitProgressCallback?.(report);
      await engine.reload(model);
    } else {
      const m = await mobile();
      engine = await lib.CreateMLCEngine(model, { initProgressCallback: report }, m?.mobileChatOptions?.(probe) || undefined);
    }
    engineModel = model;
    report({ text: 'Ready', progress: 1 });
  })();
  loading = { model, promise };
  return (async () => {
    try { await promise; (await mobile())?.recordModelSuccess?.(model); } catch (err) {
      (await mobile())?.recordModelFailure?.(model, String(err?.message || err));
      const msg = String(err?.message || err);
      if (/quota|storage/i.test(msg)) throw new Error('Not enough storage space on this device for the model. Free some space or choose a smaller model.');
      if (/device.*lost|out of memory|OOM/i.test(msg)) throw new Error('The GPU ran out of memory loading the model. Choose a smaller model.');
      throw err;
    } finally { if (loading?.promise === promise) loading = null; }
  })();
}

/**
 * Start loading the model in the background as soon as the app opens, so it is
 * ready (or nearly) by the time someone taps Hold me. Only when the weights are
 * already downloaded: it never starts a 1-3 GB download on its own. Returns
 * what it did ('loaded' | 'skipped:<why>' | 'failed').
 */
export async function warmUp(cfg = {}) {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return 'skipped:no-webgpu';
    if (navigator.connection?.saveData) return 'skipped:save-data';
    const pick = await resolveModel(cfg);
    if (engine && engineModel === pick.id) return 'loaded';
    const lib = await loadWebLLM();
    if (!(await lib.hasModelInCache(pick.id))) return 'skipped:not-downloaded';
    await webllm.init(cfg);
    return 'loaded';
  } catch (err) {
    console.info('[holding] AI warm-up did not finish:', err?.message || err);
    return 'failed';
  }
}

const webllm = {
  id: 'webllm',
  label: 'On this device (in-browser AI, WebGPU)',
  local: true,

  async isAvailable(cfg = {}) {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return { ok: false, reason: 'This browser has no WebGPU. Try recent Chrome or Edge on desktop or Android, or Safari 26+ on iPhone/iPad/Mac.' };
    }
    try {
      const adapter = await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))]);
      if (!adapter) return { ok: false, reason: 'WebGPU is present but no GPU adapter is available (it may be disabled or blocklisted).' };
      const model = cfg.model || DEFAULT_WEBLLM_MODEL;
      const rec = WEBLLM_MODELS.find((m) => m.id === model && m.id !== 'auto');
      const maxBuf = adapter.limits?.maxStorageBufferBindingSize;
      // Small/mobile GPUs often expose 128 MB bindings; 3B models generally need more.
      if (rec && rec.vramMB > 2000 && maxBuf && maxBuf < 256 * 1024 * 1024) {
        return { ok: false, reason: `${rec.label} is too large for this GPU. Pick a 1B or smaller model.` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `WebGPU check failed: ${err?.message || err}` };
    }
  },

  /**
   * Load (downloading on first use) the chosen model. Safe to call repeatedly,
   * and from several places at once: the engine lives at module level for the
   * whole page, so a second session (or a session that starts while the app is
   * still warming up in the background) joins the load already in flight and
   * gets its progress too, instead of starting over.
   */
  async init(cfg = {}, onProgress) {
    chosen = await resolveModel(cfg);
    const model = chosen.id;
    if (engine && engineModel === model) { onProgress?.({ text: 'Ready', progress: 1 }); return; }
    if (onProgress) listeners.add(onProgress);
    try {
      if (loading && loading.model === model) {
        if (onProgress && lastProgress.text) onProgress({ ...lastProgress });
        return await loading.promise;
      }
      // A different model is wanted while another is still loading: let that
      // one finish first, so two loads never fight over the GPU.
      if (loading) await loading.promise.catch(() => {});
      if (engine && engineModel === model) { onProgress?.({ text: 'Ready', progress: 1 }); return; }
      return await startLoad(model);
    } finally {
      if (onProgress) listeners.delete(onProgress);
    }
  },

  /** True when this cfg's model is already in memory (no wait at all). */
  async isLoaded(cfg = {}) {
    if (!engine) return false;
    const want = await resolveModel(cfg).catch(() => null);
    return !!want && engineModel === want.id;
  },

  /** True while the model for this cfg is loading (e.g. the background warm-up). */
  async isLoading(cfg = {}) {
    if (!loading) return false;
    const want = await resolveModel(cfg).catch(() => null);
    return !!want && loading.model === want.id;
  },

  /**
   * @param {{system:string, messages:{role:string,content:string}[], maxTokens:number, temperature:number, signal?:AbortSignal}} req
   */
  async generate(req) {
    if (!engine) throw new Error('The in-browser model is not loaded yet.');
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const messages = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages || []) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') });
    // WebLLM requires the conversation to end on a user turn; Hold-me mode may
    // call with no user words, so add a gentle silent cue.
    if (!messages.length || messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: '(…)' });

    const m = await mobile();
    if (m && probe) {
      const budget = m.promptBudgetTokens(probe);
      const rest = m.fitToBudget(messages[0]?.role === 'system' ? messages[0].content : '', messages.filter((x) => x.role !== 'system'), budget);
      messages.splice(messages[0]?.role === 'system' ? 1 : 0, messages.length, ...rest);
    }
    let aborted = false;
    const onAbort = () => { aborted = true; engine?.interruptGenerate(); };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const out = await engine.chat.completions.create({
        messages,
        max_tokens: req.maxTokens ?? 160,
        temperature: req.temperature ?? 0.7,
        stream: false,
        ...(chosen?.thinking ? { extra_body: { enable_thinking: false } } : {}),
      });
      if (aborted) throw new DOMException('Aborted', 'AbortError');
      return String(out?.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
    } catch (err) {
      if (m?.isGpuLossError?.(err)) { m.recordModelFailure?.(engineModel, String(err?.message || err)); try { await webllm.dispose(); } catch {} }
      throw err;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  },

  async dispose() {
    const e = engine;
    engine = null; engineModel = null;
    if (e) { try { await e.unload(); } catch { /* ignore */ } }
  },
};

registerLLMProvider(webllm);
export default webllm;
