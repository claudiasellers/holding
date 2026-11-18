// Chatterbox Turbo in the browser: the faster Chatterbox, on the graphics chip
// (WebGPU) through ONNX Runtime Web. About 960 MB, downloaded once into the same
// model cache the other voices use ('transformers-cache', keyed by the file's
// Hugging Face URL), so Settings can measure and delete it like the others.
// No feeling dial; it keeps each parent's own voice and reads [sigh] and [chuckle].
import { createTurbo, TURBO_GRAPHS, TURBO_REPO, turboUrl } from './chatterbox-turbo-core.js';
import { makeVoiceCopyProvider, loadFromCdn, loadTransformers } from './expressive-provider.js';
import { MODEL_CACHE } from './models.js';

export const ORT_WEB_VERSION = '1.31.1';
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/ort.webgpu.bundle.min.mjs`;

/** A file from the model cache, or downloaded into it with progress. */
async function cachedBytes(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch { /* private mode: no cache */ }
  const hit = await cache?.match(url);
  if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); onProgress(b.length, b.length); return b; }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url.split('/').pop()} (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const reader = r.body.getReader();
  const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; onProgress(got, total || got);
  }
  const bytes = new Uint8Array(got); let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(got) } }));
  return bytes;
}

const turbo = makeVoiceCopyProvider({
  id: 'chatterbox-turbo',
  label: 'Faster expressive voice on this computer (Chatterbox Turbo, ~960 MB)',
  name: 'Chatterbox Turbo',
  sizeText: 'about 960 MB',
  feeling: false,
  async createEngine(onFile, onPreparing) {
    const [ort, lib] = await Promise.all([loadFromCdn(ORT_URL, 'ONNX Runtime'), loadTransformers()]);
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/`;
    const tok = await lib.AutoTokenizer.from_pretrained(TURBO_REPO);
    const tokenizer = { encode: (t) => tok.encode(t) };
    const e = createTurbo({
      ort, tokenizer,
      async createSession(key) {
        const file = TURBO_GRAPHS[key];
        const [graph, data] = await Promise.all([
          cachedBytes(turboUrl(`onnx/${file}`), (l, t) => onFile(file, l, t)),
          cachedBytes(turboUrl(`onnx/${file}_data`), (l, t) => onFile(`${file}_data`, l, t)),
        ]);
        if (key === 'conditional_decoder') onPreparing();
        return ort.InferenceSession.create(graph, {
          executionProviders: ['webgpu', 'wasm'],
          externalData: [{ path: `${file}_data`, data }],
          // Keep the language model's memory on the graphics chip between steps.
          ...(key === 'language_model' ? { preferredOutputLocation: 'gpu-buffer' } : {}),
        });
      },
    });
    await e.load();
    return e;
  },
});

export default turbo;
