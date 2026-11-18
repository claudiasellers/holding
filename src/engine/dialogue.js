// Session orchestrator: presence state -> turn policy -> (local model | script)
// -> guard -> face + voice + caption. Also runs "parent speaks first" autoplay.
import { policyFor, beat } from './policy.js';
import { guard } from './guard.js';
import { readText } from './affect.js';
import { buildSystemPrompt } from './prompt.js';
import { pick, getPath, fill } from './scripts.js';
import { getLLMProvider } from '../ai/providers.js';
import { getTTSProvider } from '../voice/providers.js';
import { store } from '../store.js';
import { voiceFor } from '../voice/resolve.js';

const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

const MAKESENSE_STEPS = [0, 2, 3, 4, 5, 7, 11, 15];

export function createSession({ archetype, presence, ui, mode = 'hold' }) {
  const s = store.settings;
  const state = {
    mode, tier: mode === 'makesense' ? 'makesense' : mode === 'talk' ? 'ordinary' : 'bewith',
    affect: null, intensity: 0, lead: mode === 'hold', ended: false,
    lastInputAt: 0, startedAt: Date.now(), said: [], history: [], misses: 0,
    offeredWordsBack: false, safety: false, msStep: 0, lastReplyKind: '',
    entryDistress: null, bodyBudgetDone: false,
  };
  const ctrl = new AbortController();
  let speaking = null;              // AbortController for current speech
  let speakQueue = Promise.resolve();
  let modelReady = false, modelErr = null;
  const ctx = () => ({
    endearment: s.endearments ? (archetype.lexicon.endearments[0] || '') : '',
    userName: s.userName, warmth: store.warmthFor(archetype), allowSignature: true,
  });

  // ---------- model ----------
  const providerId = s.ai.provider || 'scripted';
  const provider = getLLMProvider(providerId);
  async function prepareModel() {
    if (!provider || providerId === 'scripted') return;
    try {
      const av = await provider.isAvailable(s.ai[providerId] || {});
      if (!av.ok) throw new Error(av.reason || 'not available');
      await provider.init(s.ai[providerId] || {}, (p) => ui.onModelProgress?.(p));
      modelReady = true; ui.onModelProgress?.({ text: 'ready', progress: 1 });
    } catch (e) {
      modelErr = e; modelReady = false;
      ui.onModelProgress?.({ text: `Using scripted lines (${e.message || e})`, progress: 1, error: true });
    }
  }
  if (providerId !== 'scripted') prepareModel();

  async function generate(policy) {
    if (!modelReady) return null;
    const system = buildSystemPrompt(archetype, policy, { userName: s.userName, memory: memoryLine() });
    const messages = state.history.slice(-12);
    const timeout = policy.tier === 'bewith' ? 7000 : 25000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const text = await provider.generate({ system, messages, maxTokens: policy.maxTokens, temperature: policy.temperature, archetype, signal: ac.signal });
      const g = guard(text, policy);
      if (!g.ok) { console.info('[holding] model reply rejected:', g.reasons, text); return null; }
      return g.text;
    } catch (e) {
      console.info('[holding] model failed, using script:', e?.message);
      return null;
    } finally { clearTimeout(timer); }
  }

  function memoryLine() {
    const eps = store.data.episodes.filter((e) => e.archetype === archetype.id);
    const parts = [];
    if (eps.length) {
      const last = eps[eps.length - 1];
      const days = Math.round((Date.now() - last.at) / 864e5);
      parts.push(`You have been through ${eps.length} hard moment${eps.length > 1 ? 's' : ''} together; the last was ${days === 0 ? 'earlier today' : days === 1 ? 'yesterday' : `${days} days ago`}.`);
    }
    const k = store.data.keepsakes.slice(-2).map((x) => `"${x.text}"`).join(' and ');
    if (k) parts.push(`Lines that helped before: ${k}.`);
    const r = store.data.rules.slice(-1)[0];
    if (r) parts.push(`Their new rule: "${r.text}".`);
    return parts.join(' ');
  }

  // ---------- voice ----------
  function say(text, meta = {}) {
    if (!text || state.ended && !meta.final) return Promise.resolve();
    const policy = policyFor(meta.tier || state.tier, store.warmthFor(archetype));
    state.said.push(text);
    state.history.push({ role: 'assistant', content: text });
    state.lastReplyKind = meta.kind || '';
    speakQueue = speakQueue.then(() => speakNow(text, policy, meta));
    return speakQueue;
  }

  async function speakNow(text, policy, meta) {
    if (state.ended && !meta.final) return;
    ui.onSay?.(text, meta);
    presence.setOwn('speaking');
    const tts = getTTSProvider(s.tts.provider) || getTTSProvider('webspeech');
    const voiceId = await voiceFor(tts?.id, archetype).catch(() => undefined);
    speaking = new AbortController();
    const done = () => { presence.setSpeaking(0); presence.setOwn(state.lead ? 'holding' : 'listening'); ui.onSpeakEnd?.(); };
    const pre = typeof window !== 'undefined' ? window.HoldingMobile?.prerecorded : null;
    if (s.voiceOn && pre?.has && await Promise.resolve(pre.has(archetype.id, text)).catch(() => false)) {
      try { await pre.play(archetype.id, text, { onLevel: (l) => presence.setSpeaking(l), signal: speaking.signal }); done(); return; } catch { /* fall through to live voice */ }
    }
    if (!s.voiceOn || !tts) {
      // captions only: hold the line on screen for a reading beat
      await sleep(Math.max(1600, text.length * 55), speaking.signal); done(); return;
    }
    try {
      await tts.speak(text, {
        voiceId,
        rate: archetype.voice.rate * policy.rate,
        pitch: archetype.voice.pitch * policy.pitch,
        archetype,
        onLevel: (l) => presence.setSpeaking(l),
        signal: speaking.signal,
      });
    } catch (e) {
      console.info('[holding] tts failed:', e?.message);
      if (s.tts.provider !== 'webspeech') {
        try { await getTTSProvider('webspeech')?.speak(text, { voiceId: await voiceFor('webspeech', archetype).catch(() => undefined), rate: archetype.voice.rate * policy.rate, pitch: archetype.voice.pitch * policy.pitch, onLevel: (l) => presence.setSpeaking(l), signal: speaking.signal }); } catch {}
      } else await sleep(Math.max(1400, text.length * 50), speaking.signal);
    }
    done();
  }

  function stopSpeaking() { speaking?.abort(); getTTSProvider(s.tts.provider)?.stop?.(); getTTSProvider('webspeech')?.stop?.(); }

  // ---------- replies ----------
  async function reply(kind, opts = {}) {
    const policy = policyFor(opts.tier || state.tier, store.warmthFor(archetype));
    await sleep(opts.immediate ? 0 : beat(policy), ctrl.signal);
    if (state.ended && !opts.final) return;
    let text = null;
    if (opts.allowModel && kind !== 'safety') text = await generate(policy);
    if (!text) text = scriptFor(kind, policy, opts);
    const g = guard(text, policy);
    return say(g.text || text, { kind, tier: policy.tier, final: opts.final });
  }

  function scriptFor(kind, policy, opts) {
    const c = ctx();
    const a = state.affect;
    switch (kind) {
      case 'affect':
        if (a && getPath(`affect.${a}.${policy.tier === 'bewith' ? 'bewith' : 'name'}`)) return pick(`affect.${a}.${policy.tier === 'bewith' ? 'bewith' : 'name'}`, archetype, c);
        return pick(policy.tier === 'bewith' ? 'permission' : 'fallback', archetype, c);
      case 'repair': return pick('repair', archetype, { ...c, miss: opts.miss });
      case 'makesense': {
        const i = MAKESENSE_STEPS[Math.min(state.msStep, MAKESENSE_STEPS.length - 1)];
        state.msStep++;
        const l = getPath('makesense')[i];
        return l ? fill(l.t, c) : pick('makesense', archetype, c);
      }
      case 'ordinary': return pick(opts.slot ? `ordinary.${opts.slot}` : 'ordinary.general', archetype, c);
      default: return pick(kind, archetype, c);
    }
  }

  // ---------- inputs ----------
  async function onTile(affect, intensity = .85) {
    state.lastInputAt = Date.now();
    if (state.ended) return;
    if (affect === 'stay') { presence.setOwn('holding'); return reply('stillHere'); }
    state.affect = affect; state.intensity = intensity;
    state.history.push({ role: 'user', content: `[tapped: ${affect}]` });
    presence.mirror(affect, intensity);
    ui.onMirror?.(affect);
    if (affect === 'numb') return reply('orient');
    return reply('affect', { allowModel: false });
  }

  async function onText(text) {
    text = String(text || '').trim();
    if (!text || state.ended) return;
    state.lastInputAt = Date.now();
    state.history.push({ role: 'user', content: text });
    stopSpeaking();
    const r = readText(text);
    if (r.risk) return enterSafety();
    if (r.affect) { state.affect = r.affect; state.intensity = r.intensity; presence.mirror(r.affect, r.intensity); ui.onMirror?.(r.affect); }
    else presence.setOwn('listening');

    if (state.mode === 'makesense') return reply('makesense', { allowModel: true });
    if (r.intents.roleReversal) return reply('roleReversal');
    if (r.intents.tooMuch) return reply('tooMuch');
    if (r.intents.angerAtCoach) return reply('angerAtCoach');
    if (r.intents.critic) return reply('critic');
    if (r.intents.done && state.tier !== 'bewith') return end();

    if (state.tier === 'bewith' && r.wordsBack && !state.offeredWordsBack) {
      state.offeredWordsBack = true;
      ui.onWordsBack?.();
      return reply('wordsBack');
    }
    if (state.tier === 'bewith') return reply('affect', { allowModel: true });
    if (state.tier === 'name' && !state.bodyBudgetDone && state.history.filter((h) => h.role === 'user').length >= 3) {
      state.bodyBudgetDone = true; return reply('bodyBudget', { allowModel: false });
    }
    return reply(state.tier === 'ordinary' ? 'ordinary' : 'affect', { allowModel: true });
  }

  function chooseWordsBack(choice) {
    state.lastInputAt = Date.now();
    if (choice === 'tell') { state.tier = 'name'; state.lead = false; ui.onTier?.('name'); return say(fill('I\'m listening. Take your time.', ctx()), { kind: 'wordsBack', tier: 'name' }); }
    return reply('stillHere');
  }

  function onMiss() {
    state.misses++;
    stopSpeaking();
    presence.setOwn('listening');
    const last = state.said[state.said.length - 1] || '';
    const miss = /\?$/.test(last) ? 'asked you something when you needed me to just stay'
      : state.lastReplyKind === 'affect' && state.tier === 'name' ? 'jumped to naming it before I really heard you'
      : state.tier === 'bewith' ? 'said more than you needed' : 'moved too fast';
    store.push('repairs', { archetype: archetype.id, miss, line: last, tier: state.tier });
    return reply('repair', { miss, immediate: true });
  }

  function enterSafety() {
    state.safety = true; state.lead = true;
    stopSpeaking();
    presence.mirror('scared', .5);
    ui.onSafety?.(true);
    reply('safety.ask', { immediate: true });
  }
  function safetyStay() { return reply('safety.stay', { immediate: true }); }
  function exitSafety() { state.safety = false; ui.onSafety?.(false); return reply('stillHere'); }

  // ---------- parent speaks first ----------
  async function autoplay() {
    let i = 0;
    while (!ctrl.signal.aborted && !state.ended) {
      const elapsed = (Date.now() - state.startedAt) / 1000;
      const pace = archetype.stance.pace ?? .3;   // 0 slow
      const quiet = (Date.now() - state.lastInputAt) / 1000;
      let gap = i === 0 ? 0 : i === 1 ? 8 + pace * 6 : elapsed < 120 ? 16 + Math.random() * 12 : elapsed < 480 ? 24 + Math.random() * 14 : 45 + Math.random() * 25;
      gap *= 1.25 - pace * .5;
      await sleep(gap * 1000, ctrl.signal);
      await speakQueue;
      if (ctrl.signal.aborted || state.ended) break;
      if (!state.lead) { await sleep(2000, ctrl.signal); continue; }
      if (quiet < 14) { await sleep(4000, ctrl.signal); continue; }   // user is engaging: let contingent replies lead
      if (state.safety) { await reply('safety.stay', { immediate: true }); i++; continue; }
      const kind = nextAuto(i, elapsed);
      if (kind) await reply(kind, { immediate: i === 0 });
      i++;
    }
  }
  function nextAuto(i, elapsed) {
    if (i === 0) return 'opening';
    if (i === 1) return 'permission';
    if (i === 3) return 'selfTouch';
    if (state.affect === 'numb' && i % 3 === 0) return 'orient';
    if (!state.bodyBudgetDone && elapsed > 300) { state.bodyBudgetDone = true; return 'bodyBudget'; }
    if (s.breathPacer && i % 5 === 4) return 'breath';
    const cycle = state.affect ? ['stillHere', 'affect', 'permission', 'stillHere'] : ['stillHere', 'permission', 'stillHere', 'selfTouch', 'stillHere', 'permission'];
    return cycle[i % cycle.length];
  }

  // ---------- lifecycle ----------
  function start() {
    if (state.mode === 'hold') autoplay();
    else if (state.mode === 'makesense') reply('makesense', { immediate: true });
    else {
      const h = new Date().getHours();
      reply('ordinary', { immediate: true, slot: h < 12 ? 'morning' : h >= 18 ? 'evening' : 'general' });
    }
  }

  async function end() {
    if (state.ended) return;
    state.lead = false;
    stopSpeaking();
    await sleep(200);
    presence.setOwn('delight');
    const policy = policyFor('name', store.warmthFor(archetype));
    const c = ctx();
    const closing = guard(pick('close', archetype, c), policy).text;
    const meta = guard(pick('metaprocess', archetype, c), policy).text;
    state.ended = true;
    ctrl.abort();
    store.push('episodes', { archetype: archetype.id, mode: state.mode, minutes: Math.round((Date.now() - state.startedAt) / 6e4), affect: state.affect, misses: state.misses });
    ui.onEnd?.({ said: [...new Set(state.said)], closing, meta });
    await say(closing, { kind: 'close', final: true, tier: 'name' });
    await sleep(900);
    await say(meta, { kind: 'metaprocess', final: true, tier: 'name' });
    presence.setOwn('holding');
  }

  function destroy() { state.ended = true; ctrl.abort(); stopSpeaking(); }

  return {
    state, start, end, destroy, onTile, onText, onMiss, chooseWordsBack,
    enterSafety, safetyStay, exitSafety, say, stopSpeaking,
    setLead(v) { state.lead = v; if (v) state.lastInputAt = 0; },
    get modelReady() { return modelReady; }, get modelError() { return modelErr; },
  };
}
