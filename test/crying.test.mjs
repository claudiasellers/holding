// The parent never assumes the user is crying. Tears are mentioned only once
// the user has said so: typed it, or tapped the Crying tile. A sad face on the
// camera or sad words are not crying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/json-hooks.mjs', import.meta.url);
const { cryingSignal, mentionsTears } = await import('../src/engine/crying.js');
const { guard } = await import('../src/engine/guard.js');
const { policyFor } = await import('../src/engine/policy.js');
const { pick, LINES } = await import('../src/engine/scripts.js');
const { buildSystemPrompt } = await import('../src/engine/prompt.js');
const { PRESETS } = await import('../src/data/archetypes.js');
const { registerLLMProvider } = await import('../src/ai/providers.js');
const { registerTTSProvider } = await import('../src/voice/providers.js');
const { createSession } = await import('../src/engine/dialogue.js');
const { store } = await import('../src/store.js');

const A = PRESETS[0];

test('the user saying they are crying counts', () => {
  for (const t of [
    "I can't stop crying", "I'm crying so hard", 'i cried all night', "I've been crying for an hour",
    'Crying again.', 'just crying', "I'm in tears", 'sobbing', 'I keep crying and I don\'t know why',
    'my mom made me cry', 'He left and I just sobbed', 'tears everywhere',
  ]) assert.equal(cryingSignal(t), true, t);
});

test('sad words, other people crying, and "not crying" do not count', () => {
  for (const t of [
    "I'm so sad", 'It hurts so much', 'I miss her', 'I feel heartbroken', 'everything is falling apart',
    "I'm not crying", "I'm not even crying, I just feel empty", "I can't cry", "I can't even cry",
    'I want to cry', "I'm trying not to cry", 'I wish I could cry', 'I almost cried',
    'my mom was crying on the phone', 'she cried when I told her', 'the baby keeps crying', 'it made him cry',
  ]) assert.equal(cryingSignal(t), null, t);
});

test('saying they have stopped clears it', () => {
  for (const t of ["I've stopped crying", 'not crying anymore', 'the tears have stopped', "I'm done crying"])
    assert.equal(cryingSignal(t), false, t);
});

test('guard rejects tears unless the user said they are crying', () => {
  const p = policyFor('bewith');
  for (const t of ['Let the tears come.', 'You can cry as long as you want.', "Of course you're crying.", "It's okay to weep.", 'Let me wipe your eyes.']) {
    assert.equal(guard(t, p).ok, false, t);
    assert.ok(guard(t, p).reasons.includes('assumes the user is crying'), t);
    assert.equal(guard(t, p, { crying: true }).ok, true, t);
  }
  // still banned even when crying is known
  assert.equal(guard('Stop crying.', p, { crying: true }).ok, false);
  // not about tears
  assert.equal(guard("Don't let it tear you apart. I'm here.", p).ok, true);
});

test('scripted pools never pick a tear line until the user says they are crying', () => {
  const paths = ['permission', 'affect.sad.bewith', 'affect.sad.name', 'opening', 'stillHere', 'fallback'];
  const tearLines = [];
  const walk = (o, p) => Array.isArray(o) ? o.forEach((l) => { if (mentionsTears(l.t)) tearLines.push(p); })
    : Object.entries(o).forEach(([k, v]) => walk(v, p ? `${p}.${k}` : k));
  walk(LINES, '');
  assert.ok(tearLines.length >= 3, 'the library has tear lines to gate');
  let seenWithCrying = 0;
  for (let i = 0; i < 400; i++) for (const p of paths) {
    const dry = pick(p, A, { endearment: 'love', allowSignature: true });
    assert.ok(!mentionsTears(dry), `${p}: "${dry}" without the user saying they're crying`);
    if (mentionsTears(pick(p, A, { endearment: 'love', crying: true }))) seenWithCrying++;
  }
  assert.ok(seenWithCrying > 0, 'tear lines are still reachable once the user says they are crying');
});

test('every archetype signature and persona is free of tears', () => {
  for (const a of PRESETS) {
    for (const s of a.lexicon?.signatures || []) assert.ok(!mentionsTears(s), `${a.id}: ${s}`);
    assert.ok(!mentionsTears(a.persona || ''), `${a.id} persona mentions tears`);
  }
});

test('the model prompt forbids tears until the user says so', () => {
  const p = policyFor('bewith');
  const off = buildSystemPrompt(A, p, {});
  assert.match(off, /Never mention crying or tears/);
  assert.match(off, /sad face or sad words are not crying/);
  const on = buildSystemPrompt(A, p, { crying: true });
  assert.doesNotMatch(on, /Never mention crying or tears/);
  assert.match(on, /told you they are crying/);
});

// ---------- in a live session ----------

const spoken = [];
registerTTSProvider({
  id: 'webspeech', label: 'fake', local: true,
  async isAvailable() { return { ok: true }; }, async listVoices() { return []; },
  async speak(text) { spoken.push(text); }, stop() {},
});
let modelSays = '';
registerLLMProvider({
  id: 'fake-tears', label: 'fake', local: true,
  async isAvailable() { return { ok: true }; }, async init() {},
  async generate() { return modelSays; }, async dispose() {},
});
const presence = { setOwn() {}, setSpeaking() {}, mirror() {} };
const settle = () => new Promise((r) => setTimeout(r, 2600));   // longer than the reply beat

function newSession(provider = 'scripted') {
  store.settings.voiceOn = true;
  store.settings.tts = { ...store.settings.tts, provider: 'webspeech' };
  store.settings.ai = { ...store.settings.ai, provider };
  return createSession({ archetype: A, presence, ui: {}, mode: 'talk' });
}

test('only typing it or tapping Crying marks the user as crying', async () => {
  const s = newSession();
  s.useProvider();
  s.onText('It hurts so much, I miss her');
  assert.equal(s.state.affect, 'sad');
  assert.equal(s.state.crying, false, 'sad is not crying');
  s.onText('my mom was crying when she called');
  assert.equal(s.state.crying, false, 'someone else crying is not the user');
  s.onText("I can't stop crying");
  assert.equal(s.state.crying, true);
  s.onText("I've stopped crying now");
  assert.equal(s.state.crying, false);
  s.onTile('crying');
  assert.equal(s.state.crying, true, 'the Crying tile says so');
  assert.equal(s.state.affect, 'sad', 'the Crying tile feels like sad');
  s.destroy();
});

test('a model reply about tears is replaced when the user never said they were crying', async () => {
  const s = newSession('fake-tears');
  s.useProvider();
  await new Promise((r) => setTimeout(r, 50));
  modelSays = 'Let the tears come. I am right here.';
  spoken.length = 0;
  s.onText('I feel so sad tonight');
  await settle();
  assert.ok(spoken.length, 'the parent answered');
  assert.ok(spoken.every((t) => !mentionsTears(t)), `no tears without being told: ${JSON.stringify(spoken)}`);
  assert.ok(!spoken.includes(modelSays), 'the model line was rejected');

  spoken.length = 0;
  s.onText("I'm crying so hard");
  await settle();
  assert.ok(spoken.includes(modelSays), `once told, the model may name it: ${JSON.stringify(spoken)}`);
  s.destroy();
});
