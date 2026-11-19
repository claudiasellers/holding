// "Brain" helpers: which provider writes the parent's words, in plain language,
// plus one-tap ways to turn the AI on. Shared by the session screen, Home and Settings.
import { store } from '../store.js';
import { getLLMProvider } from './providers.js';

export const HOLDING_LOCAL_URL = 'http://127.0.0.1:8787/v1';

/** True when the parent is using scripted lines only (nothing reads the user's words). */
export function isScripted(settings = store.settings) {
  return !settings.ai?.provider || settings.ai.provider === 'scripted';
}

/** Short human label for the active brain. */
export function brainLabel(providerId = store.settings.ai?.provider) {
  switch (providerId) {
    case 'webllm': return 'AI on this device';
    case 'openai-local': return /:8787/.test(store.settings.ai?.['openai-local']?.baseUrl || '') ? 'AI on your computer (Holding Local)' : 'AI on your computer';
    case 'holding-rag': return 'AI on your computer (companion)';
    default: return 'Scripted lines';
  }
}

/** Can this browser run the in-browser model at all? (cheap check, no download) */
export function canUseDeviceAI() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/** Switch to the in-browser model (automatic size). Does not download yet. */
export function useDeviceAI() {
  store.setSettings({ ai: { provider: 'webllm', webllm: { ...(store.settings.ai?.webllm || {}), model: store.settings.ai?.webllm?.model || 'auto' } } });
}

/**
 * Point words, voice and listening at Holding Local. Throws with a readable
 * message when the server can't be reached.
 */
export async function connectHoldingLocal(baseUrl = '', token = '') {
  const S = store.settings;
  baseUrl = String(baseUrl || ((S.ai?.['openai-local']?.baseUrl || '').includes(':8787') ? S.ai['openai-local'].baseUrl : (typeof location !== 'undefined' && location.port === '8787' ? `${location.origin}/v1` : HOLDING_LOCAL_URL))).trim().replace(/\/$/, '');
  token = String(token || S.ai?.['openai-local']?.token || '').trim();
  let r;
  try {
    r = await fetch(baseUrl.replace(/\/v1$/, '') + '/health', { signal: AbortSignal.timeout(3000), headers: token ? { Authorization: `Bearer ${token}`, 'X-Pair-Token': token } : {} });
  } catch (e) {
    throw new Error(`Couldn't reach Holding Local at ${baseUrl} (${e.message}). Is it running? From a phone, use the address and code it shows.`);
  }
  if (!r.ok) throw new Error(`Holding Local at ${baseUrl} answered ${r.status}.`);
  const prev = S.ai?.['openai-local'] || {};
  store.setSettings({
    ai: { provider: 'openai-local', 'openai-local': { ...prev, baseUrl, apiKey: token, token, model: prev.model && !/^llama3\.2/.test(prev.model) ? prev.model : 'gemma4:e4b' } },
    tts: { provider: 'openai-speech', 'openai-speech': { baseUrl, token, model: 'kokoro' } },
    stt: { provider: 'server', baseUrl, token },
  });
  return baseUrl;
}

export function providerLabel(id) { return getLLMProvider(id)?.label || id; }
