// Voice model manager helpers: cache accounting and deletion against a stand-in Cache Storage,
// the feeling dial, and the Chatterbox core's pure helpers. No downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_MODELS, cachedSize, deleteCached, keyBelongsTo, formatBytes, isExpressive, hasFeelingDial, modelForProvider } from '../src/voice/models.js';
import { createTurbo, pickNext, STOP_SPEECH_TOKEN, START_SPEECH_TOKEN, SILENCE_TOKEN, TURBO_FILES } from '../src/voice/chatterbox-turbo-core.js';
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
  assert.ok(isExpressive({ id: 'chatterbox', expressive: true }));
  assert.ok(isExpressive({ id: 'openai-speech' }, { 'openai-speech': { model: 'chatterbox' } }));
  assert.ok(!isExpressive({ id: 'openai-speech' }, { 'openai-speech': { model: 'kokoro' } }));
  assert.ok(!isExpressive({ id: 'kokoro' }));
  assert.ok(isExpressive({ id: 'openai-speech' }, { 'openai-speech': { model: 'orpheus' } }));
  assert.ok(hasFeelingDial({ id: 'openai-speech' }, { 'openai-speech': { model: 'qwen3-tts' } }));
  assert.ok(!hasFeelingDial({ id: 'openai-speech' }, { 'openai-speech': { model: 'chatterbox-turbo' } }));
  assert.ok(hasFeelingDial({ id: 'chatterbox', expressive: true, feeling: true }));
  assert.ok(!hasFeelingDial({ id: 'chatterbox-turbo', expressive: true, feeling: false }));
  assert.deepEqual(VOICE_MODELS.map((m) => m.id), ['kokoro', 'chatterbox', 'chatterbox-turbo']);
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

test('turbo: repetition penalty then greedy pick', () => {
  const l = Float32Array.from([1, 2.2, 2, -1]);
  assert.equal(pickNext(Float32Array.from(l), new Set()), 1);
  assert.equal(pickNext(Float32Array.from(l), new Set([1])), 2); // 2.2 / 1.2 < 2
  assert.ok(TURBO_FILES.includes('onnx/language_model_q4.onnx_data'));
});

test('turbo loop: positions, cache, silence padding (stand-in sessions)', async () => {
  class T { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  const ort = { Tensor: T };
  const script = [100, 200];
  const seen = { lm: [], dec: null };
  const vocab = 6563;
  const layers = 2;
  const pastNames = Array.from({ length: layers }, (_, i) => [`past_key_values.${i}.key`, `past_key_values.${i}.value`]).flat();
  const sess = (inputNames, outputNames, fn) => ({ inputNames, outputNames, run: async (f) => fn(f) });
  const createSession = async (k) => ({
    speech_encoder: sess(['audio_values'], ['cond_emb', 'prompt_token', 'speaker_embeddings', 'speaker_features'], () => ({
      cond_emb: new T('float32', new Float32Array(3 * 4), [1, 3, 4]), prompt_token: new T('int64', BigInt64Array.from([7n, 8n]), [1, 2]),
      speaker_embeddings: new T('float32', new Float32Array(2), [1, 2]), speaker_features: new T('float32', new Float32Array(2), [1, 1, 2]),
    })),
    embed_tokens: sess(['input_ids'], ['inputs_embeds'], (f) => ({ inputs_embeds: new T('float32', new Float32Array(f.input_ids.dims[1] * 4), [1, f.input_ids.dims[1], 4]) })),
    language_model: sess(['inputs_embeds', 'attention_mask', 'position_ids', ...pastNames], ['logits', ...pastNames.map((n) => n.replace('past_key_values', 'present'))], (f) => {
      const step = seen.lm.length;
      const n = f.attention_mask.dims[1];
      seen.lm.push({ pos: Array.from(f.position_ids.data, Number), past: f['past_key_values.0.key'].dims[2], mask: n });
      const seq = f.inputs_embeds.dims[1];
      const logits = new Float32Array(seq * vocab);
      logits[(seq - 1) * vocab + (script[step] ?? STOP_SPEECH_TOKEN)] = 5;
      const o = { logits: new T('float32', logits, [1, seq, vocab]) };
      for (const p of pastNames) o[p.replace('past_key_values', 'present')] = new T('float32', new Float32Array(0), [1, 16, n, 64]);
      return o;
    }),
    conditional_decoder: sess(['speech_tokens', 'speaker_embeddings', 'speaker_features'], ['waveform'], (f) => {
      seen.dec = Array.from(f.speech_tokens.data, Number);
      return { waveform: new T('float32', new Float32Array(4800).fill(0.5), [1, 4800]) };
    }),
  })[k];
  const e = createTurbo({ ort, tokenizer: { encode: () => [11, 12, 13, 14, 15] }, createSession });
  await e.load();
  const cond = await e.voice('v', async () => new Float32Array(24000));
  const a = await e.synthesize('Hi', cond);
  assert.deepEqual(seen.dec, [7, 8, 100, 200, SILENCE_TOKEN, SILENCE_TOKEN, SILENCE_TOKEN]);
  assert.deepEqual(seen.lm[0], { pos: [0, 1, 2, 3, 4, 5, 6, 7], past: 0, mask: 8 }); // 3 voice + 5 text
  assert.deepEqual(seen.lm[1], { pos: [8], past: 8, mask: 9 });
  assert.deepEqual(seen.lm[2], { pos: [9], past: 9, mask: 10 });
  assert.equal(seen.lm.length, 3);
  assert.ok(a.length > 0 && START_SPEECH_TOKEN === 6561);
});
