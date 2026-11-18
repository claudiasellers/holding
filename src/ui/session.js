import { h, clear, toast } from './dom.js';
import { icon } from './icons.js';
import { createSuggestions } from './suggestions.js';
import { mountFace } from './faceview.js';
import { createSession } from '../engine/dialogue.js';
import { store } from '../store.js';
import { startCamera } from '../engine/camera.js';
import { shouldAskOnEnd } from '../engine/endprompt.js';
import { brainLabel, canUseDeviceAI, useDeviceAI, connectHoldingLocal } from '../ai/brain.js';

// Why a reply to something the user typed came from the script library even
// though an AI is switched on.
const FALLBACK_NOTE = {
  loading: 'The AI is still loading, so that reply was a scripted line.',
  slow: 'The AI took too long, so that reply was a scripted line.',
  failed: 'The AI didn\'t answer, so that reply was a scripted line.',
  error: 'The AI couldn\'t start, so that reply was a scripted line.',
  rejected: 'The AI\'s reply broke one of the parent\'s rules, so a scripted line was used instead.',
};

// "Just stay" first: it asks the least of someone who can't name anything yet.
const TILES = [
  ['stay', 'Just stay'], ['overwhelmed', 'Falling apart'], ['sad', 'Crying'], ['scared', 'Scared'],
  ['angry', 'Furious'], ['ashamed', 'Ashamed'], ['lonely', 'So alone'], ['numb', 'Numb'],
];

// Lines that aren't offered as keepsakes: repair and safety lines answer a moment, and
// the goodbye lines are said every time.
const NOT_KEEPABLE = /^(repair|safety|close|metaprocess|replay)/;

// Background tint follows the presence state slowly, on the same channel as the face (congruence).
const TINT = { sad: '#e8ecef', scared: '#ecebf0', angry: '#f1e6e1', ashamed: '#efe8e6', lonely: '#e9ebee', numb: '#eceae6', overwhelmed: '#ebe8ee', glad: '#f6eedf', hopeful: '#f4eedf', calm: '#eef0ea' };
// Dark mode keeps the same channel at low lightness, so it never glares at 3am.
const TINT_DARK = { sad: '#1a1d21', scared: '#1d1b22', angry: '#231a17', ashamed: '#221a1a', lonely: '#1a1c20', numb: '#1e1d1a', overwhelmed: '#1e1a21', glad: '#231e16', hopeful: '#221f16', calm: '#1a1f1b' };
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};

