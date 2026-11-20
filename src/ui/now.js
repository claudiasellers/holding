// Settings → Right now: what writes the parent's words, what speaks, and what listens,
// checked against reality rather than only the saved choice. If Holding Local is chosen
// but not answering, it says so, and says what the parent is doing instead.
import { h } from './dom.js';
import { store } from '../store.js';
import { getLLMProvider } from '../ai/providers.js';
import { WEBLLM_MODELS, DEFAULT_WEBLLM_MODEL, cachedBrowserModels } from '../ai/webllm.js';
import { canUseDeviceAI } from '../ai/brain.js';
import { modelForProvider, cachedSize } from '../voice/models.js';

export const isLocalUrl = (u = '') => /:8787(\/|$)/.test(u);
/** A Holding Local connection: the default port on this computer, or a phone paired with one. */
export const isHoldingLocal = (cfg = {}) => isLocalUrl(cfg.baseUrl) || !!(cfg.baseUrl && cfg.pairedAt);

/** Is Holding Local (or another server) answering at this /v1 address? */
export async function serverUp(baseUrl, token) {
  if (!baseUrl) return false;
  try {
    const r = await fetch(String(baseUrl).replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(2500), headers: token ? { Authorization: `Bearer ${token}`, 'X-Pair-Token': token } : {} });
    return r.ok;
  } catch { return false; }
}

const VOICE_NAMES = { webspeech: 'Device voice', kokoro: 'Kokoro', chatterbox: 'Chatterbox', 'chatterbox-turbo': 'Chatterbox Turbo', 'openai-speech': 'Voice from your computer' };

/**
 * Words: { value, detail, state } where state is 'live' (an AI is writing), 'plain'
 * (hand-written lines by choice) or 'warn' (an AI is chosen but can't run right now).
 */
export async function wordsStatus(S = store.settings) {
  const id = S.ai?.provider || 'scripted';
  if (id === 'scripted') return { value: 'Hand-written lines', detail: 'You chose these. They\'re picked by feeling and don\'t follow what you type.', state: 'plain' };
  if (id === 'webllm') {
    const cfg = S.ai.webllm || {};
    const m = WEBLLM_MODELS.find((x) => x.id === (cfg.model || DEFAULT_WEBLLM_MODEL));
    if (!canUseDeviceAI()) return { value: 'Hand-written lines', detail: 'You chose the AI on this device, but this browser can\'t run it.', state: 'warn' };
    // Read the cache directly: loading the WebLLM library just to ask would be a big download.
    const want = cfg.model || DEFAULT_WEBLLM_MODEL;
    const have = await cachedBrowserModels().catch(() => []);
    const cached = want === 'auto' ? have.length > 0 : have.some((x) => x.id === want);
    if (!cached) return { value: 'AI on this device', detail: 'Not downloaded yet. It downloads the first time you talk, and hand-written lines answer until it\'s ready.', state: 'warn' };
    return { value: 'AI on this device', detail: m && m.id !== 'auto' ? `${m.label}, in this browser.` : 'In this browser, sized to this device.', state: 'live' };
  }
  const cfg = S.ai[id] || {};
  const local = isHoldingLocal(cfg);
  const name = local ? 'Holding Local' : 'your server';
  const up = local ? await serverUp(cfg.baseUrl, cfg.token) : (await getLLMProvider(id)?.isAvailable(cfg).catch(() => ({ ok: false })))?.ok;
  if (!up) return { value: 'Hand-written lines', detail: `You chose ${name}, but it isn't answering, so hand-written lines answer for now.`, state: 'warn' };
  return { value: local ? 'AI on your computer' : 'Your own server', detail: `${cfg.model || 'The model your computer picked'}, through ${name}.`, state: 'live' };
}

export async function voiceStatus(S = store.settings, arch = store.data.archetype) {
  if (!S.voiceOn) return { value: 'Off', detail: 'Lines are shown, not spoken.', state: 'plain' };
  const id = S.tts?.provider || 'webspeech';
  if (id === 'webspeech') return { value: 'Device voice', detail: `Built into this ${/iPhone|iPad|Android/i.test(navigator.userAgent) ? 'phone' : 'device'}. Nothing to download.`, state: 'plain' };
  if (id === 'openai-speech') {
    const cfg = S.tts['openai-speech'] || {};
    if (!(await serverUp(cfg.baseUrl, cfg.token))) return { value: 'Voice from your computer', detail: 'Your computer isn\'t answering right now.', state: 'warn' };
    return { value: 'Voice from your computer', detail: `${cfg.model ? cfg.model[0].toUpperCase() + cfg.model.slice(1) : 'Kokoro'}, through Holding Local.`, state: 'live' };
  }
  const m = modelForProvider(id);
  const have = m ? (await cachedSize(m)).bytes > m.sizeMB * 1e6 * 0.5 : true;
  if (!have) return { value: VOICE_NAMES[id] || id, detail: 'Not downloaded yet. Download it under Voice.', state: 'warn' };
  return { value: VOICE_NAMES[id] || id, detail: 'Downloaded in this browser.', state: 'live' };
}

export async function listenStatus(S = store.settings) {
  const id = S.stt?.provider || 'browser';
  if (id === 'off') return { value: 'Off', detail: 'The microphone button is hidden.', state: 'plain' };
  if (id === 'server') {
    if (!(await serverUp(S.stt.baseUrl, S.stt.token))) return { value: 'Your computer', detail: 'Your computer isn\'t answering right now.', state: 'warn' };
    return { value: 'Your computer', detail: 'Private: audio goes only to Holding Local.', state: 'live' };
  }
  return { value: 'Browser dictation', detail: /Chrome|Edg|Android/i.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent) ? 'In this browser, audio is sent to Google to be typed out.' : 'Safari can type it out on the device.', state: 'plain' };
}

/** The card. Renders the saved choices at once, then replaces each line with the checked truth. */
export function nowCard({ go }) {
  const row = (k, target) => {
    const v = h('b', {}, '…'); const d = h('small', {}, 'Checking…');
    const el = h('button', { class: 'rn-row', 'data-state': 'plain', onclick: () => go(target) },
      h('span', { class: 'rn-k' }, k),
      h('span', { class: 'rn-v' }, h('i', { class: 'rn-dot', 'aria-hidden': 'true' }), h('span', {}, v, d)),
      h('span', { class: 'rn-go', 'aria-hidden': 'true' }, 'Change'));
    const fill = (s) => { v.textContent = s.value; d.textContent = s.detail; el.dataset.state = s.state; el.setAttribute('aria-label', `${k}: ${s.value}. ${s.detail} Change`); };
    return { el, fill };
  };
  const w = row('Words', 'words-card'); const vo = row('Voice', 'voice-card'); const li = row('Listening', 'listen-card');
  const box = h('section', { class: 'card rn', 'aria-live': 'polite' }, h('h2', {}, 'Right now'), w.el, vo.el, li.el);
  wordsStatus().then(w.fill).catch(() => {});
  voiceStatus().then(vo.fill).catch(() => {});
  listenStatus().then(li.fill).catch(() => {});
  return box;
}
