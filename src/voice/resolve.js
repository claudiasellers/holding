// Pick the voice for an archetype on the active TTS provider.
import { pickVoice } from './webspeech.js';

let cache = null, cachedAt = 0;
async function webVoices() {
  if (cache && (cache.length || Date.now() - cachedAt < 30000)) return cache;
  const s = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  if (!s) return [];
  let v = s.getVoices();
  if (!v.length) await new Promise((r) => { const t = setTimeout(r, 1200); s.addEventListener?.('voiceschanged', () => { clearTimeout(t); r(); }, { once: true }); });
  cache = s.getVoices(); cachedAt = Date.now();
  return cache;
}

export async function voiceFor(providerId, archetype) {
  const v = archetype.voice || {};
  if (providerId === 'kokoro' || providerId === 'openai-speech') return v.kokoro || (v.gender === 'm' ? 'am_michael' : 'af_heart');
  if (v.voiceName) return v.voiceName;
  const voices = await webVoices();
  const best = pickVoice(voices, { gender: v.gender === 'n' ? undefined : v.gender, hints: v.hints || [], lang: 'en' });
  return best ? (best.voiceURI || best.name) : undefined;
}
