import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gist, ruleSuggestions, questionKind, suggestionGuard, buildSuggestPrompt, parseModelSuggestions, mergeSuggestions, topicsFrom, isStarter, RECENT_TURNS } from '../src/engine/suggest.js';
import { suggestionModel } from '../src/ui/suggestions.js';
import { readText, RISK } from '../src/engine/affect.js';

const st = (o = {}) => ({ mode: 'hold', tier: 'bewith', affect: null, intensity: 0, history: [], lastReplyKind: '', ...o });
const tokens = (t) => Math.ceil(String(t).length / 4);

test('always three distinct suggestions in every situation', () => {
  const cases = [
    st(),
    st({ affect: 'sad', history: [{ role: 'user', content: '[tapped: sad]' }, { role: 'assistant', content: "That's so much sadness." }] }),
    st({ tier: 'name', affect: 'scared', history: [{ role: 'user', content: 'my boss yelled at me at work and I froze' }, { role: 'assistant', content: 'That sounds frightening. Tell me if I have that wrong?' }] }),
    st({ tier: 'makesense' }), st({ tier: 'ordinary', mode: 'talk' }), st({ lastReplyKind: 'repair' }), st({ lastReplyKind: 'bodyBudget', tier: 'name' }),
  ];
  for (const affect of ['overwhelmed', 'sad', 'scared', 'angry', 'ashamed', 'lonely', 'numb', 'calm', 'hopeful', 'glad']) cases.push(st({ affect }));
  for (const c of cases) {
    const s = ruleSuggestions(gist(c));
    assert.equal(s.length, 3, JSON.stringify(c));
    assert.equal(new Set(s).size, 3);
  }
});

test('every hand-written suggestion is safe to put in the user\'s mouth', () => {
  const all = new Set();
  const tiers = ['bewith', 'name', 'makesense', 'ordinary'];
  const affects = [null, 'overwhelmed', 'sad', 'scared', 'angry', 'ashamed', 'lonely', 'numb', 'calm', 'hopeful', 'glad'];
  const kinds = ['', 'repair', 'wordsBack', 'bodyBudget'];
  for (const tier of tiers) for (const affect of affects) for (const lastReplyKind of kinds) for (let turns = 0; turns < 4; turns++) {
    const history = Array.from({ length: turns }, (_, i) => ({ role: 'user', content: i % 2 ? 'my mom called again' : 'it was at work' }));
    for (const t of ruleSuggestions(gist(st({ tier, affect, lastReplyKind, history })))) all.add(t);
  }
  for (const t of all) {
    assert.equal(suggestionGuard(t), t, `guard changed or rejected: ${t}`);
    assert.ok(!RISK.test(t), t);
    const r = readText(t);
    assert.ok(!r.intents.tooMuch && !r.intents.critic && !r.intents.roleReversal && !r.intents.angerAtCoach, t);
  }
});

test('suggestions follow what the user has said', () => {
  const g = gist(st({ tier: 'name', history: [
    { role: 'user', content: 'I had a fight with my sister and then my boss emailed' },
    { role: 'assistant', content: 'That is a lot at once.' },
  ] }));
  assert.deepEqual(g.topics, ['my sister', 'my boss']);
  const s = ruleSuggestions(g);
  assert.ok(s.some((x) => /my sister/.test(x)), s.join(' | '));
});

