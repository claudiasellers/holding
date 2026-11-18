#!/usr/bin/env node
// Real-model smoke test for the in-browser Chatterbox Turbo engine
// (src/voice/chatterbox-turbo-core.js), run in Node on the CPU with onnxruntime-node,
// the same graphs the browser loads, and Transformers.js for the tokenizer.
// Downloads ~960 MB once. CI runs it on voice changes; it is not part of `npm test`.
//
//   npm i --no-save @huggingface/transformers@4.3.2 onnxruntime-node@1.30.0
//   node test/voice/chatterbox-turbo.smoke.mjs [--out samples/] [--cache .turbo]
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { createTurbo, TURBO_GRAPHS, TURBO_FILES, TURBO_REPO, TURBO_SR, turboUrl } from '../../src/voice/chatterbox-turbo-core.js';
import { DEFAULT_VOICE_URL, resample } from '../../src/voice/chatterbox-core.js';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const out = arg('--out', null);
const dir = arg('--cache', '.turbo-cache');
const ort = await import('onnxruntime-node');
const lib = await import('@huggingface/transformers');

async function fetchTo(path) {
  const dest = join(dir, path);
  try { if ((await stat(dest)).size > 0) return dest; } catch { /* download */ }
  await mkdir(dirname(dest), { recursive: true });
  const r = await fetch(turboUrl(path));
  assert.ok(r.ok, `${path}: ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  return dest;
}

function parseWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 12; let fmt = null; let data = null;
  while (p + 8 <= dv.byteLength) {
    const id = String.fromCharCode(...buf.subarray(p, p + 4)); const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(p + 8, true), channels: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    if (id === 'data') data = { start: p + 8, size };
    p += 8 + size + (size & 1);
  }
  const n = data.size / (fmt.bits / 8) / fmt.channels; const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = data.start + i * fmt.channels * (fmt.bits / 8);
    a[i] = fmt.format === 3 ? dv.getFloat32(o, true) : fmt.bits === 16 ? dv.getInt16(o, true) / 32768 : dv.getInt32(o, true) / 2147483648;
  }
  return { audio: a, rate: fmt.rate };
}

function toWav(a, rate) {
  const b = Buffer.alloc(44 + a.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + a.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(a.length * 2, 40);
  for (let i = 0; i < a.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a[i] * 32767))), 44 + i * 2);
  return b;
}

let t0 = Date.now();
for (const f of TURBO_FILES) await fetchTo(f);
console.log(`[turbo] files ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
t0 = Date.now();
const tok = await lib.AutoTokenizer.from_pretrained(TURBO_REPO);
const engine = createTurbo({
  ort,
  tokenizer: { encode: (t) => tok.encode(t) },
  createSession: (key) => ort.InferenceSession.create(join(dir, 'onnx', TURBO_GRAPHS[key])),
});
await engine.load();
console.log(`[turbo] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const res = await fetch(DEFAULT_VOICE_URL);
assert.ok(res.ok, `default voice ${res.status}`);
const wav = parseWav(new Uint8Array(await res.arrayBuffer()));
const cond = await engine.voice('default', async () => resample(wav.audio, wav.rate));

const lines = {
  plain: 'I\'m right here. You don\'t have to say anything.',
  sigh: 'Oh, sweetheart. [sigh] That was a long day, wasn\'t it? Come sit with me.',
};
for (const [name, text] of Object.entries(lines)) {
  const t = Date.now();
  const a = await engine.synthesize(text, cond);
  const secs = a.length / TURBO_SR; const took = (Date.now() - t) / 1000;
  let peak = 0; for (const x of a) peak = Math.max(peak, Math.abs(x));
  console.log(`[turbo] ${name}: ${secs.toFixed(2)}s of audio in ${took.toFixed(1)}s (${(secs / took).toFixed(2)}x real time), peak ${peak.toFixed(2)}`);
  assert.ok(secs > 1.5 && secs < 15, `odd length ${secs}s`);
  assert.ok(peak > 0.05, 'silent output');
  if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, `browser-chatterbox-turbo-${name}.wav`), toWav(a, TURBO_SR)); }
}
await engine.dispose();
console.log('[turbo] ok');
