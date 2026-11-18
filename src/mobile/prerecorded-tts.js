// Prerecorded voice for scripted lines, plus the iPhone audio unlock.
//
// createPrerecordedTTS(fallback) returns a TTSProvider (same contract as src/voice/providers.js):
// when the text matches a line rendered by scripts/prerender-voice.mjs, it plays the file at once,
// offline and in the same voice every time; otherwise it hands the text to `fallback`.
//
// unlockAudio() must run inside the first tap (the "I'm here" button). iOS refuses audio until a
// gesture, and Web Audio follows the ring/silent switch unless the audio session is "playback".

let ctx = null;
let indexPromise = null;
let textMap = null; // normalised text -> { src, archetype, id }
const bufferCache = new Map();

export function getAudioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  return ctx;
}

/** Call synchronously inside a user gesture handler, before anything async. */
export function unlockAudio() {
  try {
    // Safari 17+: play even when the phone's silent switch is on (this is a voice app, not a game sound).
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (_) {}
  const c = getAudioContext();
  if (c.state !== 'running') c.resume();
  // A one-sample silent buffer started inside the gesture fully unlocks older iOS versions.
  const b = c.createBuffer(1, 1, 22050);
  const s = c.createBufferSource();
  s.buffer = b; s.connect(c.destination); s.start(0);
  // Also prime speechSynthesis on iOS so a Web Speech fallback can speak later without a new tap.
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch (_) {}
  return c;
}

const norm = (t) => String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

export async function loadAudioIndex(base = 'audio/index.json') {
  if (!indexPromise) {
    indexPromise = fetch(base).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  }
  const index = await indexPromise;
  if (!textMap) {
    textMap = new Map();
    for (const [archetype, lines] of Object.entries(index)) {
      for (const [id, entry] of Object.entries(lines)) {
        if (entry && entry.text) textMap.set(archetype + '\u0000' + norm(entry.text), { ...entry, archetype, id });
        if (entry && entry.text && !textMap.has('*\u0000' + norm(entry.text))) textMap.set('*\u0000' + norm(entry.text), { ...entry, archetype, id });
      }
    }
  }
  return index;
}

/** Find a prerecorded file for this text (optionally for one archetype). */
export async function findRecording(text, archetype) {
  await loadAudioIndex();
  return (archetype && textMap.get(archetype + '\u0000' + norm(text))) || textMap.get('*\u0000' + norm(text)) || null;
}

/** Ask the service worker to keep one archetype's recordings offline. */
export async function cacheArchetypeAudio(archetype) {
  const index = await loadAudioIndex();
  const urls = Object.values(index[archetype] || {}).map((e) => e.src);
  if (urls.length && window.HoldingMobile) await window.HoldingMobile.cacheAudio(urls);
  return urls.length;
}

async function decode(src) {
  if (bufferCache.has(src)) return bufferCache.get(src);
  const p = fetch(src)
    .then((r) => { if (!r.ok) throw new Error('audio ' + r.status); return r.arrayBuffer(); })
    .then((ab) => new Promise((res, rej) => getAudioContext().decodeAudioData(ab, res, rej)));
  bufferCache.set(src, p);
  p.catch(() => bufferCache.delete(src));
  return p;
}

/** Play a decoded file through Web Audio, reporting loudness (0..1) for face and mouth sync. */
export async function playFile(src, { rate = 1, onStart, onEnd, onLevel, signal } = {}) {
  const c = getAudioContext();
  if (c.state !== 'running') {
    await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    if (c.state !== 'running') throw new Error('audio locked: call unlockAudio() from a tap first');
  }
  const buffer = await decode(src);
  if (signal && signal.aborted) return;
  const node = c.createBufferSource();
  node.buffer = buffer;
  node.playbackRate.value = rate;
  const analyser = c.createAnalyser();
  analyser.fftSize = 512;
  node.connect(analyser);
  analyser.connect(c.destination);
  const data = new Float32Array(analyser.fftSize);
  let raf = 0;
  const meter = () => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    if (onLevel) onLevel(Math.min(1, rms * 4));
    raf = requestAnimationFrame(meter);
  };
  return new Promise((resolve) => {
    let done = false;
    let watchdog = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      cancelAnimationFrame(raf);
      if (onLevel) onLevel(0);
      try { node.disconnect(); analyser.disconnect(); } catch (_) {}
      if (onEnd) onEnd();
      resolve();
    };
    node.onended = finish;
    if (signal) signal.addEventListener('abort', () => { try { node.stop(); } catch (_) {} finish(); }, { once: true });
    node.start();
    // onended can go missing on iOS when a call or Siri interrupts audio; never leave the session hanging.
    watchdog = setTimeout(finish, (buffer.duration / rate) * 1000 + 1500);
    if (onStart) onStart();
    if (onLevel) meter();
  });
}

/**
 * Wrap the active TTS provider so known scripted lines play from recordings.
 * @param {object} fallback  a TTSProvider ({ speak(text, opts) })
 * @param {{archetype?: () => string}} [opts]
 */
export function createPrerecordedTTS(fallback, { archetype } = {}) {
  return {
    id: 'prerecorded',
    label: 'Recorded voice for scripted lines',
    local: true,
    isAvailable: async () => true,
    init: async (cfg, onProgress) => {
      await loadAudioIndex();
      if (fallback && fallback.init) await fallback.init(cfg, onProgress);
    },
    async speak(text, opts = {}) {
      const hit = await findRecording(text, archetype ? archetype() : opts.archetype);
      if (hit) {
        try {
          return await playFile(hit.src, { rate: opts.rate || 1, onStart: opts.onStart, onEnd: opts.onEnd, onLevel: opts.onLevel, signal: opts.signal });
        } catch (err) {
          console.warn('[holding] recording failed, using live voice', err);
        }
      }
      if (fallback) return fallback.speak(text, opts);
      if (opts.onEnd) opts.onEnd();
    },
    stop() { if (fallback && fallback.stop) fallback.stop(); },
  };
}

/** Object the core session uses: HoldingMobile.prerecorded.has(archetypeId, text) / play(...). */
export const prerecorded = {
  async has(archetypeId, text) { return !!(await findRecording(text, archetypeId)); },
  async play(archetypeId, text, opts = {}) {
    const hit = await findRecording(text, archetypeId);
    if (!hit) throw new Error('no recording');
    return playFile(hit.src, opts);
  },
  cacheArchetype: cacheArchetypeAudio,
  unlock: unlockAudio,
  load: loadAudioIndex,
};