export function renderSession(root, nav, { mode = 'hold' } = {}) {
  const a = store.data.archetype;
  const s = store.settings;
  const first = a.name.length <= 10 ? a.name : a.name.split(' ').pop();
  const faceBox = h('div', { class: 'face-box' });
  const caption = h('div', { class: 'caption' + (s.captions ? '' : ' hidden'), 'aria-live': 'polite', title: 'Tap to hear it again' }, '');
  let lastLine = '';
  const kindOf = new Map();           // line text -> kind, so repair/safety lines aren't offered as keepsakes
  const ring = h('div', { class: 'breath-ring', 'aria-hidden': 'true' });
  const status = h('div', { class: 'status', style: { textAlign: 'center', minHeight: '1.2em' } }, '');
  // Always-visible note on what writes the parent's words; tap to change it.
  const brainBtn = h('button', { class: 'brain-chip', type: 'button', onclick: () => openSheet(brainSheet(), 'brain') }, '');
  let brain = { state: 'scripted' };
  const video = h('video', { class: 'hidden-video', playsinline: true, muted: true });
  // Lives in the More sheet as a labelled switch; built once so its state survives reopening.
  const leadBtn = h('button', { class: 'switch' + (mode === 'hold' ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': mode === 'hold' ? 'true' : 'false', 'aria-label': `${first} keeps talking softly` });
  const tilesEl = h('div', { class: 'tiles', role: 'group', 'aria-label': 'How it feels right now' });
  const ta = h('textarea', { rows: 1, placeholder: mode === 'hold' ? 'Type if you want to. You don\'t have to.' : 'Say anything…', 'aria-label': 'Message' });
  const micBtn = h('button', { class: 'icon-btn', 'aria-label': 'Speak' }, icon('mic'));
  const sendBtn = h('button', { class: 'icon-btn', 'aria-label': 'Send' }, icon('send'));
  const inputBar = h('div', { class: 'inputbar' }, ta, micBtn, sendBtn);
  // In hold mode typing is optional, so the input starts folded into one button:
  // a stray tap can't pull the keyboard up over the face.
  const composeBtn = h('button', { class: 'compose-open', type: 'button', onclick: () => openComposer() }, icon('keyboard'), 'Type or talk', icon('mic'));
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'false' });
  const scrim = h('div', { class: 'sheet-scrim', onclick: () => closeSheet() });
  const endCard = h('div', { class: 'end-card', hidden: true });
  // Running text log of this conversation. Kept in memory for this session only; never saved.
  const logList = h('div', { class: 'log-list' });
  const logEmpty = h('p', { class: 'log-empty muted' }, 'Everything you and ' + first + ' say will show up here.');
  const logPanel = h('div', { class: 'log-panel', id: 'session-log', role: 'log', 'aria-label': 'Conversation so far', 'aria-live': 'off', tabindex: '-1' }, logEmpty, logList);
  const logHide = h('button', { class: 'log-hide', type: 'button', onclick: () => setLog(false) }, 'Hide');
  logPanel.prepend(h('div', { class: 'log-head' }, h('b', {}, 'So far'), logHide));
  let stopCam = null, rec = null;

  // Top bar: two things only. More (everything else) and Not safe. Ending lives in More
  // as "Say goodbye", away from the corner where Back usually is.
  const moreBtn = h('button', { class: 'icon-btn more-btn', type: 'button', 'aria-label': 'More: log, save lines, who leads, goodbye', 'aria-haspopup': 'dialog', onclick: () => openSheet(moreSheet(), 'more') }, icon('more'));
  const homeBtn = h('button', { class: 'pill home-btn', type: 'button', hidden: true, onclick: () => nav('home') }, icon('home'), 'Home');
  const safeBtn = h('button', { class: 'pill safe', type: 'button', onclick: () => session.enterSafety(), 'aria-label': 'I am not safe' }, icon('heart'), 'Not safe');
  const missedBtn = h('button', { class: 'missed-btn', type: 'button', onclick: () => session.onMiss(), 'aria-label': `That missed: tell ${first} that got it wrong` }, icon('undo'), 'That missed');

  const el = h('div', { class: 'session' },
    h('div', { class: 'topbar' }, h('div', { class: 'row' }, moreBtn, homeBtn), brainBtn, safeBtn),
    h('div', { class: 'stage' }, h('div', { class: 'face-area' }, faceBox, ring), h('div', { class: 'caption-area' }, caption, missedBtn, status), logPanel),
    tilesEl,
    endCard,
    composeBtn,
    inputBar,
    scrim, sheet, video);
  root.append(el);

  const presence = mountFace(faceBox, a, { bpm: s.breathPacer ? 5.5 : 6 });
  presence.on((ev, v) => {
    if (ev === 'breath') { const k = 1 + v * .18; ring.style.transform = `scale(${k})`; ring.style.opacity = String(.25 + (v + 1) * .2); }
  });
  ring.style.display = s.breathPacer ? '' : 'none';

  function logLine(who, text) {
    logEmpty.remove();
    const atBottom = logPanel.scrollHeight - logPanel.scrollTop - logPanel.clientHeight < 40;
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    logList.append(h('div', { class: 'log-line ' + who },
      who === 'tap' ? null : h('div', { class: 'log-who' }, who === 'parent' ? first : 'You', h('time', {}, time)),
      h('div', { class: 'log-text' }, text)));
    if (atBottom || who !== 'parent') logPanel.scrollTop = logPanel.scrollHeight;
  }
  function setLog(open, { remember = true } = {}) {
    el.classList.toggle('log-open', open);
    if (open) logPanel.scrollTop = logPanel.scrollHeight;
    if (remember) store.setSettings({ conversationLog: open });
  }
  setLog(!!s.conversationLog, { remember: false });

  caption.addEventListener('click', () => { if (lastLine && !session.state.safety) session.replay(lastLine); });

  let composerOpen = mode !== 'hold';
  function openComposer({ focus = true } = {}) {
    composerOpen = true;
    composeBtn.hidden = true; inputBar.hidden = false;
    if (focus) ta.focus({ preventScroll: true });
  }
  composeBtn.hidden = composerOpen; inputBar.hidden = !composerOpen;

  // Lines worth offering to keep, most recent last, without repair/safety/goodbye lines.
  const keepable = (said) => said.filter((t) => !NOT_KEEPABLE.test(kindOf.get(t) || ''));

  const ui = {
    onSay(text, meta = {}) {
      caption.classList.remove('fade'); caption.textContent = text;
      if (meta.replay) return;
      lastLine = text; kindOf.set(text, meta.kind || '');
      logLine('parent', text);
      if (meta.typed && meta.source === 'script' && FALLBACK_NOTE[meta.fallback]) note(FALLBACK_NOTE[meta.fallback]);
    },
    onBrain(b) { brain = b; renderBrain(); },
    onSpeakEnd() { setTimeout(() => caption.classList.add('fade'), 2500); },
    onMirror(affect) {
      el.style.background = (isDark() ? TINT_DARK : TINT)[affect] || '';
      tilesEl.querySelectorAll('.tile').forEach((t) => t.classList.toggle('on', t.dataset.a === affect));
    },
    // Loading progress shows in the brain chip at the top; only a failure gets a line here.
    onModelProgress(p) {
      if (!p.error) return;
      status.className = 'status bad'; status.textContent = p.text;
      setTimeout(() => (status.textContent = ''), 6000);
    },
    onWordsBack() { openSheet(wordsBackSheet()); },
    // Repair (§7.5): the check is always answerable with one tap, even in Be-with.
    onRepair(r) {
      if (r.phase === 'check') openSheet(repairSheet(r), 'repair');
      else if (r.phase === 'listen') { closeSheet(); if (mode === 'hold' || r.tier === 'bewith') tilesEl.style.display = ''; openComposer(); }
      else if (sheet.dataset.kind === 'repair') closeSheet();
    },
    onLead(on) { setLeadUI(on); },
    onSafety(on) { moreBtn.disabled = on; if (on) openSheet(safetySheet(), 'safety'); else closeSheet(); },
    onTier(t) { if (t !== 'bewith') setLeadUI(false); },
    // Goodbye: the closing lines play over the whole face first. Nothing slides over the
    // parent; if it's time to offer keepsakes, a small card appears below once they finish.
    onEnd(info) {
      const ep = store.data.episodes.at(-1);
      const lines = keepable(info.said);
      endAsk = shouldAskOnEnd({ pref: s.endPrompt, lastShown: store.data.endPromptShownAt, minutes: ep?.minutes ?? 0, saidCount: lines.length, mode });
      if (endAsk) store.setData({ endPromptShownAt: Date.now() });
      closeSheet(); setLog(false, { remember: false });
      el.classList.add('ended');
      moreBtn.hidden = true; homeBtn.hidden = false;
    },
    onEndSpoken({ said }) {
      if (!endAsk) return;
      clear(endCard).append(endKeepCard(keepable(said)));
      endCard.hidden = false;
    },
  };
  let endAsk = false;
  const session = createSession({ archetype: a, presence, ui, mode });

  function note(text) {
    status.className = 'status'; status.textContent = text;
    clearTimeout(note._t); note._t = setTimeout(() => { if (status.textContent === text) status.textContent = ''; }, 7000);
  }
  function renderBrain() {
    const b = brain;
    brainBtn.className = 'brain-chip ' + b.state;
    // Short at the top; the full sentence is the accessible name and is in More and the sheet.
    const pct = b.progress > 0 && b.progress < 1 ? ` ${Math.round(b.progress * 100)}%` : '…';
    brainBtn.textContent = b.state === 'scripted' ? 'Scripted lines'
      : b.state === 'loading' ? `AI loading${pct}`
      : b.state === 'error' ? 'AI couldn\'t start'
      : 'AI on';
    brainBtn.setAttribute('aria-label', b.state === 'scripted' ? `Scripted lines: ${first} isn't reading your words. Tap to turn on AI`
      : b.state === 'loading' ? `${brainLabel(b.provider)} loading${pct}`
      : b.state === 'error' ? 'AI couldn\'t start: using scripted lines. Tap to fix'
      : `${brainLabel(b.provider)}: reading your words`);
  }
  function brainSheet() {
    const msg = h('p', { class: 'status' }, '');
    const busy = (b, fn) => async () => { b.disabled = true; try { await fn(); } catch (e) { msg.className = 'status bad'; msg.textContent = e.message || String(e); } finally { b.disabled = false; } };
    const deviceBtn = canUseDeviceAI() ? h('button', { class: 'btn primary' }, 'Use the AI on this device') : null;
    if (deviceBtn) deviceBtn.onclick = busy(deviceBtn, async () => {
      useDeviceAI(); session.useProvider(); closeSheet();
      toast(`Loading the AI. The first time is a one-time download (1 to 3 GB). ${first} uses scripted lines until it's ready.`, 5000);
    });
    const localBtn = h('button', { class: 'btn' + (deviceBtn ? '' : ' primary') }, 'Use Holding Local on my computer');
    localBtn.onclick = busy(localBtn, async () => {
      msg.className = 'status'; msg.textContent = 'Connecting…';
      await connectHoldingLocal(); session.useProvider(); closeSheet();
      toast(`Connected. ${first}'s words, voice and listening now run on your computer.`, 4000);
    });
    const b = brain;
    const title = b.state === 'scripted' ? `Right now ${first} isn't reading what you type.`
      : b.state === 'error' ? 'The AI couldn\'t start.'
      : b.state === 'loading' ? 'The AI is loading.'
      : `${first}'s words come from the AI.`;
    const body = b.state === 'scripted' ? `${first}'s face reacts to feeling words, but the replies are pre-written lines picked by feeling. Turn on an AI and ${first} will answer what you actually say. Everything stays on your own devices.`
      : b.state === 'error' ? `${b.error || 'Unknown error.'} Until it's fixed, ${first} uses scripted lines and won't follow what you type.`
      : b.state === 'loading' ? `${brainLabel(b.provider)} is getting ready${b.progress > 0 && b.progress < 1 ? ` (${Math.round(b.progress * 100)}%)` : ''}. ${first} uses scripted lines until then. You can keep talking.`
      : `${brainLabel(b.provider)} writes ${first}'s replies to what you type. If it is ever slow or breaks a rule, a scripted line fills in and a note says so.`;
    return h('div', { class: 'stack' },
      h('h3', {}, title),
      h('p', { class: 'muted', style: { margin: 0 } }, body),
      b.state === 'ready' || b.state === 'loading' ? null : h('div', { class: 'row wrap' }, deviceBtn, localBtn),
      msg,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn ghost', onclick: () => nav('settings', { focus: 'ai' }) }, 'More options in Settings'),
        h('button', { class: 'btn ghost', onclick: closeSheet }, 'Close')));
  }

  for (const [k, l] of TILES) tilesEl.append(h('button', { class: 'tile', 'data-a': k, onclick: () => { logLine('tap', `You tapped “${l}”`); session.onTile(k); } }, l));
  if (mode !== 'hold') tilesEl.style.display = 'none';

  function setLeadUI(on) {
    leadBtn.classList.toggle('on', on); leadBtn.setAttribute('aria-checked', on ? 'true' : 'false');
    leadHint.textContent = on ? 'You don\'t have to answer.' : `Off: ${first} waits for you.`;
  }
  const leadHint = h('small', {}, '');
  setLeadUI(mode === 'hold');
  leadBtn.onclick = (e) => {
    e.stopPropagation();
    const on = !leadBtn.classList.contains('on');
    setLeadUI(on);
    session.setLead(on);
  };

  const send = () => { const t = ta.value.trim(); if (!t) return; ta.value = ''; ta.style.height = ''; caption.textContent = ''; logLine('you', t); session.onText(t); };
  sendBtn.onclick = send;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  ta.addEventListener('input', () => { ta.style.height = ''; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });

  // Three suggested replies above the input; tap to say one. They follow the
  // conversation once the user starts typing (src/ui/suggestions.js). Hooked in
  // by wrapping the session's callbacks so the engine doesn't need to know.
  const suggest = createSuggestions({ session, input: ta, parentName: first, onSend: (t) => { ta.value = t; send(); } });
  inputBar.prepend(suggest.el);
  suggest.attach(ui);
  for (const k of ['onText', 'onTile']) {
    const orig = session[k];
    session[k] = (...args) => { suggest.cancel(); const r = orig(...args); suggest.refresh(); return r; };
  }
  const destroySession = session.destroy;
  session.destroy = () => { suggest.destroy(); destroySession(); };
  suggest.refresh();

  // dictation: browser speech recognition (may use the browser vendor's servers) or the local server
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const noMic = (!SR && s.stt.provider !== 'server') || s.stt.provider === 'off';
  if (noMic) { micBtn.style.display = 'none'; composeBtn.querySelector('.ico:last-child').remove(); composeBtn.lastChild.textContent = 'Type'; }
  function setMic(on) {
    clear(micBtn).append(icon(on ? 'stop' : 'mic'));
    micBtn.setAttribute('aria-label', on ? 'Stop listening' : 'Speak');
    micBtn.classList.toggle('on', on);
  }
  // The folded button's mic goes straight to dictation.
  if (!noMic) composeBtn.querySelector('.ico:last-child').addEventListener('click', (e) => { e.stopPropagation(); openComposer({ focus: false }); micBtn.click(); });
  micBtn.onclick = async () => {
    if (rec) { rec.stop(); return; }
    if (s.stt.provider === 'server' && s.stt.baseUrl) return serverDictation();
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    setMic(true);
    rec.onresult = (e) => { ta.value = [...e.results].map((r) => r[0].transcript).join(' '); };
    rec.onend = () => { rec = null; setMic(false); if (ta.value.trim()) send(); };
    rec.onerror = () => { rec = null; setMic(false); };
    rec.start();
  };
  async function serverDictation() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream); const chunks = [];
      rec = { stop: () => mr.stop() }; setMic(true);
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); rec = null; setMic(false);
        const fd = new FormData(); fd.append('file', new Blob(chunks, { type: mr.mimeType }), 'speech.webm'); fd.append('model', 'whisper');
        const r = await fetch(`${s.stt.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', body: fd, headers: s.stt.token ? { 'X-Pair-Token': s.stt.token, Authorization: `Bearer ${s.stt.token}` } : {} });
        const j = await r.json(); ta.value = j.text || ''; if (ta.value.trim()) send();
      };
      mr.start();
    } catch (e) { toast('Microphone not available: ' + e.message); }
  }

  // sheets
  // Sheets that are a side trip (More, Save lines, the AI note) get a scrim you can tap to
  // close; the safety and words-back sheets don't, so they can't be dismissed by accident.
  const DISMISSABLE = new Set(['more', 'keep', 'brain']);
  function openSheet(content, kind = '') {
    clear(sheet).append(h('div', { class: 'grab' }), content);
    sheet.dataset.kind = kind || content.dataset?.kind || ''; sheet.classList.add('open');
    scrim.classList.toggle('open', DISMISSABLE.has(sheet.dataset.kind));
  }
  function closeSheet() { sheet.classList.remove('open'); sheet.dataset.kind = ''; scrim.classList.remove('open'); }
  function moreSheet() {
    const row = (ico, title, hint, onclick, trail = null, cls = '') => h('button', { class: 'more-row ' + cls, type: 'button', onclick },
      icon(ico), h('span', { class: 'more-text' }, h('b', {}, title), hint ? (hint.nodeType ? hint : h('small', {}, hint)) : null), trail);
    const logOpen = el.classList.contains('log-open');
    const b = brain;
    const aiTitle = b.state === 'scripted' ? 'Scripted lines' : b.state === 'error' ? 'AI couldn\'t start' : b.state === 'loading' ? `${brainLabel(b.provider)}: loading` : `${brainLabel(b.provider)} is on`;
    const aiHint = b.state === 'ready' ? `${first} is reading your words.` : `${first} isn't reading your exact words.`;
    return h('div', { class: 'more-list', role: 'menu', 'aria-label': 'More' },
      row('log', logOpen ? 'Hide what\'s been said' : 'Show what\'s been said', `Opens under ${first}'s face. Not saved.`, () => { closeSheet(); setLog(!logOpen); }),
      row('bookmark', 'Save a line', 'Keep one to hear again later.', () => openSheet(keepSheet({ said: keepable([...new Set(session.state.said)]), ending: false }), 'keep')),
      row('talk', `${first} keeps talking softly`, leadHint, () => leadBtn.click(), leadBtn),
      row('spark', aiTitle, aiHint, () => openSheet(brainSheet(), 'brain'), b.state === 'scripted' || b.state === 'error' ? h('span', { class: 'more-go' }, 'Turn on AI') : null),
      row('door', 'Say goodbye', `${first} says goodbye, then you're done.`, () => { closeSheet(); session.end(); }, null, 'bye'));
  }
  function repairSheet({ line }) {
    // The sheet sits over the caption, so it carries the spoken line itself.
    const el = h('div', { class: 'stack repair-check' },
      h('p', { style: { margin: 0, fontSize: '1.05rem' } }, line),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => { closeSheet(); session.checkAnswer('yes'); } }, 'That\'s it'),
        h('button', { class: 'btn', onclick: () => { closeSheet(); session.checkAnswer('else'); } }, 'Something else'),
        h('button', { class: 'btn ghost', onclick: () => { closeSheet(); session.checkAnswer('stay'); } }, 'Just stay with me')));
    el.dataset.kind = 'repair';
    return el;
  }
  function wordsBackSheet() {
    return h('div', { class: 'stack' },
      h('h3', {}, 'Words are coming back.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => { closeSheet(); tilesEl.style.display = 'none'; session.chooseWordsBack('tell'); openComposer(); } }, 'Tell you what happened'),
        h('button', { class: 'btn', onclick: () => { closeSheet(); session.chooseWordsBack('stay'); } }, 'Stay a bit longer')));
  }
  function safetySheet() {
    const c = s.safetyContact || {};
    return h('div', { class: 'stack' },
      h('h3', {}, `${first} is staying right here.`),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Reach a person now. You can keep this open while you do.'),
      h('div', { class: 'safety-actions' },
        h('a', { class: 'btn primary', href: 'tel:988' }, 'Call 988 (US)'),
        h('a', { class: 'btn', href: 'sms:988' }, 'Text 988'),
        c.phone ? h('a', { class: 'btn', href: `tel:${c.phone}` }, `Call ${c.name || 'my person'}`) : null,
        c.phone ? h('a', { class: 'btn', href: `sms:${c.phone}` }, `Text ${c.name || 'my person'}`) : null,
        h('a', { class: 'btn ghost', href: 'https://findahelpline.com', target: '_blank', rel: 'noopener' }, 'Outside the US: find a helpline'),
        h('button', { class: 'btn ghost', onclick: () => session.safetyStay() }, `Stay with me, ${first}`),
        h('button', { class: 'btn ghost', onclick: () => session.exitSafety() }, 'I\'m safe right now')));
  }
  // Save lines, any time from More. Lines already saved show as saved.
  function keepSheet({ said }) {
    const kept = new Set(store.data.keepsakes.filter((k) => k.archetype === a.id).map((k) => k.text));
    const chosen = new Set();
    const lines = said.slice(-10);
    const list = lines.length
      ? h('div', { class: 'keep-list' }, lines.map((t) => keepOption(t, kept, chosen)))
      : h('p', { class: 'muted', style: { margin: 0 } }, `Nothing yet. Lines ${first} says will show up here.`);
    const rule = ruleField();
    return h('div', { class: 'stack' },
      h('h3', {}, 'Save lines'),
      h('p', { class: 'muted', style: { margin: 0 } }, `Saved lines can be played back in ${first}'s voice any time, even offline.`),
      list,
      rule,
      h('div', { class: 'row wrap', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn ghost', onclick: closeSheet }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          const n = saveChosen(chosen, rule);
          closeSheet();
          if (n) toast(n === 1 ? 'Saved. It\'s in Memory.' : `Saved ${n}. They're in Memory.`);
        } }, 'Save')));
  }
  function keepOption(t, kept, chosen, onChange = () => {}) {
    if (kept.has(t)) return h('button', { class: 'on', disabled: true, 'aria-label': `${t} (saved)` }, h('span', { class: 'chk', 'aria-hidden': 'true' }), t);
    const b = h('button', { 'aria-pressed': 'false', onclick: () => {
      chosen.has(t) ? chosen.delete(t) : chosen.add(t);
      const on = b.classList.toggle('on'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); onChange();
    } }, h('span', { class: 'chk', 'aria-hidden': 'true' }), t);
    return b;
  }
  function ruleField() {
    return mode === 'makesense' ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Your new rule, in your words'), h('textarea', { placeholder: 'When I fall apart and reach out…' })) : null;
  }
  function saveChosen(chosen, rule) {
    for (const t of chosen) store.push('keepsakes', { text: t, archetype: a.id });
    const rt = rule?.querySelector('textarea').value.trim();
    if (rt) store.push('rules', { text: rt, evidence: [new Date().toISOString().slice(0, 10)] });
    return chosen.size + (rt ? 1 : 0);
  }
  // The occasional end-of-conversation offer. It sits below the face, never over it.
  // At most three lines; "Not now" weighs the same as "Keep"; the size question is
  // optional and nothing is recorded unless one is tapped.
  function endKeepCard(lines) {
    const kept = new Set(store.data.keepsakes.filter((k) => k.archetype === a.id).map((k) => k.text));
    const chosen = new Set();
    let size = null;
    const offer = lines.slice(-3);
    const keepBtn = h('button', { class: 'btn primary' }, 'Done');
    const label = () => { keepBtn.textContent = chosen.size ? `Keep ${chosen.size} line${chosen.size > 1 ? 's' : ''}` : 'Done'; };
    const rule = ruleField();
    const sizes = h('div', { class: 'size-chips', role: 'radiogroup', 'aria-label': 'Is it smaller now?' },
      [['smaller', 'Smaller'], ['same', 'Same'], ['bigger', 'Bigger']].map(([v, l]) => {
        const c = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', onclick: () => {
          size = size === v ? null : v;
          sizes.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', x === c && size ? 'true' : 'false'));
        } }, l);
        return c;
      }));
    const finish = (keep) => {
      if (keep) saveChosen(chosen, rule);
      if (size) { const eps = [...store.data.episodes]; if (eps.length) { eps[eps.length - 1] = { ...eps[eps.length - 1], afterSize: size }; store.setData({ episodes: eps }); } }
      nav('home');
    };
    keepBtn.onclick = () => finish(true);
    return h('div', { class: 'stack' },
      h('h3', {}, offer.length ? 'Keep a line to hear again?' : 'Before you go'),
      offer.length ? h('div', { class: 'keep-list' }, offer.map((t) => keepOption(t, kept, chosen, label))) : null,
      rule,
      h('div', { class: 'size-row' }, h('span', {}, 'Is it smaller now?'), sizes),
      h('div', { class: 'end-actions' }, h('button', { class: 'btn', onclick: () => finish(false) }, 'Not now'), keepBtn),
      h('button', { class: 'link-btn', onclick: () => { store.setSettings({ endPrompt: 'never' }); finish(false); } }, 'Don\'t ask again'));
  }

  if (s.camera && mode === 'hold') {
    startCamera(video, (affect, intensity) => { session.state.lastInputAt = Date.now(); presence.mirror(affect, Math.min(.8, intensity)); ui.onMirror(affect); })
      .then((stop) => { stopCam = stop; status.innerHTML = '<span class="cam-dot"></span>Camera mirroring on (stays on this device)'; setTimeout(() => (status.textContent = ''), 4000); })
      .catch((e) => { status.textContent = 'Camera mirroring unavailable: ' + (e.message || e); });
  }

  // Once the conversation is over, putting the app in the background (home
  // button, switching apps, locking the phone) silences the goodbye too. The
  // goodbye was cut short, so the keepsake card (if due) is waiting on return.
  const onHidden = (e) => {
    if (!(e.type === 'pagehide' || document.visibilityState === 'hidden') || !session.state.ended || session.state.destroyed) return;
    session.destroy();
    ui.onEndSpoken({ said: [...new Set(session.state.said)] });
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);

  renderBrain();
  session.start();
  return () => {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onHidden);
    session.destroy(); presence.destroy(); stopCam?.(); rec?.stop?.();
  };
}