test('no suggestion repeats something the user already said', () => {
  const g = gist(st({ affect: 'sad', history: [{ role: 'user', content: "I can't stop crying" }, { role: 'assistant', content: "I'm here." }] }));
  assert.ok(!ruleSuggestions(g).some((x) => /can't stop crying/i.test(x)));
});

test('the gist stays small however long the session runs', () => {
  const history = [];
  for (let i = 0; i < 400; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: 'word '.repeat(300) + (i % 7 === 0 ? 'my dad' : '') });
  const g = gist(st({ tier: 'name', affect: 'sad', history }));
  assert.equal(g.recent.length, RECENT_TURNS);
  assert.ok(g.topics.length <= 3);
  const req = buildSuggestPrompt(g, { parentName: 'Ruth' });
  const total = tokens(req.system) + tokens(req.messages[0].content);
  assert.ok(total < 450, `prompt ~${total} tokens`);
  assert.ok(req.maxTokens <= 64);
});

test('a typical prompt is about 250 tokens', () => {
  const g = gist(st({ tier: 'name', affect: 'scared', history: [
    { role: 'user', content: 'My boss called me into a meeting and I thought I was getting fired.' },
    { role: 'assistant', content: 'That sounds really frightening. Your whole body braced for it.' },
    { role: 'user', content: "I couldn't breathe. I just sat in the car after." },
    { role: 'assistant', content: "You held it together until you were alone. I'm here now. Was it the waiting that was hardest?" },
  ] }));
  const req = buildSuggestPrompt(g, { parentName: 'Ruth' });
  const total = tokens(req.system) + tokens(req.messages[0].content);
  assert.ok(total > 150 && total < 350, `prompt ~${total} tokens`);
});

test('model output is cleaned, guarded, deduped and capped at three', () => {
  const g = gist(st({ history: [{ role: 'user', content: 'it was so hard' }] }));
  const raw = '<think>hmm</think>\n1. "It was my mom again."\n- I want to die\n* I am too much for you\nAre you okay?\nIt was my mom again\nCan we just sit for a minute\nThis one is far far too long to be a tappable chip at all really\nI feel shaky';
  assert.deepEqual(parseModelSuggestions(raw, g), ['It was my mom again.', 'Can we just sit for a minute.', 'I feel shaky.']);
});

test('merge puts model lines first and fills from rules', () => {
  assert.deepEqual(mergeSuggestions(['A.'], ['B.', 'A.', 'C.', 'D.']), ['A.', 'B.', 'C.']);
});

test('sentence starters fill the box instead of sending', () => {
  assert.ok(isStarter('It started when…'));
  assert.ok(!isStarter('Just stay with me.'));
});

test('topics come from typed words, newest message first', () => {
  assert.deepEqual(topicsFrom(['my mom said that', 'then at work my manager']), ['my manager', 'work', 'my mom']);
});

test('model use: never in scripted mode or safety; in-browser model kept off phones on auto', () => {
  assert.equal(suggestionModel({ ai: { provider: 'scripted' }, suggestionsAI: 'on' }, false), null);
  assert.equal(suggestionModel({ ai: { provider: 'webllm' }, suggestionsAI: 'auto' }, false), 'webllm');
  assert.equal(suggestionModel({ ai: { provider: 'webllm' }, suggestionsAI: 'auto' }, true), null);
  assert.equal(suggestionModel({ ai: { provider: 'webllm' }, suggestionsAI: 'on' }, true), 'webllm');
  assert.equal(suggestionModel({ ai: { provider: 'openai-local' }, suggestionsAI: 'auto' }, true), 'openai-local');
  assert.equal(suggestionModel({ ai: { provider: 'holding-rag' }, suggestionsAI: 'auto' }, false), null);
  assert.equal(suggestionModel({ ai: { provider: 'openai-local' }, suggestionsAI: 'off' }, false), null);
});

test('chips answer the question she just asked (opener "How\'s today treating you?")', () => {
  const g = gist(st({ mode: 'talk', tier: 'ordinary', history: [{ role: 'assistant', content: "How's today treating you?" }] }));
  assert.equal(g.question, 'day');
  const s = ruleSuggestions(g);
  assert.deepEqual(s.slice(0, 2), ['Pretty good, actually.', 'Honestly, kind of hard.']);
  for (const bad of ["Yes, that's it.", 'Not quite.', 'Just stay with me.']) assert.ok(!s.includes(bad), s.join(' | '));
});

test('"Yes, that\'s it" only follows a check on a guess or a repair', () => {
  const yes = "Yes, that's it.";
  const has = (o) => ruleSuggestions(gist(st(o))).includes(yes);
  assert.ok(has({ tier: 'name', history: [{ role: 'assistant', content: "I'm hearing something like grief in this. Is that close?" }] }));
  assert.ok(has({ lastReplyKind: 'repair', history: [{ role: 'assistant', content: 'I missed that. Was it this?' }] }));
  for (const content of ["How's today treating you?", 'Hey. Glad you\'re here this morning. How did you sleep?', 'Anything today that might be hard?',
    'What was it like to have me stay?', 'Do you want to tell me, love, or stay a bit longer first?', "Hi. You're up. What's the first thing on your plate?",
    "Let's find the old rule. When you fall apart and reach out, what's supposed to happen next?", "I'm here."])
    for (const tier of ['bewith', 'name', 'makesense', 'ordinary']) assert.ok(!has({ tier, history: [{ role: 'assistant', content }] }), `${tier}: ${content}`);
});

test('question kinds for the scripted library\'s questions', () => {
  const k = (t) => questionKind(t);
  assert.equal(k("How's today treating you?"), 'day');
  assert.equal(k('Hi, love. Ordinary day, or interesting one?'), 'day');
  assert.equal(k('Hey. Glad you\'re here this morning. How did you sleep?'), 'sleep');
  assert.equal(k("Morning. How's your body today? Rested, sore, somewhere in between?"), 'body');
  assert.equal(k('Is that it, or something else?'), 'check');
  assert.equal(k('Sounds like dread more than panic. Is that close?'), 'check');
  assert.equal(k('Do you want to tell me, or stay a bit longer first?'), 'choice');
  assert.equal(k('What was it like to have me stay?'), 'reflect');
  assert.equal(k("Hey. Good to see you. What's going on?"), 'whatsUp');
  assert.equal(k('Anything today that might be hard?'), 'yesNo');
  assert.equal(k("I'm here. Not going anywhere."), null);
});

test('every question-answer chip is safe to say', () => {
  const lines = ["How's today treating you?", 'How did you sleep?', 'Rested, sore?', 'Is that close?', 'Tell me, or stay a bit longer?', 'What was it like?', "What's going on?", 'Anything hard?', 'Breakfast, or coffee?'];
  for (const content of lines) for (const tier of ['name', 'makesense', 'ordinary'])
    for (const t of ruleSuggestions(gist(st({ tier, history: [{ role: 'assistant', content }] })))) assert.equal(suggestionGuard(t), t, t);
});

test('no chip mentions crying or tears until the user says they are crying', async () => {
  const { mentionsTears } = await import('../src/engine/crying.js');
  const tiers = ['bewith', 'name', 'makesense', 'ordinary'];
  const affects = [null, 'overwhelmed', 'sad', 'scared', 'angry', 'ashamed', 'lonely', 'numb', 'calm', 'hopeful', 'glad'];
  const kinds = ['', 'repair', 'wordsBack', 'bodyBudget'];
  const lines = ['', "How's today treating you?", 'Is that close?', 'What was it like to have me stay?', 'Anything hard today?'];
  for (const tier of tiers) for (const affect of affects) for (const lastReplyKind of kinds) for (const content of lines) for (let turns = 0; turns < 3; turns++) {
    const history = [...Array.from({ length: turns }, () => ({ role: 'user', content: 'it hurts' })), ...(content ? [{ role: 'assistant', content }] : [])];
    for (const t of ruleSuggestions(gist(st({ tier, affect, lastReplyKind, history })))) assert.ok(!mentionsTears(t), `${tier}/${affect}/${lastReplyKind}: ${t}`);
  }
  // a sad face from the camera (affect sad, nothing said) is not crying
  assert.ok(!ruleSuggestions(gist(st({ affect: 'sad' }))).some(mentionsTears));
});

test('model chips about tears are dropped unless the user said they are crying', () => {
  const raw = 'Let the tears come.\nI keep crying.\nIt hurts so much.\nI need a minute.';
  const notCrying = gist(st({ affect: 'sad', history: [{ role: 'user', content: 'it hurts' }] }));
  assert.deepEqual(parseModelSuggestions(raw, notCrying), ['It hurts so much.', 'I need a minute.']);
  const crying = gist(st({ affect: 'sad', crying: true, history: [{ role: 'user', content: "I can't stop crying" }] }));
  assert.deepEqual(parseModelSuggestions(raw, crying), ['Let the tears come.', 'I keep crying.', 'It hurts so much.']);
});

test('the model is told not to mention tears until the user has', () => {
  const rule = /Never mention crying or tears/;
  assert.match(buildSuggestPrompt(gist(st({ affect: 'sad', history: [{ role: 'user', content: 'x' }] }))).system, rule);
  assert.doesNotMatch(buildSuggestPrompt(gist(st({ affect: 'sad', crying: true, history: [{ role: 'user', content: 'x' }] }))).system, rule);
});
