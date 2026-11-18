// Session orchestrator: presence state -> turn policy -> (local model | script)
// -> guard -> face + voice + caption. Also runs "parent speaks first" autoplay.
import { policyFor, beat } from './policy.js';
import { guard } from './guard.js';
import { readText } from './affect.js';
import { buildSystemPrompt } from './prompt.js';
import { pick, getPath, fill } from './scripts.js';
import { nameMiss, repairLine, listenLine, reattuneLine, readCheckAnswer, missSignals, withoutNegated, breaksPromise } from './repair.js';
import { getLLMProvider } from '../ai/providers.js';
import { getTTSProvider } from '../voice/providers.js';
import { store } from '../store.js';
import { voiceFor } from '../voice/resolve.js';
import { feelingFor } from '../voice/feeling.js';
import { isExpressive } from '../voice/models.js';
import { PRESETS } from '../data/archetypes.js';

// Pre-rendered clips (phone builds) are in each preset's default voice; skip
// them once the user has picked a different voice for that figure.
function recordedVoiceMatches(archetype) {
  const p = PRESETS.find((x) => x.id === archetype.id);
  return !p || !archetype.voice?.kokoro || p.voice?.kokoro === archetype.voice.kokoro;
}

const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

// Lines that are part of a repair: they never count as "the parent's last turn".
const REPAIR_KINDS = new Set(['repair', 'repairListen']);

const MAKESENSE_STEPS = [0, 2, 3, 4, 5, 7, 11, 15];

// What the model should do for a turn the engine has classified. The scripted
// library has a hand-written line for each; these steer a generated one.
const HINTS = {
  roleReversal: 'The user is worrying about you or trying to look after you. Gently decline: this is their time and you need nothing from them.',
  tooMuch: 'The user fears they are too much. Do not agree. Make clear you are staying and they are not too much for you.',
  angerAtCoach: 'The user is angry with you. Stay steady and unhurt; do not defend yourself. Their anger is allowed here.',
  critic: 'The user is being harsh about themselves. Comfort the feeling without agreeing with the verdict.',
  wordsBack: 'Words seem to be coming back to the user. Reflect what they said, and let them know they can tell you more if they want to.',
  bodyBudget: 'Gently check one body basic (water, warmth, food or rest), tied to what they told you.',
};

