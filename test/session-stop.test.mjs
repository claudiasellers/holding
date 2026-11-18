// Leaving the session screen must silence the parent at once, including the
// closing lines that keep playing after End.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The app imports JSON the Vite way (no import attribute); teach Node to do the same.
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, ctx, next) {
  if (url.endsWith('.json')) return next(url, { ...ctx, importAttributes: { type: 'json' } });
  return next(url, ctx);
}`));
const { registerTTSProvider } = await import('../src/voice/providers.js');
const { createSession } = await import('../src/engine/dialogue.js');
const { PRESETS } = await import('../src/data/archetypes.js');
const { store } = await import('../src/store.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake voice: each line "plays" for LINE_MS unless its signal aborts.
const LINE_MS = 300;
const log = [];
let playing = 0;
registerTTSProvider({
  id: 'webspeech', label: 'fake', local: true,
  async isAvailable() { return { ok: true }; },
  async listVoices() { return []; },
  async speak(text, { signal } = {}) {
    if (signal?.aborted) return;
    log.push(text); playing++;
    await new Promise((r) => { const t = setTimeout(r, LINE_MS); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    playing--;
  },
  stop() {},
});

const presence = { setOwn() {}, setSpeaking() {}, mirror() {} };

function newSession() {
  store.settings.voiceOn = true;
  store.settings.tts = { ...store.settings.tts, provider: 'webspeech' };
  return createSession({ archetype: PRESETS[0], presence, ui: {}, mode: 'talk' });
}

test('leaving after End stops the closing line and the one after it', async () => {
  const s = newSession();
  s.start();
  await wait(LINE_MS + 100);           // opening line done
  log.length = 0;
  const ending = s.end();
  // wait for the first closing line to start playing
  for (let i = 0; i < 50 && !log.length; i++) await wait(20);
  assert.equal(log.length, 1, 'closing line started');
  s.destroy();                          // user taps Home
  await ending;
  await wait(LINE_MS + 1500);           // longer than the 900 ms gap before the last line
  assert.equal(log.length, 1, `nothing spoken after leaving, got: ${JSON.stringify(log)}`);
  assert.equal(playing, 0, 'no line still playing');
});

test('staying after End still plays both closing lines', async () => {
  const s = newSession();
  s.start();
  await wait(LINE_MS + 100);
  log.length = 0;
  await s.end();
  assert.equal(log.length, 2, 'closing and metaprocess lines both play');
  s.destroy();
});

test('a line queued before leaving never starts', async () => {
  const s = newSession();
  s.start();
  await wait(LINE_MS + 100);
  log.length = 0;
  s.say('one', { final: true });
  s.say('two', { final: true });
  await wait(50);
  s.destroy();
  await wait(LINE_MS * 3);
  assert.deepEqual(log, ['one']);
});
