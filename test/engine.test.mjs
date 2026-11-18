import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guard } from '../src/engine/guard.js';
import { policyFor } from '../src/engine/policy.js';
import { fill } from '../src/engine/fill.js';
import { readText } from '../src/engine/affect.js';
import { computeTuning } from '../src/face/tuning.js';
import { markedForm } from '../src/face/mirror.js';
import { PRESETS, generateArchetype } from '../src/data/archetypes.js';

const LINES = JSON.parse(fs.readFileSync(new URL('../src/data/lines.json', import.meta.url)));
const tierFor = (p) => /affect\.\w+\.bewith|^(opening|stillHere|permission|selfTouch|breath)/.test(p) ? 'bewith' : /makesense/.test(p) ? 'makesense' : /ordinary/.test(p) ? 'ordinary' : 'name';

test('every scripted line passes the guard for its tier', () => {
  const bad = [];
  const walk = (o, p) => Array.isArray(o) ? o.forEach((l, i) => { const g = guard(fill(l.t, { endearment: 'love', userName: 'Sam' }), policyFor(l.tier || tierFor(p))); if (!g.ok) bad.push(`${p}[${i}] ${l.t} :: ${g.reasons}`); })
    : Object.entries(o).forEach(([k, v]) => walk(v, p ? `${p}.${k}` : k));
  walk(LINES, '');
  assert.deepEqual(bad, []);
});

test('be-with lines never contain questions', () => {
  for (const k of ['opening', 'stillHere', 'permission', 'selfTouch']) for (const l of LINES[k]) assert.ok(!l.t.includes('?'), l.t);
});

test('guard rejects the hostile and helpless parent', () => {
  const p = policyFor('name');
  for (const t of ['Calm down, it is not that bad.', 'Why are you crying?', "I'm so tired of this.", 'Look on the bright side!', "You're right, you are too much.", 'I am a licensed therapist.', 'This sounds like disorganized attachment.', 'I missed you so much.'])
    assert.equal(guard(t, p).ok, false, t);
  assert.equal(guard("That's so much fear. I'm staying right here.", policyFor('bewith')).ok, true);
});

test('guard strips questions and caps length in be-with', () => {
  const g = guard("I'm here. Still here. You're safe with me. What happened?", policyFor('bewith'));
  assert.equal(g.text, "I'm here. Still here.");
});

test('endearment tokens fill cleanly when empty', () => {
  assert.equal(fill('{endearment}, I am here.', {}), 'I am here.');
  assert.equal(fill('I have you, {endearment}.', {}), 'I have you.');
  assert.equal(fill('I have you, {endearment}.', { endearment: 'love' }), 'I have you, love.');
});

test('affect reading and risk', () => {
  assert.equal(readText("I'm so scared I can't breathe").affect, 'scared');
  assert.equal(readText('I want to die').risk, true);
  assert.equal(readText("are you ok? i'm sorry i'm so much").intents.roleReversal, true);
  assert.equal(readText("I'm too much, everyone leaves").intents.tooMuch, true);
});

test('tuning responds to facial features', () => {
  const base = PRESETS[0].face;
  const thick = computeTuning({ ...base, brows: { ...base.brows, thick: .9, arch: .3 } }).gains;
  const thin = computeTuning({ ...base, brows: { ...base.brows, thick: .1, arch: .8 } }).gains;
  assert.ok(thick.au1 > thin.au1, 'thick, low brows get more brow gain');
  const bearded = computeTuning({ ...base, beard: 'full' }).gains;
  const shaven = computeTuning({ ...base, beard: 'none' }).gains;
  assert.ok(bearded.au17 < shaven.au17 && bearded.tilt > shaven.tilt, 'beard shifts expression to tilt');
});

test('marked mirroring keeps the parent steady', () => {
  for (const a of ['sad', 'scared', 'angry', 'ashamed', 'lonely', 'overwhelmed']) {
    const f = markedForm(a, 1, .8, .5);
    assert.ok(f.au5 <= .05, `${a}: no alarm-widened eyes`);
    assert.ok(f.au6 >= .2, `${a}: soft cheeks stay on`);
    assert.ok(f.tilt > .3, `${a}: marked tilt`);
  }
  const sad = markedForm('sad', 1, .8);
  assert.ok(sad.au1 > .7 && sad.au15 > .4, 'sad signature is exaggerated');
});

test('generator stays in the comforting range', () => {
  for (let i = 0; i < 50; i++) {
    const a = generateArchetype();
    assert.ok(a.stance.warmth <= .6 && a.mirror.markedness >= .6 && a.face.age >= 38);
  }
});