export function createSession({ archetype, presence, ui, mode = 'hold' }) {
  // Read settings live, so switching the AI or voice mid-session takes effect.
  const s = new Proxy({}, { get: (_, k) => store.settings[k] });
  const state = {
    mode, tier: mode === 'makesense' ? 'makesense' : mode === 'talk' ? 'ordinary' : 'bewith',
    affect: null, intensity: 0, lead: mode === 'hold', ended: false,
    lastInputAt: 0, startedAt: Date.now(), said: [], history: [], misses: 0,
    offeredWordsBack: false, safety: false, msStep: 0, lastReplyKind: '',
    entryDistress: null, bodyBudgetDone: false,
    // repair (§7.5): the live repair, the fix it put in place, and what the
    // parent's last real turn was (the thing a repair has to name)
    repairing: null, fix: null, lastTurn: null, lastRepairAt: 0, selfRepairs: 0,
    replyDoneAt: 0, silenceChecked: 0, missesNamed: [],
  };
  const ctrl = new AbortController();
  // Aborted only when the session screen is left (destroy). Unlike state.ended,
  // nothing gets past it: not even the closing lines, which are allowed to play
  // after End but must go quiet the moment the user leaves the screen.
  const life = new AbortController();
  const gone = () => life.signal.aborted;
  let speaking = null;              // AbortController for current speech
  let speakQueue = Promise.resolve();
  let modelReady = false, modelErr = null, modelPromise = null, modelProgress = 0;
  const ctx = () => ({
    endearment: s.endearments ? (archetype.lexicon.endearments[0] || '') : '',
    userName: s.userName, warmth: store.warmthFor(archetype), allowSignature: true,
  });

  // ---------- model ("brain") ----------
  // brain: 'scripted' (no model chosen) | 'loading' | 'ready' | 'error'
  let providerId = 'scripted', provider = null, brain = 'scripted';
  let lastMiss = null;              // why the last model attempt fell back to a script
  function setBrain(b) {
    brain = b;
    ui.onBrain?.({ state: b, provider: providerId, progress: modelProgress, error: modelErr?.message || '' });
  }
  async function prepareModel() {
    const id = providerId, p = provider;
    try {
      const av = await p.isAvailable(s.ai[id] || {});
      if (!av.ok) throw new Error(av.reason || 'not available');
      await p.init(s.ai[id] || {}, (pr) => {
        if (id !== providerId) return;
        modelProgress = pr.progress || 0;
        ui.onModelProgress?.(pr);
        if (brain === 'loading') setBrain('loading');
      });
      if (id !== providerId) return;
      modelReady = true; modelErr = null; modelProgress = 1;
      ui.onModelProgress?.({ text: 'ready', progress: 1 });
      setBrain('ready');
    } catch (e) {
      if (id !== providerId) return;
      modelErr = e; modelReady = false;
      ui.onModelProgress?.({ text: `Using scripted lines (${e.message || e})`, progress: 1, error: true });
      setBrain('error');
    }
  }
  /** (Re)read the chosen provider from settings and start loading it. */
  function useProvider() {
    providerId = s.ai.provider || 'scripted';
    provider = getLLMProvider(providerId) || null;
    modelReady = false; modelErr = null; modelProgress = 0; lastMiss = null;
    if (!provider || providerId === 'scripted') { providerId = 'scripted'; modelPromise = null; setBrain('scripted'); return; }
    setBrain('loading');
    modelPromise = prepareModel();
  }

  // typed: the user just wrote something and is waiting on an answer to it, so
  // give the model more room than for an unprompted "still here" line.
  async function generate(policy, { typed = false, hint = '' } = {}) {
    if (!provider || providerId === 'scripted') { lastMiss = 'scripted'; return null; }
    if (!modelReady && typed && modelPromise) {
      await Promise.race([modelPromise, sleep(8000, ctrl.signal)]);
    }
    if (!modelReady) { lastMiss = brain === 'error' ? 'error' : 'loading'; return null; }
    const system = buildSystemPrompt(archetype, policy, { userName: s.userName, memory: memoryLine(), hint });
    const messages = state.history.slice(-12);
    const timeout = typed ? (policy.tier === 'bewith' ? 20000 : 45000) : (policy.tier === 'bewith' ? 7000 : 25000);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const text = await provider.generate({ system, messages, maxTokens: policy.maxTokens, temperature: policy.temperature, archetype, signal: ac.signal });
      const g = guard(text, policy);
      if (!g.ok) { console.info('[holding] model reply rejected:', g.reasons, text); lastMiss = 'rejected'; return null; }
      lastMiss = null;
      return g.text;
    } catch (e) {
      console.info('[holding] model failed, using script:', e?.message);
      lastMiss = ac.signal.aborted ? 'slow' : 'failed';
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
    if (!text || gone() || state.ended && !meta.final) return Promise.resolve();
    const policy = policyFor(meta.tier || state.tier, store.warmthFor(archetype));
    state.said.push(text);
    state.history.push({ role: 'assistant', content: text });
    state.lastReplyKind = meta.kind || '';
    if (!REPAIR_KINDS.has(meta.kind) && !meta.final) state.lastTurn = { text, kind: meta.kind || '', tier: meta.tier || state.tier, answeredUser: !!meta.typed, at: Date.now() };
    speakQueue = speakQueue.then(() => speakNow(text, policy, meta));
    return speakQueue;
  }

  async function speakNow(text, policy, meta) {
    if (gone() || state.ended && !meta.final) return;
    // Own controller for this line, created before any await so a stop or a
    // destroy that lands while the voice is being looked up still cancels it.
    const ac = new AbortController();
    speaking = ac;
    const signal = ac.signal;
    if (gone()) return;
    ui.onSay?.(text, meta);
    presence.setOwn('speaking');
    const tts = getTTSProvider(s.tts.provider) || getTTSProvider('webspeech');
    const voiceId = await voiceFor(tts?.id, archetype).catch(() => undefined);
    const done = () => { if (gone()) return; presence.setSpeaking(0); presence.setOwn(state.lead ? 'holding' : 'listening'); if (meta.typed) state.replyDoneAt = Date.now(); ui.onSpeakEnd?.(); };
    if (signal.aborted) return done();
    const pre = typeof window !== 'undefined' ? window.HoldingMobile?.prerecorded : null;
    const playRecorded = async () => {
      if (!(s.voiceOn && pre?.has && recordedVoiceMatches(archetype) && await Promise.resolve(pre.has(archetype.id, text)).catch(() => false))) return false;
      if (signal.aborted) return true;
      try { await pre.play(archetype.id, text, { onLevel: (l) => presence.setSpeaking(l), signal }); return true; } catch { return signal.aborted; /* fall through to live voice */ }
    };
    // Recordings are Kokoro: instant and offline, but flat. With an expressive
    // voice chosen, speak live and keep the recording only as the fallback.
    const expressive = isExpressive(tts, s.tts);
    if (!expressive && await playRecorded()) { done(); return; }
    if (signal.aborted) return done();
    if (!s.voiceOn || !tts) {
      // captions only: hold the line on screen for a reading beat
      await sleep(Math.max(1600, text.length * 55), signal); done(); return;
    }
    try {
      await tts.speak(text, {
        voiceId,
        rate: archetype.voice.rate * policy.rate,
        pitch: archetype.voice.pitch * policy.pitch,
        archetype,
        tier: policy.tier,
        feeling: feelingFor(archetype, policy.tier),
        onLevel: (l) => presence.setSpeaking(l),
        signal,
      });
    } catch (e) {
      // A stopped line often rejects (an aborted fetch, a cancelled utterance).
      // That is not a failure, so never hand it to the fallback voice.
      if (signal.aborted) return done();
      console.info('[holding] tts failed:', e?.message);
      if (expressive && await playRecorded()) { done(); return; }
      if (signal.aborted) return done();
      if (s.tts.provider !== 'webspeech') {
        try {
          const fbVoice = await voiceFor('webspeech', archetype).catch(() => undefined);
          if (!signal.aborted) await getTTSProvider('webspeech')?.speak(text, { voiceId: fbVoice, rate: archetype.voice.rate * policy.rate, pitch: archetype.voice.pitch * policy.pitch, onLevel: (l) => presence.setSpeaking(l), signal });
        } catch {}
      } else await sleep(Math.max(1400, text.length * 50), signal);
    }
    done();
  }

  function stopSpeaking() {
    speaking?.abort();
    getTTSProvider(s.tts.provider)?.stop?.();
    getTTSProvider('webspeech')?.stop?.();
  }

  // ---------- replies ----------
  async function reply(kind, opts = {}) {
    const policy = withFix(policyFor(opts.tier || state.tier, store.warmthFor(archetype)));
    await sleep(opts.immediate ? 0 : beat(policy), ctrl.signal);
    if (state.ended && !opts.final) return;
    let text = null, source = 'script';
    if (opts.allowModel && !String(kind).startsWith('safety')) {
      text = await generate(policy, { typed: !!opts.typed, hint: [opts.hint || HINTS[kind] || '', fixHint()].filter(Boolean).join(' ') });
      if (text && breaksPromise(text, state.fix)) { console.info('[holding] model reply broke the repair promise:', text); text = null; lastMiss = 'rejected'; }
      if (text) source = 'model';
      if (state.ended && !opts.final) return;
    }
    if (!text) text = scriptFor(kind, policy, opts);
    if (!REPAIR_KINDS.has(kind)) spendFix();
    const g = guard(text, policy);
    return say(g.text || text, { kind, tier: policy.tier, final: opts.final, source, typed: !!opts.typed, fallback: source === 'script' && opts.allowModel ? lastMiss : null });
  }

  function scriptFor(kind, policy, opts) {
    if (opts.line) return opts.line;
    const c = ctx();
    const a = state.affect;
    switch (kind) {
      case 'affect':
        if (a && getPath(`affect.${a}.${policy.tier === 'bewith' ? 'bewith' : 'name'}`)) return pick(`affect.${a}.${policy.tier === 'bewith' ? 'bewith' : 'name'}`, archetype, c);
        return pick(policy.tier === 'bewith' ? 'permission' : 'fallback', archetype, c);
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
    if (state.repairing) {
      // a tap while repairing is the user showing what it actually was
      finishRepair(affect === 'stay' ? 'stayed' : 'corrected', affect === 'stay' ? '' : `[tapped: ${affect}]`);
      if (affect === 'stay') return checkAnswer('stay');
    }
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
    if (r.risk) { if (state.repairing) finishRepair('safety'); return enterSafety(); }
    // (during a repair the correction is read with negations removed, below)
    if (r.affect && !state.repairing) { state.affect = r.affect; state.intensity = r.intensity; presence.mirror(r.affect, r.intensity); ui.onMirror?.(r.affect); }
    else presence.setOwn('listening');

    // An answer to the repair's check, or the correction after "something else".
    if (state.repairing) return repairInput(text, r);
    // Self-detected likely miss (§7.5): sharp language, or the user apologizing
    // right after the parent spoke.
    const prev = state.history[state.history.length - 2];
    if (prev?.role === 'assistant' && !state.safety && !r.intents.roleReversal) {
      const sig = missSignals(text, { lastWasQuestion: /\?\s*$/.test(prev.content) });
      if (sig.sharp || (sig.apology && !r.intents.tooMuch && !r.intents.critic)) return onMiss(sig.sharp ? 'sharp' : 'apology');
    }

    // Every typed message gets a model attempt when an AI is on; the intent only
    // steers it (and picks the scripted line if the model can't answer).
    const typed = { allowModel: true, typed: true };
    if (state.mode === 'makesense') return reply('makesense', typed);
    if (r.intents.roleReversal) return reply('roleReversal', typed);
    if (r.intents.tooMuch) return reply('tooMuch', typed);
    if (r.intents.angerAtCoach) return reply('angerAtCoach', typed);
    if (r.intents.critic) return reply('critic', typed);
    if (r.intents.done && state.tier !== 'bewith') return end();

    if (state.tier === 'bewith' && r.wordsBack && !state.offeredWordsBack) {
      state.offeredWordsBack = true;
      ui.onWordsBack?.();
      return reply('wordsBack', typed);
    }
    if (state.tier === 'bewith') return reply('affect', typed);
    if (state.tier === 'name' && !state.bodyBudgetDone && !state.fix && state.history.filter((h) => h.role === 'user').length >= 3) {
      state.bodyBudgetDone = true; return reply('bodyBudget', typed);
    }
    return reply(state.tier === 'ordinary' ? 'ordinary' : 'affect', typed);
  }

  function chooseWordsBack(choice) {
    state.lastInputAt = Date.now();
    if (choice === 'tell') { state.tier = 'name'; state.lead = false; ui.onTier?.('name'); return say(fill('I\'m listening. Take your time.', ctx()), { kind: 'wordsBack', tier: 'name' }); }
    return reply('stillHere');
  }

  // ---------- repair (§7.5) ----------
  // name the specific miss -> own it -> check -> re-attune at the right tier.
  // trigger: 'button' (the "That missed" control) | 'sharp' | 'apology' | 'silence'
  function onMiss(trigger = 'button') {
    if (state.ended) return;
    const self = trigger !== 'button';
    const now = Date.now();
    if (self && (state.safety || state.repairing)) return;
    // Silence and apologies are weak signals: don't keep repairing on them. Sharp words are not.
    if ((trigger === 'silence' || trigger === 'apology') && now - state.lastRepairAt < 60000) return;
    // a miss on the re-attune itself (or a second tap mid-repair) is a second miss in a row
    const again = !!state.repairing || (state.lastTurn?.kind === 'reattune' && now - state.lastRepairAt < 180000);
    if (state.repairing) finishRepair('missed-again');
    state.misses++;
    if (self) state.selfRepairs++;
    state.lastRepairAt = now;
    stopSpeaking();
    presence.setOwn('listening');
    const t = state.lastTurn || {};
    const miss = nameMiss({
      last: t.text || '', kind: t.kind || '', tier: t.tier || state.tier, affect: state.affect,
      answeredUser: !!t.answeredUser, again, maxWords: policyFor(t.tier || state.tier).maxWords,
    });
    const id = `r${now.toString(36)}`;
    const lastUser = [...state.history].reverse().find((m) => m.role === 'user' && !m.content.startsWith('['))?.content || '';
    state.repairing = { id, miss, trigger, phase: 'check', at: now, fromTier: state.tier, lastUser };
    const repeat = state.missesNamed.includes(miss.text);
    state.missesNamed.push(miss.text);
    store.push('repairs', { id, archetype: archetype.id, miss: miss.text, missId: miss.id, line: t.text || '', tier: t.tier || state.tier, trigger, outcome: 'pending' });
    let line = repairLine(miss, { tier: state.tier, trigger, repeat, archetype, ctx: ctx() });
    line = guard(line, null).text || line;
    ui.onRepair?.({ phase: 'check', miss: miss.text, line, tier: state.tier, trigger });
    // Fixed script, never generated: the owning has to be exact every time.
    return say(line, { kind: 'repair', tier: state.tier });
  }

  /** The user's answer to the check: 'yes' (that's it) | 'else' (something else) | 'stay' (just stay). */
  function checkAnswer(choice, extra = '') {
    if (state.ended) return;
    state.lastInputAt = Date.now();
    stopSpeaking();
    const rp = state.repairing;
    const miss = rp?.miss || nameMiss({ last: '', tier: state.tier });
    if (choice === 'stay') {
      if (rp) finishRepair('stayed');
      applyFix({ ...miss, fix: { ...miss.fix, noAdvice: true, quietMs: 120000 }, tier: 'bewith' });
      state.lead = true; ui.onLead?.(true);
      return reply('reattune', { line: reattuneLine('stay', archetype, ctx()), tier: 'bewith' });
    }
    if (!rp) return;
    if (choice === 'else') {
      if (extra) return correction(extra);
      rp.phase = 'listen';
      applyFix({ ...miss, fix: { short: 2, noQuestions: 2 }, tier: state.tier });
      ui.onRepair?.({ phase: 'listen', miss: miss.text, tier: state.tier });
      return say(listenLine(state.tier, archetype, ctx()), { kind: 'repairListen', tier: state.tier });
    }
    // 'yes': the named miss was it. Do the opposite of it, at the right tier.
    applyFix(miss);
    if (miss.reattune === 'listen') {
      rp.phase = 'listen';
      ui.onRepair?.({ phase: 'listen', miss: miss.text, tier: state.tier });
      return say(listenLine(state.tier, archetype, ctx()), { kind: 'repairListen', tier: state.tier });
    }
    finishRepair('confirmed', extra);
    return reattune(miss, extra);
  }

  function repairInput(text, r) {
    const rp = state.repairing;
    if (rp.phase === 'listen') {
      const a = readCheckAnswer(text);
      if (a.answer === 'stay') return checkAnswer('stay');
      if (!a.rest) { finishRepair('confirmed'); return reply('reattune', { line: reattuneLine('heard', archetype, ctx()), tier: state.tier }); }
      return correction(text);
    }
    const a = readCheckAnswer(text);
    return checkAnswer(a.answer, a.rest);
  }

  /** The user told us what it actually was: reflect that, in their words. */
  function correction(text) {
    const r = readText(withoutNegated(text));
    const rp = state.repairing;
    const miss = rp?.miss;
    finishRepair('corrected', text);
    stopSpeaking();
    if (r.affect) { state.affect = r.affect; state.intensity = r.intensity; presence.mirror(r.affect, r.intensity); ui.onMirror?.(r.affect); }
    // Right tier: a real feeling named in an ordinary-day chat moves it into Name.
    if (state.tier === 'ordinary' && r.affect && !['calm', 'hopeful', 'glad'].includes(r.affect)) { state.tier = 'name'; ui.onTier?.('name'); }
    const c = { ...ctx(), allowSignature: false };
    const tier = state.tier;
    // Scripted re-attune = accurate marked mirroring of what they just said; the
    // model, when on, reflects their actual words instead.
    const slot = `affect.${r.affect}.bewith`;   // plain marked mirroring, no interpretation
    const line = r.affect && getPath(slot) ? pick(slot, archetype, c) : reattuneLine('heard', archetype, c);
    return reply('reattune', {
      allowModel: true, typed: true, immediate: false, line,
      tier: tier === 'bewith' ? 'bewith' : 'name',
      hint: `You just missed${miss ? ` (you ${miss.text})` : ''} and owned it. The user has now told you what it actually was: "${text}". Reflect that back first, in their words, so they know you have it now. Do not apologize again or mention the miss. ${miss?.instruction || ''}`,
    });
  }

  function reattune(miss, extra = '') {
    const tier = state.tier;
    const lastUser = state.repairing?.lastUser || [...state.history].reverse().find((m) => m.role === 'user' && !m.content.startsWith('['))?.content || '';
    return reply('reattune', {
      // the model only re-attunes when the user has words on the table to answer
      allowModel: !!lastUser, typed: !!lastUser, line: reattuneLine(miss.reattune, archetype, ctx()), tier,
      hint: `You just named a miss (you ${miss.text}), owned it, and the user confirmed that was it${extra ? `, adding: "${extra}"` : ''}. Now re-attune: ${miss.instruction} Do not apologize again or mention the miss.`,
    });
  }

  function applyFix(miss) {
    const f = miss.fix || {};
    const now = Date.now();
    const prev = state.fix || {};
    state.fix = {
      noQuestions: Math.max(prev.noQuestions || 0, f.noQuestions || 0),
      short: Math.max(prev.short || 0, f.short || 0),
      noAdviceUntil: f.noAdvice ? now + 180000 : prev.noAdviceUntil || 0,
      quietUntil: f.quietMs ? now + f.quietMs : prev.quietUntil || 0,
      instruction: miss.instruction || prev.instruction || '',
      turns: Math.max(f.noQuestions || 0, f.short || 0, 3),
    };
    if (f.clearAffect) state.affect = null;
    if (miss.tier && miss.tier !== state.tier && state.mode !== 'makesense') { state.tier = miss.tier; ui.onTier?.(miss.tier); }
  }

  /** The turn policy, tightened by whatever the last repair promised. */
  function withFix(policy) {
    const f = state.fix;
    if (!f) return policy;
    const p = { ...policy };
    if (f.noQuestions > 0) p.question = false;
    if (f.short > 0) { p.maxSentences = Math.min(p.maxSentences, 2); p.maxWords = Math.min(p.maxWords, 24); p.maxTokens = Math.min(p.maxTokens, 70); }
    return p;
  }
  function fixHint() {
    const f = state.fix;
    const parts = [];
    if (f && f.turns > 0 && f.instruction) parts.push(`You recently missed and repaired it; keep the promise: ${f.instruction}`);
    if (state.missesNamed.length) parts.push(`Earlier in this conversation you missed by: ${[...new Set(state.missesNamed)].slice(-3).join('; ')}. Don't repeat it.`);
    return parts.join(' ');
  }
  function spendFix() {
    const f = state.fix;
    if (!f) return;
    f.noQuestions = Math.max(0, f.noQuestions - 1); f.short = Math.max(0, f.short - 1); f.turns = Math.max(0, f.turns - 1);
    if (!f.noQuestions && !f.short && !f.turns && Date.now() > f.noAdviceUntil && Date.now() > f.quietUntil) state.fix = null;
  }

  /** Close the live repair and record how it ended (the running record in Memory). */
  function finishRepair(outcome, correctionText = '') {
    const rp = state.repairing;
    if (!rp) return;
    state.repairing = null;
    const repairs = [...store.data.repairs];
    const i = repairs.findIndex((x) => x.id === rp.id);
    if (i >= 0) { repairs[i] = { ...repairs[i], outcome, ...(correctionText ? { correction: correctionText.slice(0, 280) } : {}) }; store.setData({ repairs }); }
    ui.onRepair?.({ phase: 'done', outcome });
  }

  // Silence after a parent turn (§7.5), and an unanswered check.
  function watchRepair() {
    if (state.ended || state.safety) return;
    const now = Date.now();
    const rp = state.repairing;
    if (rp) {
      const quiet = now - Math.max(rp.at, state.lastInputAt);
      if (rp.phase === 'check' && quiet > (state.tier === 'bewith' ? 25000 : 45000)) {
        // No answer: take the named miss as it, and do the opposite quietly.
        const miss = rp.miss;
        finishRepair('silent');
        applyFix(miss);
        reply('reattune', { line: reattuneLine(['listen', 'heard'].includes(miss.reattune) ? 'quiet' : miss.reattune, archetype, ctx()), tier: state.tier });
      } else if (rp.phase === 'listen' && quiet > 90000) {
        finishRepair('silent');
        reply('stillHere');
      }
      return;
    }
    // Contingent conversation only: in Be-with and while the parent leads, silence is the point.
    if (state.lead || state.tier === 'bewith' || state.selfRepairs >= 2) return;
    if (!state.replyDoneAt || state.replyDoneAt <= state.lastInputAt || state.silenceChecked === state.replyDoneAt) return;
    if (state.history.filter((m) => m.role === 'user').length < 2) return;
    if (now - state.replyDoneAt > 60000) { state.silenceChecked = state.replyDoneAt; onMiss('silence'); }
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
      if (!state.lead || state.repairing) { await sleep(2000, ctrl.signal); continue; }
      if (state.fix?.quietUntil > Date.now() && Math.random() < .5) { await sleep(gap * 1000, ctrl.signal); continue; }   // promised fewer words
      if (quiet < 14) { await sleep(4000, ctrl.signal); continue; }   // user is engaging: let contingent replies lead
      if (state.safety) { await reply('safety.stay', { immediate: true }); i++; continue; }
      const kind = nextAuto(i, elapsed);
      if (kind) await reply(kind, { immediate: i === 0 });
      i++;
    }
  }
  function nextAuto(i, elapsed) {
    const k = nextAutoRaw(i, elapsed);
    // after a "fixing" miss, no techniques for a while: just presence
    if (state.fix?.noAdviceUntil > Date.now() && ['selfTouch', 'orient', 'breath', 'bodyBudget'].includes(k)) return 'stillHere';
    return k;
  }
  function nextAutoRaw(i, elapsed) {
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
  let watcher = null;
  function start() {
    useProvider();
    watcher = setInterval(watchRepair, 3000);
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
    clearInterval(watcher);
    if (state.repairing) finishRepair('exit');
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
    if (gone()) return;
    ui.onEnd?.({ said: [...new Set(state.said)], closing, meta });
    await say(closing, { kind: 'close', final: true, tier: 'name' });
    await sleep(900, life.signal);
    if (gone()) return;
    await say(meta, { kind: 'metaprocess', final: true, tier: 'name' });
    if (gone()) return;
    presence.setOwn('holding');
    // The goodbye is hers: anything the screen wants to ask waits until she has finished.
    ui.onEndSpoken?.({ said: [...new Set(state.said)] });
  }

  // Say a line again (tap on the caption). Not a new turn: nothing is added to history.
  function replay(text) {
    if (!text) return Promise.resolve();
    stopSpeaking();
    const policy = policyFor(state.tier, store.warmthFor(archetype));
    speakQueue = speakQueue.then(() => speakNow(text, policy, { kind: 'replay', replay: true, final: true }));
    return speakQueue;
  }

  // Leaving the screen: everything goes quiet now, including closing lines
  // still queued or playing.
  function destroy() { if (state.repairing) finishRepair('exit'); state.ended = true; state.destroyed = true; clearInterval(watcher); ctrl.abort(); life.abort(); stopSpeaking(); }

  return {
    state, start, end, destroy, onTile, onText, onMiss, checkAnswer, chooseWordsBack, replay,
    enterSafety, safetyStay, exitSafety, say, stopSpeaking,
    setLead(v) { state.lead = v; if (v) state.lastInputAt = 0; },
    useProvider,
    get modelReady() { return modelReady; }, get modelError() { return modelErr; },
    get brain() { return { state: brain, provider: providerId, progress: modelProgress, error: modelErr?.message || '' }; },
  };
}
