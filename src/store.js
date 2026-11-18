// Everything stays on this device. One localStorage namespace; export + wipe.
const KEY = 'holding.settings.v1';
const DATA = 'holding.data.v1';

export const DEFAULT_SETTINGS = {
  userName: '',
  warmth: null,              // null = use archetype default; user-set dose 0..1
  voiceOn: true, captions: true, breathPacer: false, reducedMotion: null,
  camera: false,             // opt-in on-device mirroring from the camera
  endearments: true,
  safetyContact: { name: '', phone: '' },
  ai: { provider: 'scripted', webllm: {}, 'openai-local': {}, 'holding-rag': {} },
  tts: { provider: 'webspeech', voiceId: '', webspeech: {}, kokoro: {}, 'openai-speech': {} },
  stt: { provider: 'browser' },
  debugTuning: false,
};

const safeGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

function merge(d, s) {
  if (!s || typeof s !== 'object') return d;
  const o = Array.isArray(d) ? [...d] : { ...d };
  for (const k in s) o[k] = d && typeof d[k] === 'object' && d[k] && !Array.isArray(d[k]) ? merge(d[k], s[k]) : s[k];
  return o;
}

let settings = merge(DEFAULT_SETTINGS, safeGet(KEY));
let data = merge({ archetype: null, saved: [], keepsakes: [], repairs: [], episodes: [], rules: [] }, safeGet(DATA));
const subs = new Set();

export const store = {
  get settings() { return settings; },
  get data() { return data; },
  setSettings(patch) { settings = merge(settings, patch); safeSet(KEY, settings); subs.forEach((f) => f('settings')); },
  setData(patch) { data = { ...data, ...patch }; safeSet(DATA, data); subs.forEach((f) => f('data')); },
  push(list, item, max = 500) { const arr = [...(data[list] || []), { ...item, at: Date.now() }].slice(-max); this.setData({ [list]: arr }); },
  remove(list, idx) { const arr = [...data[list]]; arr.splice(idx, 1); this.setData({ [list]: arr }); },
  on(f) { subs.add(f); return () => subs.delete(f); },
  exportAll() { return JSON.stringify({ exported: new Date().toISOString(), settings, data }, null, 2); },
  wipe() { try { localStorage.removeItem(KEY); localStorage.removeItem(DATA); } catch {} settings = merge(DEFAULT_SETTINGS, null); data = { archetype: null, saved: [], keepsakes: [], repairs: [], episodes: [], rules: [] }; subs.forEach((f) => f('wipe')); },
  warmthFor(arch) { return settings.warmth ?? arch?.stance?.warmth ?? .5; },
};
