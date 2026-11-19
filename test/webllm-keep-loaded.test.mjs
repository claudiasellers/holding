// The in-browser model must load once per page and then serve every session:
// Hold me -> leave -> Just talk must not load it again, and a session that
// starts while the model is still loading (or warming up in the background)
// joins that load and sees its progress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, ctx, next) {
  if (url.endsWith('.json')) return next(url, { ...ctx, importAttributes: { type: 'json' } });
  return next(url, ctx);
}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOAD_MS = 400;

// A fake WebGPU and a fake WebLLM library that counts engine loads.
Object.defineProperty(globalThis, 'navigator', { value: { gpu: { requestAdapter: async () => ({ limits: {} }) } }, configurable: true });
const MODEL = 'gemma-4-E2B-it-q4f16_1-MLC';
const stats = { creates: 0, unloads: 0, cached: true };
const lib = {
  prebuiltAppConfig: { model_list: [{ model_id: MODEL }] },
  async hasModelInCache() { return stats.cached; },
  async CreateMLCEngine(model, { initProgressCallback }) {
    stats.creates++;
    for (let i = 1; i <= 4; i++) { await wait(LOAD_MS / 4); initProgressCallback({ text: `Loading ${i}/4`, progress: i / 4 }); }
    return {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: 'I am here with you.' } }] }) } },
      interruptGenerate() {}, async unload() { stats.unloads++; },
    };
  },
};

const webllmMod = await import('../src/ai/webllm.js');
webllmMod._setLibForTest(lib);
const webllm = webllmMod.default;
const { registerTTSProvider } = await import('../src/voice/providers.js');
const { createSession } = await import('../src/engine/dialogue.js');
const { PRESETS } = await import('../src/data/archetypes.js');
const { store } = await import('../src/store.js');

registerTTSProvider({ id: 'webspeech', label: 'fake', local: true, async isAvailable() { return { ok: true }; }, async listVoices() { return []; }, async speak() {}, stop() {} });
const presence = { setOwn() {}, setSpeaking() {}, mirror() {} };

function newSession(mode) {
  store.settings.voiceOn = false;
  store.settings.ai = { ...store.settings.ai, provider: 'webllm', webllm: { model: MODEL } };
  const seen = { states: [], progress: [] };
  const ui = { onBrain: (b) => seen.states.push(b.state), onModelProgress: (p) => seen.progress.push(p.progress) };
  const s = createSession({ archetype: PRESETS[0], presence, ui, mode });
  return { s, seen };
}
async function until(fn, ms = 3000) { for (let t = 0; t < ms && !fn(); t += 20) await wait(20); return fn(); }

test('leaving mid-load and starting Just talk joins the same load, with progress', async () => {
  const a = newSession('hold');
  a.s.start();
  await wait(LOAD_MS / 3);              // still loading
  a.s.destroy();                         // Exit
  const b = newSession('talk');          // Just talk
  b.s.start();
  assert.ok(await until(() => b.seen.states.at(-1) === 'ready'), `second session became ready (states ${b.seen.states})`);
  assert.equal(stats.creates, 1, 'model loaded once');
  assert.ok(b.seen.progress.some((p) => p > 0 && p < 1), `second session saw real progress, got ${b.seen.progress}`);
  b.s.destroy();
});

test('a later session finds the model already in memory', async () => {
  const c = newSession('hold');
  const t0 = Date.now();
  c.s.start();
  assert.ok(await until(() => c.seen.states.at(-1) === 'ready'));
  assert.ok(Date.now() - t0 < LOAD_MS / 2, 'ready without a load');
  assert.equal(stats.creates, 1, 'still one load');
  assert.equal(stats.unloads, 0, 'never unloaded between sessions');
  c.s.destroy();
});

test('warm-up loads only weights that are already downloaded', async () => {
  await webllm.dispose();
  stats.cached = false;
  assert.equal(await webllmMod.warmUp({ model: MODEL }), 'skipped:not-downloaded');
  assert.equal(stats.creates, 1);
  stats.cached = true;
  const warming = webllmMod.warmUp({ model: MODEL });
  await wait(LOAD_MS / 3);
  const d = newSession('hold');          // Hold me tapped while warming
  d.s.start();
  assert.equal(await warming, 'loaded');
  assert.ok(await until(() => d.seen.states.at(-1) === 'ready'));
  assert.equal(stats.creates, 2, 'session joined the warm-up instead of loading again');
  d.s.destroy();
});
