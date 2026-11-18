// Voice models that run inside this browser: what each one is, whether it is
// downloaded, how much space it takes, and how to delete it.
//
// Both engines load their weights through Transformers.js, which keeps every
// file it downloads in Cache Storage under 'transformers-cache', keyed by the
// file's Hugging Face URL (https://huggingface.co/<repo>/resolve/<rev>/<file>).
// So "downloaded" means "that cache has files for this repo", and deleting a
// model means removing those entries. The service worker never copies them.

export const MODEL_CACHE = 'transformers-cache';

/**
 * In-browser voice models, smallest first.
 * sizeMB is the download for the build this app asks for (see each engine).
 * feeling: the model has an emotion dial.
 */
export const VOICE_MODELS = Object.freeze([
  {
    id: 'kokoro',
    provider: 'kokoro',
    name: 'Kokoro',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    sizeMB: 92,
    sizeNote: '92 MB (326 MB on computers with a graphics chip)',
    feeling: false,
    blurb: 'Clear and steady. Fast on any device, phones included.',
    needs: 'any',
  },
  {
    id: 'chatterbox',
    provider: 'chatterbox',
    name: 'Chatterbox',
    repo: 'onnx-community/chatterbox-ONNX',
    sizeMB: 1500,
    sizeNote: 'about 1.5 GB',
    feeling: true,
    blurb: 'Warm and expressive, with a feeling dial. It copies each parent\'s own voice, so they keep sounding like themselves. Slower: a line can take a few seconds to start.',
    needs: 'webgpu',
  },
  {
    id: 'chatterbox-turbo',
    provider: 'chatterbox-turbo',
    name: 'Chatterbox Turbo',
    repo: 'ResembleAI/chatterbox-turbo-ONNX',
    sizeMB: 960,
    sizeNote: 'about 960 MB',
    feeling: false,
    blurb: 'Chatterbox\'s faster sibling. Keeps each parent\'s own voice and understands [sigh] and [chuckle], but has no feeling dial. About twice as fast.',
    needs: 'webgpu',
  },
]);

/**
 * Voice models on Holding Local that take the feeling dial (see local/holding_local/voice_models.py).
 * The rest of its non-Kokoro models are still expressive, just without a dial.
 */
export const SERVER_FEELING_MODELS = Object.freeze(['chatterbox', 'chatterbox-mac', 'qwen3-tts', 'qwen3-tts-small']);

export function modelById(id) { return VOICE_MODELS.find((m) => m.id === id) || null; }
export function modelForProvider(providerId) { return VOICE_MODELS.find((m) => m.provider === providerId) || null; }

const hasCaches = () => typeof caches !== 'undefined' && typeof caches.open === 'function';

/** True if a cache key (a URL) belongs to this repo. */
export function keyBelongsTo(url, repo) {
  const u = String(url);
  return u.includes(`/${repo}/resolve/`) || u.includes(`/${repo}/`);
}

async function sizeOf(res) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > 0) return len;
  try { return (await res.blob()).size; } catch { return 0; }
}

/** { files, bytes } this browser holds for a model. */
export async function cachedSize(model) {
  const m = typeof model === 'string' ? modelById(model) : model;
  if (!m || !hasCaches()) return { files: 0, bytes: 0 };
  let files = 0; let bytes = 0;
  try {
    const cache = await caches.open(MODEL_CACHE);
    for (const req of await cache.keys()) {
      if (!keyBelongsTo(req.url, m.repo)) continue;
      const res = await cache.match(req);
      if (!res) continue;
      files++; bytes += await sizeOf(res);
    }
  } catch { /* storage blocked (private mode): report nothing */ }
  return { files, bytes };
}

/** Remove every cached file of a model. Returns the bytes freed. */
export async function deleteCached(model) {
  const m = typeof model === 'string' ? modelById(model) : model;
  if (!m || !hasCaches()) return 0;
  let freed = 0;
  const cache = await caches.open(MODEL_CACHE);
  for (const req of await cache.keys()) {
    if (!keyBelongsTo(req.url, m.repo)) continue;
    const res = await cache.match(req);
    if (res) freed += await sizeOf(res);
    await cache.delete(req);
  }
  return freed;
}

/** What the browser says about this site's storage: { usage, quota } in bytes, or null. */
export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.() || null; } catch { return null; }
}

/** Ask the browser not to clear downloaded voices when space runs low. Best effort. */
export async function keepDownloads() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}

export function formatBytes(n) {
  if (!n) return '0 MB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

/** Can this device run the model at all? { ok, reason } */
export async function canRun(model) {
  const m = typeof model === 'string' ? modelById(model) : model;
  if (!m) return { ok: false, reason: 'Unknown voice model.' };
  if (m.needs !== 'webgpu') return { ok: true };
  const mobile = typeof navigator !== 'undefined' && /iPhone|iPad|Android/i.test(navigator.userAgent || '');
  if (mobile) return { ok: false, reason: `Too big for a phone. On your phone, connect to Holding Local on your computer and pick ${m.name} there.` };
  const mem = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  if (mem && mem < 8) return { ok: false, reason: 'Needs a computer with at least 8 GB of memory.' };
  try {
    if (!navigator.gpu) return { ok: false, reason: 'Needs WebGPU, which this browser does not have. Recent Chrome, Edge or Safari 26 on a computer have it, or use Holding Local.' };
    const a = await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 2500))]);
    if (!a) return { ok: false, reason: 'This browser has WebGPU but no graphics chip it can use. Try Holding Local instead.' };
  } catch { return { ok: false, reason: 'WebGPU did not start in this browser. Try Holding Local instead.' }; }
  return { ok: true };
}

const serverModel = (ttsSettings) => ttsSettings?.['openai-speech']?.model || '';

/** Does this engine (as configured) put feeling into lines? Used to prefer it over flat recordings. */
export function isExpressive(provider, ttsSettings = {}) {
  if (!provider) return false;
  if (provider.expressive) return true;
  const m = serverModel(ttsSettings);
  return provider.id === 'openai-speech' && !!m && m !== 'kokoro';
}

/** Does this engine (as configured) have a feeling dial? */
export function hasFeelingDial(provider, ttsSettings = {}) {
  if (!provider) return false;
  if (provider.id === 'openai-speech') return SERVER_FEELING_MODELS.includes(serverModel(ttsSettings));
  return !!(provider.expressive && provider.feeling);
}
