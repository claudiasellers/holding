// Repair ritual (research doc §7.5): name the specific miss, own it, check, re-attune.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/json-hooks.mjs', import.meta.url);
const { nameMiss, repairLine, listenLine, reattuneLine, readCheckAnswer, missSignals } = await import('../src/engine/repair.js');
const { guard } = await import('../src/engine/guard.js');
const { policyFor } = await import('../src/engine/policy.js');
const { PRESETS } = await import('../src/data/archetypes.js');

const A = PRESETS[0];
const ctx = { endearment: 'love' };
const CASES = [
  { last: 'What happened tonight?', kind: 'affect', tier: 'bewith' },
  { last: 'What happened tonight?', kind: 'affect', tier: 'name', answeredUser: true },
  { last: 'Maybe you could try a glass of water.', kind: 'affect', tier: 'name', answeredUser: true },
  { last: 'Have you had some water?', kind: 'bodyBudget', tier: 'name' },
  { last: 'Put your hand where you would want mine to be.', kind: 'selfTouch', tier: 'bewith' },
  { last: 'That sounds like a lot of fear.', kind: 'affect', tier: 'name', affect: 'scared', answeredUser: true },
  { last: 'Still here.', kind: 'stillHere', tier: 'bewith' },
  { last: "I'm listening.", kind: 'affect', tier: 'bewith', answeredUser: true },
  { last: 'Nothing about you is too much for me.', kind: 'tooMuch', tier: 'name', answeredUser: true },
  { last: 'Something about that old rule might be at work here.', kind: 'makesense', tier: 'makesense' },
  { last: 'Ha, good. What made you smile today.', kind: 'ordinary', tier: 'ordinary' },
  { last: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen.', kind: 'permission', tier: 'bewith' },
  { last: 'Still here.', again: true, tier: 'bewith' },
  { last: '', tier: 'bewith' },
];

test('every miss is named specifically, not generically', () => {
  const ids = CASES.map((c) => nameMiss(c).id);
  assert.deepEqual(ids, ['question', 'question', 'fixing', 'question', 'fixing', 'named', 'talking', 'generic', 'stock', 'meaning', 'light', 'tooMuch', 'again', 'none']);
  assert.equal(nameMiss(CASES[2]).text, 'jumped to fixing when you needed me to just stay');   // the doc's own example
  assert.match(nameMiss(CASES[5]).text, /fear/);
  for (const c of CASES) { const m = nameMiss(c); assert.ok(m.instruction && m.reattune && m.tier, m.id); }
});

test('repair line follows the fixed script: name, own, check', () => {
  const m = nameMiss(CASES[2]);
  const line = repairLine(m, { tier: 'name', archetype: A, ctx });
  assert.match(line, /^I jumped to fixing when you needed me to just stay\. /);
  assert.match(line, /(on me, not you|mine, not yours|My miss, not yours)\./);
  assert.match(line, /Is that it, or something else\?$/);
  assert.doesNotMatch(line, /sorry|forgive|terrible|awful|failed you/i, 'owns without groveling');
});

test('be-with repair still checks, as a tap, never as a question', () => {
  const line = repairLine(nameMiss(CASES[0]), { tier: 'bewith', archetype: A, ctx });
  assert.ok(!line.includes('?'), line);
  assert.match(line, /^I asked you something when you needed me to just stay\./);
  assert.match(line, /Tap if that's it, or if it's something else\.$/);
});

test('self-detected misses are tentative and open with the signal', () => {
  const m = nameMiss(CASES[1]);
  assert.match(repairLine(m, { tier: 'name', trigger: 'silence', archetype: A, ctx }), /^I think that last part may have missed\. I think I asked/);
  assert.match(repairLine(m, { tier: 'name', trigger: 'apology', archetype: A, ctx }), /^You don't have to be sorry\. I think I/);
  assert.match(repairLine(m, { tier: 'name', trigger: 'sharp', archetype: A, ctx }), /^You're right to tell me\. I asked/);
  assert.match(repairLine(nameMiss(CASES[12]), { tier: 'bewith', archetype: A, ctx }), /^I still didn't get it right\./);
});

test('every assembled repair, listen and re-attune line passes the guard', () => {
  const bad = [];
  for (const c of CASES) for (const tier of ['bewith', 'name']) for (const trigger of ['button', 'sharp', 'apology', 'silence']) {
    for (let n = 0; n < 4; n++) {
      const line = repairLine(nameMiss(c), { tier, trigger, archetype: A, ctx });
      const g = guard(line, null);
      if (!g.ok) bad.push(`${line} :: ${g.reasons}`);
    }
  }
  for (const tier of ['bewith', 'name']) { const g = guard(listenLine(tier, A, ctx), policyFor(tier)); if (!g.ok) bad.push(g.reasons.join()); }
  for (const k of ['quiet', 'stay', 'noQuestions', 'slower', 'deeper', 'heard']) { const t = reattuneLine(k, A, ctx); const g = guard(t, policyFor('bewith')); if (!g.ok || g.text !== t) bad.push(`${k}: ${t}`); }
  assert.deepEqual(bad, []);
});

test('re-attune moves to the right tier and tightens the turn policy', () => {
  assert.equal(nameMiss(CASES[2]).tier, 'bewith', 'fixing in Name steps down to Be-with');
  assert.equal(nameMiss(CASES[9]).tier, 'name', 'meaning-making too soon steps down to Name');
  assert.equal(nameMiss(CASES[10]).tier, 'name', 'too light steps into Name');
  assert.ok(nameMiss(CASES[0]).fix.noQuestions > 0);
  assert.ok(nameMiss(CASES[2]).fix.noAdvice);
  assert.ok(nameMiss(CASES[11]).fix.quietMs > 0);
});

test('reading the answer to the check', () => {
  assert.deepEqual(readCheckAnswer('yes'), { answer: 'yes', rest: '' });
  assert.deepEqual(readCheckAnswer("yeah, I just wanted you to listen"), { answer: 'yes', rest: 'I just wanted you to listen' });
  assert.deepEqual(readCheckAnswer('no'), { answer: 'else', rest: '' });
  assert.deepEqual(readCheckAnswer("no, I'm angry not sad"), { answer: 'else', rest: "I'm angry not sad" });
  assert.deepEqual(readCheckAnswer('I wanted you to be quiet'), { answer: 'else', rest: 'I wanted you to be quiet' });
});

test('self-detection: sharp language and apologizing', () => {
  assert.equal(missSignals("that's not what I said").sharp, true);
  assert.equal(missSignals("you're not listening").sharp, true);
  assert.equal(missSignals('no.').sharp, true);
  assert.equal(missSignals('no', { lastWasQuestion: true }).sharp, false, 'a plain no to a question is an answer');
  assert.equal(missSignals("sorry, I'm not explaining this well").apology, true);
  assert.equal(missSignals('never mind').apology, true);
  assert.equal(missSignals("what's wrong with me").sharp, false);
  assert.equal(missSignals('I feel so sad tonight').sharp, false);
});

test('presence lines are not mistaken for advice', () => {
  assert.notEqual(nameMiss({ last: 'Nothing you could feel would scare me off.', kind: 'permission', tier: 'bewith' }).id, 'fixing');
  assert.equal(nameMiss({ last: 'You could write it down tomorrow.', kind: 'affect', tier: 'name' }).id, 'fixing');
});

test('a correction is read for what it is, not what it is not', async () => {
  const { withoutNegated } = await import('../src/engine/repair.js');
  const { readText } = await import('../src/engine/affect.js');
  assert.equal(readText(withoutNegated("I'm not sad, I'm furious at her")).affect, 'angry');
  assert.equal(readText(withoutNegated("it isn't fear, it's that I feel so alone")).affect, 'lonely');
});

test('the same miss twice is owned as a repeat; generated replies cannot break the promise', async () => {
  const { breaksPromise } = await import('../src/engine/repair.js');
  assert.match(repairLine(nameMiss(CASES[2]), { tier: 'name', repeat: true, archetype: A, ctx }), /^I did it again\. I jumped to fixing/);
  const fix = { noAdviceUntil: Date.now() + 60000 };
  assert.equal(breaksPromise('Maybe you could try writing her a calm message.', fix), true);
  assert.equal(breaksPromise('Furious at her. I am staying right here.', fix), false);
  assert.equal(breaksPromise('Maybe you could try writing her a calm message.', null), false);
});

test('each suggested-reply chip shown after a repair maps to its check answer', async () => {
  const chips = ["Yes, that's it.", 'Something else.', 'Just stay with me.'];
  assert.deepEqual(chips.map(readCheckAnswer), [
    { answer: 'yes', rest: '' }, { answer: 'else', rest: '' }, { answer: 'stay', rest: '' },
  ]);
  assert.deepEqual(readCheckAnswer('stay'), { answer: 'stay', rest: '' });
  assert.deepEqual(readCheckAnswer("yes that's it, I just wanted quiet"), { answer: 'yes', rest: "that's it, I just wanted quiet" });
  // the chips in the suggestion bank are exactly these
  const src = (await import('node:fs')).readFileSync(new URL('../src/engine/suggest.js', import.meta.url), 'utf8');
  for (const c of chips) assert.ok(src.includes(c.replace("'", "\\'")), c);
});
