// A typed message gets the AI's reply when an AI is on; when it can't, the
// scripted line that fills in says why (log, chip, Settings via brainStatus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, ctx, next) {
  if (url.endsWith('.json')) return next(url, { ...ctx, importAttributes: { type: 'json' } });
  return next(url, ctx);
}`));
const { registerTTSProvider } = await import('../src/voice/providers.js');
const { registerLLMProvider } = await import('../src/ai/providers.js');
const { createSession } = await import('../src/engine/dialogue.js');
const { brainStatus, fallbackText } = await import('../src/ai/brain.js');
const { PRESETS } = await import('../src/data/archetypes.js');
const { store } = await import('../src/store.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
registerTTSProvider({ id: 'webspeech', label: 'fake', local: true, async isAvailable() { return { ok: true }; }, async listVoices() { return []; }, async speak() {}, stop() {} });

let replies = [];      // queue: string, or Error to throw
const asked = [];
registerLLMProvider({
  id: 'fake-llm', label: 'fake', local: true,
  async isAvailable() { return { ok: true }; },
  async init() {},
  async generate(req) { asked.push(req); const r = replies.shift(); if (r instanceof Error) throw r; return r ?? ''; },
});

const presence = { setOwn() {}, setSpeaking() {}, mirror() {} };
async function talk(text) {
  store.settings.voiceOn = false;
  store.settings.ai = { ...store.settings.ai, provider: 'fake-llm' };
  const said = [];
  const s = createSession({ archetype: PRESETS[0], presence, ui: { onSay: (t, m) => said.push({ t, m }) }, mode: 'talk' });
  s.useProvider();
  for (let i = 0; i < 50 && !s.modelReady; i++) await wait(10);
  await s.onText(text);
  for (let i = 0; i < 300 && !said.some((x) => x.m.typed); i++) await wait(10);
  s.destroy();
  return said.find((x) => x.m.typed);
}

test('the AI reply is what the parent says', async () => {
  replies = ['That sounds like a heavy kind of tired.'];
  const r = await talk("I'm tired today.");
  assert.equal(r.t, 'That sounds like a heavy kind of tired.');
  assert.equal(r.m.source, 'model');
  assert.equal(brainStatus().last.source, 'model');
  assert.equal(brainStatus().state, 'ready');
});

test('an empty AI reply falls back and says it was empty, not that it broke a rule', async () => {
  replies = [''];
  const r = await talk("I'm tired today.");
  assert.equal(r.m.source, 'script');
  assert.equal(r.m.fallback, 'empty');
  assert.match(brainStatus().last.text, /came back empty/);
});

test('a reply that breaks a rule gets one more try with the reason', async () => {
  asked.length = 0;
  replies = ['I love you so much!', 'You look lovely to me, and I mean it.'];
  const r = await talk("tell me i'm pretty");
  assert.equal(r.m.source, 'model');
  assert.equal(r.t, 'You look lovely to me, and I mean it.');
  assert.equal(asked.length, 2);
  assert.match(asked[1].system, /not usable because it guilt \/ overclaiming love/);
});

test('a server error is named in the fallback', async () => {
  replies = [new Error('Local server error 503. Ollama is not running.')];
  const r = await talk('hello');
  assert.equal(r.m.fallback, 'failed');
  assert.match(fallbackText(r.m.fallback, r.m.fallbackDetail), /didn't answer \(Local server error 503/);
});

test('rules off: a reply that breaks rules is shown exactly as written, first try', async () => {
  asked.length = 0;
  store.settings.rawAI = true;
  try {
    const raw = "Oh love, I love you so much! Why did she say that? At least you're here. Here are 3 things: 1. rest 2. water 3. sleep.";
    replies = [raw];
    const r = await talk("my sister said i was overreacting");
    assert.equal(r.t, raw);                 // no trimming, no sentence cap, no '!' -> '.'
    assert.equal(r.m.source, 'model');
    assert.equal(r.m.raw, true);
    assert.equal(asked.length, 1);          // no second try
    assert.match(r.m.rawNote, /guilt \/ overclaiming love/);
    assert.match(r.m.rawNote, /minimizing/);
    assert.equal(brainStatus().last.raw, true);
  } finally { store.settings.rawAI = false; }
});

test('rules off: an empty reply still falls back (nothing to show)', async () => {
  store.settings.rawAI = true;
  try {
    replies = ['', ''];
    const r = await talk('hello');
    assert.equal(r.m.source, 'script');
    assert.equal(r.m.fallback, 'empty');
  } finally { store.settings.rawAI = false; }
});
