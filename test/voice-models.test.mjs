// Voice model manager helpers: cache accounting and deletion against a stand-in Cache Storage,
// the feeling dial, and the Chatterbox core's pure helpers. No downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_MODELS, cachedSize, deleteCached, keyBelongsTo, formatBytes, isExpressive, modelForProvider } from '../src/voice/models.js';
import { feelingFor, DEFAULT_FEELING } from '../src/voice/feeling.js';
import { tokenBudget, joinClips, trimSilence, resample, dtypesFor, CHATTERBOX_SR } from '../src/voice/chatterbox-core.js';

function fakeCaches(entries) {
  const store = new Map(entries.map(([url, size, header = true]) => [url, { size, header }]));
  const cache = {
    async keys() { return [...store.keys()].map((url) => ({ url })); },
    async match(req) {
      const e = store.get(req.url ?? req); if (!e) return undefined;
      return { headers: new Map(e.header ? [['content-length', String(e.size)]] : []), blob: async () => ({ size: e.size }) };
    },
    async delete(req) { return store.delete(req.url ?? req); },
  };
  return { store, api: { open: async (name) => { assert.equal(name, 'transformers-cache'); return cache; } } };
}

const HF = 'https://huggingface.co';
test('counts and deletes only the chosen model\'s files', async () => {
  const { store, api } = fakeCaches([
    [`${HF}/onnx-community/chatterbox-ONNX/resolve/main/onnx/language_model_q4f16.onnx_data`, 305e6],
    [`${HF}/onnx-community/chatterbox-ONNX/resolve/main/tokenizer.json`, 2e5, false],
    [`${HF}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx`, 92e6],
    [`${HF}/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/main/x.onnx`, 1e6],
  ]);
  globalThis.caches = api;
  try {
    assert.deepEqual(await cachedSize('chatterbox'), { files: 2, bytes: 305.2e6 });
    assert.deepEqual(await cachedSize('kokoro'), { files: 1, bytes: 92e6 });
    assert.equal(await deleteCached('chatterbox'), 305.2e6);
    assert.equal(store.size, 2);
    assert.deepEqual(await cachedSize('chatterbox'), { files: 0, bytes: 0 });
  } finally { delete globalThis.caches; }
});

test('no Cache Storage (private mode, Node) reports nothing instead of throwing', async () => {
  assert.deepEqual(await cachedSize('kokoro'), { files: 0, bytes: 0 });
  assert.equal(await deleteCached('kokoro'), 0);
});

test('helpers', () => {
  assert.ok(keyBelongsTo(`${HF}/a/b/resolve/main/c`, 'a/b'));
  assert.ok(!keyBelongsTo(`${HF}/a/bc/resolve/main/c`, 'a/b'));
  assert.equal(formatBytes(1.55e9), '1.6 GB');
  assert.equal(formatBytes(92e6), '92 MB');
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(modelForProvider('chatterbox').feeling, true);
  assert.deepEqual(VOICE_MODELS.map((m) => m.id), ['kokoro', 'chatterbox']);
  assert.ok(isExpressive({ id: 'chatterbox', expressive: true }));
  assert.ok(isExpressive({ id: 'openai-speech' }, { 'openai-speech': { model: 'chatterbox' } }));
  assert.ok(!isExpressive({ id: 'openai-speech' }, { 'openai-speech': { model: 'kokoro' } }));
  assert.ok(!isExpressive({ id: 'kokoro' }));
});

test('feeling dial: per figure, steadier at peak distress, clamped', () => {
  assert.equal(feelingFor({ voice: {} }), DEFAULT_FEELING);
  assert.equal(feelingFor({ voice: { feeling: 0.9 } }), 0.9);
  assert.ok(Math.abs(feelingFor({ voice: { feeling: 0.9 } }, 'bewith') - 0.72) < 1e-9);
  assert.equal(feelingFor({ voice: { feeling: 5 } }), 1);
  assert.equal(feelingFor({ voice: { feeling: 0.1 } }, 'bewith'), 0.25);
});

test('chatterbox core helpers', () => {
  assert.equal(tokenBudget('x'.repeat(2000)), 1000);
  assert.ok(tokenBudget('I am here.') >= 100);
  assert.deepEqual(dtypesFor('webgpu', { f16: true }).language_model, 'q4f16');
  assert.deepEqual(dtypesFor('cpu').language_model, 'q4');
  const a = new Float32Array(CHATTERBOX_SR * 6).fill(0.2);
  const joined = joinClips([a, a]);
  assert.equal(joined.length, CHATTERBOX_SR * 10);
  const padded = new Float32Array(CHATTERBOX_SR); padded.fill(0.5, 10000, 12000);
  const t = trimSilence(padded);
  assert.ok(t.length < 6000 && t.length >= 2000);
  assert.equal(resample(new Float32Array(48000), 48000).length, 24000);
});

test('peaks above full scale are scaled, not clipped', async () => {
  const { limitPeak } = await import('../src/voice/chatterbox-core.js');
  const a = Float32Array.from([0.1, -1.1, 0.5]);
  const b = limitPeak(a);
  assert.ok(Math.abs(Math.max(...b.map(Math.abs)) - 0.95) < 1e-6);
  const quiet = Float32Array.from([0.1, 0.2]);
  assert.equal(limitPeak(quiet), quiet);
});
