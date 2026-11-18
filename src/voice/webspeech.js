// Web Speech API provider: the operating system's own voices. Free, no download,
// and on-device on iOS, macOS, most Android builds and Windows (some "online"
// voices in Chrome/Edge are cloud voices; pickVoice prefers local ones).
import { registerTTSProvider } from './providers.js';

const synth = () => (typeof window !== 'undefined' && window.speechSynthesis) || null;
const PHRASE_GAP_MS = 700;      // "…" in a line = a deliberate silence
const MAX_UTTERANCE_CHARS = 160; // Chrome can silently stop long utterances (~15 s)

/** Common voice names by gender across Apple, Google, Microsoft, Android, eSpeak. */
const FEMALE = ['samantha', 'karen', 'moira', 'tessa', 'fiona', 'victoria', 'allison', 'ava', 'susan', 'serena', 'kate', 'zoe', 'nicky', 'joelle', 'catherine',
  'google uk english female', 'google us english', 'aria', 'jenny', 'zira', 'hazel', 'libby', 'sonia', 'michelle', 'emma', 'ana', 'clara', 'natasha', 'female', 'woman'];
const MALE = ['daniel', 'alex', 'fred', 'tom', 'oliver', 'arthur', 'aaron', 'gordon', 'lee', 'rishi', 'evan', 'nathan',
  'google uk english male', 'guy', 'david', 'mark', 'george', 'ryan', 'christopher', 'eric', 'roger', 'steffan', 'william', 'brian', 'andrew', 'male', 'man'];
const NEUTRAL = ['river', 'sky', 'jamie'];
// Novelty voices that would undercut a comforting presence.
const NOVELTY = ['albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news', 'jester', 'organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox', 'deranged', 'hysterical', 'pipe organ', 'junior', 'ralph', 'kathy', 'princess', 'grandpa', 'grandma', 'eddy', 'flo', 'reed', 'rocko', 'sandy', 'shelley'];

function nameOf(v) { return String(v?.name || v?.label || '').toLowerCase(); }
function hasWord(name, w) { return new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(name); }

/** Guess 'f' | 'm' | 'n' | undefined from a voice name. */
export function guessGender(v) {
  const n = nameOf(v);
  if (/\bfemale\b/.test(n)) return 'f';
  if (/\bmale\b/.test(n)) return 'm';
  if (FEMALE.some((w) => hasWord(n, w))) return 'f';
  if (MALE.some((w) => hasWord(n, w))) return 'm';
  if (NEUTRAL.some((w) => hasWord(n, w))) return 'n';
  return undefined;
}

/**
 * Pick the best voice for an archetype.
 * @param {Array<SpeechSynthesisVoice|{id:string,label:string,lang?:string,local?:boolean,gender?:string}>} voices
 * @param {{gender?:'f'|'m'|'n', hints?:string[], lang?:string}} want
 * @returns {*} the chosen voice (same object type as given), or null
 */
export function pickVoice(voices, { gender, hints = [], lang = 'en' } = {}) {
  if (!voices || !voices.length) return null;
  const wantLang = String(lang || 'en').toLowerCase();
  let best = null; let bestScore = -Infinity;
  for (const v of voices) {
    const n = nameOf(v);
    const vl = String(v.lang || '').toLowerCase().replace('_', '-');
    let s = 0;
    if (vl === wantLang || vl.startsWith(wantLang + '-')) s += 40;
    else if (vl.split('-')[0] === wantLang.split('-')[0]) s += 30;
    else continue; // wrong language is never better than nothing in the right one
    for (const [i, h] of hints.entries()) if (h && n.includes(String(h).toLowerCase())) s += 30 - Math.min(i, 5) * 3;
    const g = v.gender || guessGender(v);
    if (gender && g) s += g === gender ? 25 : (gender === 'n' || g === 'n') ? 5 : -30;
    if (v.localService === true || v.local === true) s += 15;
    if (/natural|neural|enhanced|premium|siri/.test(n)) s += 12;
    if (/online/.test(n) && !/natural/.test(n)) s -= 4;
    if (NOVELTY.some((w) => hasWord(n, w))) s -= 60;
    if (/espeak|compact/.test(n)) s -= 8;
    if (v.default) s += 2;
    if (s > bestScore) { bestScore = s; best = v; }
  }
  return best;
}

/** Load the OS voices, waiting for the async voiceschanged event if needed. */
function getVoices(timeoutMs = 2000) {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; s.removeEventListener?.('voiceschanged', finish); clearTimeout(t); resolve(s.getVoices()); };
    const t = setTimeout(finish, timeoutMs);
    s.addEventListener?.('voiceschanged', finish);
  });
}

/** Split a line into phrases on "…" (or "..."), then into short utterances. */
export function splitPhrases(text) {
  const phrases = String(text || '').split(/\s*(?:…|\.\.\.)\s*/).map((p) => p.trim()).filter(Boolean);
  return phrases.map((p) => {
    if (p.length <= MAX_UTTERANCE_CHARS) return [p];
    const parts = p.match(/[^.!?;,]+[.!?;,]*\s*/g) || [p];
    const out = []; let cur = '';
    for (const part of parts) {
      if ((cur + part).length > MAX_UTTERANCE_CHARS && cur) { out.push(cur.trim()); cur = ''; }
      cur += part;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  });
}

/**
 * Call on the first user tap (iOS Safari will not speak until a gesture has
 * started speech once).
 */
export function unlockSpeech() {
  const s = synth();
  if (!s || typeof SpeechSynthesisUtterance === 'undefined') return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    s.speak(u);
  } catch { /* ignore */ }
}

