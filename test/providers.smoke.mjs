// Smoke test for the network LLM providers with a mocked fetch.
// Run: node test/providers.smoke.mjs
import assert from 'node:assert/strict';

const calls = [];
let next = []; // queue of responders: (url, init) => Response | throws
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const r = next.shift();
  if (!r) throw new Error('unexpected fetch ' + url);
  return r(String(url), init);
};
const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const reset = () => { calls.length = 0; next = []; };

const { default: openaiLocal, listModels } = await import('../src/ai/openai-local.js');
const { default: holdingRag } = await import('../src/ai/holding-rag.js');
const { getLLMProvider } = await import('../src/ai/providers.js');
await import('../src/ai/scripted.js');

assert.equal(getLLMProvider('openai-local'), openaiLocal);
assert.equal(getLLMProvider('holding-rag'), holdingRag);
assert.equal(await getLLMProvider('scripted').generate({}), '');

const archetype = { id: 'steady-grandmother', name: 'Nana June' };
const req = {
  system: 'You are Nana June.',
  messages: [{ role: 'user', content: 'I feel awful' }, { role: 'assistant', content: 'I am here.' }, { role: 'user', content: 'thanks' }],
  maxTokens: 80, temperature: 0.6, archetype,
};

// --- openai-local: listModels + isAvailable
reset();
next.push(json({ object: 'list', data: [{ id: 'llama3.2:3b' }, { id: 'qwen2.5:1.5b' }] }));
assert.deepEqual(await listModels({ baseUrl: 'http://localhost:11434/v1/' }), ['llama3.2:3b', 'qwen2.5:1.5b']);
assert.equal(calls[0].url, 'http://localhost:11434/v1/models');
assert.equal(calls[0].init.method, 'GET');
assert.ok(calls[0].init.signal, 'probe has a timeout signal');

reset();
next.push(json({ data: [{ id: 'qwen2.5:1.5b' }] }));
let av = await openaiLocal.isAvailable({ model: 'llama3.2:3b' });
assert.equal(av.ok, false); assert.match(av.reason, /ollama pull llama3\.2:3b/);

reset();
next.push(() => { throw new TypeError('Failed to fetch'); });
av = await openaiLocal.isAvailable({});
assert.equal(av.ok, false); assert.match(av.reason, /OLLAMA_ORIGINS=\*/);

// --- openai-local: init + generate (request shape, OpenAI response)
reset();
next.push(json({ data: [{ id: 'my-model' }] }));
await openaiLocal.init({ baseUrl: 'http://localhost:1234/v1', model: 'my-model', apiKey: 'k' });
next.push(json({ choices: [{ message: { role: 'assistant', content: '  <think>hm</think>I am right here.  ' } }] }));
let out = await openaiLocal.generate(req);
assert.equal(out, 'I am right here.');
let c = calls.at(-1);
assert.equal(c.url, 'http://localhost:1234/v1/chat/completions');
assert.equal(c.init.method, 'POST');
assert.equal(c.init.headers.Authorization, 'Bearer k');
let body = JSON.parse(c.init.body);
assert.equal(body.model, 'my-model');
assert.equal(body.stream, false);
assert.equal(body.max_tokens, 80);
assert.equal(body.temperature, 0.6);
assert.deepEqual(body.messages[0], { role: 'system', content: 'You are Nana June.' });
assert.equal(body.messages.length, 4);

// error status
next.push(json({ error: { message: 'model not found' } }, 404));
await assert.rejects(openaiLocal.generate(req, { baseUrl: 'http://localhost:11434/v1', model: 'nope' }), /not found.*ollama pull nope/s);

// abort honoured
const ac = new AbortController();
next.push((_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
const p = openaiLocal.generate({ ...req, signal: ac.signal });
ac.abort();
await assert.rejects(p, /Cancelled/);

// --- openai-local: a model that thinks no matter what (older Holding Local, Gemma 4)
// spends a short budget on thinking and returns nothing: ask again with room, and remember.
reset();
const thinkCfg = { baseUrl: 'http://127.0.0.1:8787/v1', model: 'gemma4:e4b' };
next.push(json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
next.push(json({ choices: [{ message: { content: 'That sounds like a long day.' }, finish_reason: 'stop' }] }));
out = await openaiLocal.generate({ ...req, maxTokens: 60 }, thinkCfg);
assert.equal(out, 'That sounds like a long day.');
assert.equal(calls.length, 2);
assert.equal(JSON.parse(calls[0].init.body).max_tokens, 60);
assert.equal(JSON.parse(calls[0].init.body).think, false, 'asks the server to skip thinking');
assert.equal(JSON.parse(calls[1].init.body).max_tokens, 1024);
// remembered: the next turn goes straight to the roomy budget
next.push(json({ choices: [{ message: { content: 'I am here.' }, finish_reason: 'stop' }] }));
await openaiLocal.generate({ ...req, maxTokens: 60 }, thinkCfg);
assert.equal(JSON.parse(calls[2].init.body).max_tokens, 1024);
// cut off mid-sentence: keep whole sentences; nothing whole -> an error (scripted line fills in)
next.push(json({ choices: [{ message: { content: 'You are beautiful, inside and out. Never' }, finish_reason: 'length' }] }));
assert.equal(await openaiLocal.generate(req, thinkCfg), 'You are beautiful, inside and out.');
next.push(json({ choices: [{ message: { content: 'Oh honey, you' }, finish_reason: 'length' }] }));
await assert.rejects(openaiLocal.generate(req, thinkCfg), /cut off/);
// still empty with room: a clear error, not a silent blank
next.push(json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
await assert.rejects(openaiLocal.generate(req, thinkCfg), /thinking and said nothing/);

// --- holding-rag: health
reset();
next.push(json({ ok: true, models: ['holding-steady-grandmother'] }));
av = await holdingRag.isAvailable({});
assert.deepEqual(av, { ok: true, models: ['holding-steady-grandmother'] });
assert.equal(calls[0].url, 'http://127.0.0.1:8765/health');

// --- holding-rag: generate with {reply}
next.push(json({ ok: true, models: [] }));
await holdingRag.init({ baseUrl: 'http://127.0.0.1:8765/', useRag: false });
next.push(json({ reply: 'Still here, love.' }));
out = await holdingRag.generate(req);
assert.equal(out, 'Still here, love.');
c = calls.at(-1);
assert.equal(c.url, 'http://127.0.0.1:8765/chat');
body = JSON.parse(c.init.body);
assert.deepEqual(Object.keys(body).sort(), ['archetype', 'max_tokens', 'messages', 'system', 'temperature', 'use_rag']);
assert.equal(body.archetype, 'steady-grandmother');
assert.equal(body.use_rag, false);
assert.equal(body.system, 'You are Nana June.');
assert.equal(body.messages.length, 3);

// --- holding-rag: OpenAI-shaped response
next.push(json({ choices: [{ message: { content: 'I have you.' } }] }));
assert.equal(await holdingRag.generate(req), 'I have you.');

// --- holding-rag: network failure message
next.push(() => { throw new TypeError('fetch failed'); });
await assert.rejects(holdingRag.generate(req), /companion server/);

console.log('providers smoke: all checks passed');