const sleep = (ms, signal) => new Promise((r) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); r(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

let current = null; // { cancel() }

const webspeech = {
  id: 'webspeech',
  label: 'Device voices (built in, free)',
  local: true,

  async isAvailable() {
    if (!synth() || typeof SpeechSynthesisUtterance === 'undefined') return { ok: false, reason: 'This browser has no speech synthesis.' };
    const v = await getVoices(1500);
    if (!v.length) return { ok: false, reason: 'No voices are installed. Add a voice in your device settings (Accessibility / Speech, or Text-to-speech).' };
    return { ok: true };
  },

  async init() { await getVoices(); },

  async listVoices() {
    const vs = await getVoices();
    return vs.map((v) => ({ id: v.voiceURI || v.name, label: v.name + (v.localService ? '' : ' (online)'), lang: v.lang, gender: guessGender(v), local: !!v.localService }));
  },

  /**
   * @param {string} text
   * @param {{voiceId?:string, rate?:number, pitch?:number, volume?:number, onStart?:()=>void, onEnd?:()=>void, onLevel?:(l:number)=>void, signal?:AbortSignal}} opts
   */
  async speak(text, opts = {}) {
    const s = synth();
    if (!s) { opts.onStart?.(); opts.onEnd?.(); return; }
    webspeech.stop();
    const groups = splitPhrases(text);
    if (!groups.length) return;

    const voices = await getVoices();
    const voice = opts.voiceId ? voices.find((v) => v.voiceURI === opts.voiceId || v.name === opts.voiceId) : null;
    const rate = clampNum(opts.rate ?? 1, 0.5, 1.5);
    const pitch = clampNum(opts.pitch ?? 1, 0.5, 1.5);
    const volume = clampNum(opts.volume ?? 1, 0, 1);

    const ctrl = new AbortController();
    const signal = ctrl.signal;
    const outer = opts.signal;
    const onOuterAbort = () => ctrl.abort();
    if (outer?.aborted) return;
    outer?.addEventListener('abort', onOuterAbort, { once: true });

    // Simulated mouth level: Web Speech gives no audio, so oscillate at a
    // syllable-ish rate (~4-5 Hz scaled by rate) while speaking, boosted on word boundaries.
    let speaking = false; let boost = 0; let phase = Math.random() * 6;
    const levelTimer = opts.onLevel ? setInterval(() => {
      if (!speaking) { opts.onLevel(0); return; }
      phase += (2 * Math.PI * 4.5 * rate) / 30;
      boost *= 0.82;
      const syll = Math.pow(Math.abs(Math.sin(phase)), 0.8);
      const jitter = 0.85 + Math.random() * 0.3;
      opts.onLevel(Math.min(1, (0.15 + 0.55 * syll) * jitter + boost * 0.45));
    }, 33) : null;

    let started = false;
    const me = { cancel: () => ctrl.abort() };
    current = me;
    signal.addEventListener('abort', () => { try { s.cancel(); } catch { /* ignore */ } }, { once: true });

    try {
      for (let gi = 0; gi < groups.length && !signal.aborted; gi++) {
        if (gi > 0) await sleep(PHRASE_GAP_MS, signal);
        for (const chunk of groups[gi]) {
          if (signal.aborted) break;
          await new Promise((resolve) => {
            const u = new SpeechSynthesisUtterance(chunk);
            if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
            u.rate = rate; u.pitch = pitch; u.volume = volume;
            let finished = false;
            // Watchdog: some engines drop onend (Chrome, Android). Estimate the
            // duration generously and move on if no event arrives.
            const est = 2500 + (chunk.length * 85) / rate;
            const wd = setTimeout(() => fin(), est);
            function fin() {
              if (finished) return; finished = true; speaking = false; clearTimeout(wd);
              signal.removeEventListener('abort', fin); resolve();
            }
            u.onstart = () => { speaking = true; boost = 0.6; if (!started) { started = true; opts.onStart?.(); } };
            u.onboundary = () => { boost = 1; };
            u.onend = fin;
            u.onerror = fin; // 'interrupted' / 'canceled' land here too
            signal.addEventListener('abort', fin, { once: true });
            try { s.speak(u); } catch { fin(); }
            // Chrome sometimes leaves the queue paused after a cancel.
            if (s.paused) try { s.resume(); } catch { /* ignore */ }
          });
        }
      }
    } finally {
      speaking = false;
      if (levelTimer) { clearInterval(levelTimer); opts.onLevel?.(0); }
      outer?.removeEventListener?.('abort', onOuterAbort);
      if (current === me) current = null;
      opts.onEnd?.();
    }
  },

  stop() {
    if (current) { const c = current; current = null; c.cancel(); }
    try { synth()?.cancel(); } catch { /* ignore */ }
  },
};

function clampNum(v, lo, hi) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }

registerTTSProvider(webspeech);
export default webspeech;
