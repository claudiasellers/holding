import { h, clear, toast } from './dom.js';
import { mountFace } from './faceview.js';
import { createSession } from '../engine/dialogue.js';
import { store } from '../store.js';
import { startCamera } from '../engine/camera.js';
import { shouldAskOnEnd } from '../engine/endprompt.js';

const TILES = [
  ['overwhelmed', 'Falling apart'], ['sad', 'Crying'], ['scared', 'Scared'], ['angry', 'Furious'],
  ['ashamed', 'Ashamed'], ['lonely', 'So alone'], ['numb', 'Numb'], ['stay', 'Just stay'],
];

// Background tint follows the presence state slowly, on the same channel as the face (congruence).
const TINT = { sad: '#e8ecef', scared: '#ecebf0', angry: '#f1e6e1', ashamed: '#efe8e6', lonely: '#e9ebee', numb: '#eceae6', overwhelmed: '#ebe8ee', glad: '#f6eedf', hopeful: '#f4eedf', calm: '#eef0ea' };

export function renderSession(root, nav, { mode = 'hold' } = {}) {
  const a = store.data.archetype;
  const s = store.settings;
  const first = a.name.length <= 10 ? a.name : a.name.split(' ').pop();
  const faceBox = h('div', { class: 'face-box' });
  const caption = h('div', { class: 'caption' + (s.captions ? '' : ' hidden'), 'aria-live': 'polite' }, '');
  const ring = h('div', { class: 'breath-ring', 'aria-hidden': 'true' });
  const status = h('div', { class: 'status', style: { textAlign: 'center', minHeight: '1.2em' } }, '');
  const video = h('video', { class: 'hidden-video', playsinline: true, muted: true });
  const leadBtn = h('button', { class: 'pill' + (mode === 'hold' ? ' on' : ''), 'aria-pressed': mode === 'hold' ? 'true' : 'false' }, `${first} leads`);
  const tilesEl = h('div', { class: 'tiles', role: 'group', 'aria-label': 'How it feels right now' });
  const ta = h('textarea', { rows: 1, placeholder: mode === 'hold' ? 'Type if you want to. You don\'t have to.' : 'Say anything…', 'aria-label': 'Message' });
  const micBtn = h('button', { class: 'icon-btn', 'aria-label': 'Speak' }, 'Mic');
  const sendBtn = h('button', { class: 'icon-btn', 'aria-label': 'Send' }, 'Send');
  const inputBar = h('div', { class: 'inputbar' }, ta, micBtn, sendBtn);
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'false' });
  // Running text log of this conversation. Kept in memory for this session only; never saved.
  const logList = h('div', { class: 'log-list' });
  const logEmpty = h('p', { class: 'log-empty muted' }, 'Everything you and ' + first + ' say will show up here.');
  const logPanel = h('div', { class: 'log-panel', id: 'session-log', role: 'log', 'aria-label': 'Conversation so far', 'aria-live': 'off', tabindex: '-1' }, logEmpty, logList);
  const logBtn = h('button', { class: 'pill', 'aria-controls': 'session-log', 'aria-expanded': 'false' }, 'Log');
  let stopCam = null, rec = null;
  const endBtn = h('button', { class: 'pill', onclick: () => (session.state.ended ? nav('home') : session.end()) }, 'End');
  const saveBtn = h('button', { class: 'pill', onclick: () => openSheet(keepSheet({ said: [...new Set(session.state.said)], ending: false })), title: 'Keep lines to play back later' }, 'Save lines');

  const el = h('div', { class: 'session' },
    h('div', { class: 'topbar' },
      h('div', { class: 'row' }, endBtn, saveBtn, logBtn),
      h('div', { class: 'row' },
        h('button', { class: 'pill safe', onclick: () => session.enterSafety(), 'aria-label': 'I am not safe' }, 'Not safe'),
        leadBtn,
        h('button', { class: 'pill', onclick: () => session.onMiss(), title: 'Tell them they got it wrong' }, 'That missed'))),
    h('div', { class: 'stage' }, h('div', { style: { position: 'relative', minHeight: 0, display: 'grid' } }, faceBox, ring), h('div', {}, caption, status), logPanel),
    tilesEl,
    inputBar,
    sheet, video);
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
    logBtn.classList.toggle('on', open);
    logBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) logPanel.scrollTop = logPanel.scrollHeight;
    if (remember) store.setSettings({ conversationLog: open });
  }
  logBtn.onclick = () => setLog(!el.classList.contains('log-open'));
  setLog(!!s.conversationLog, { remember: false });

  const ui = {
    onSay(text) { caption.classList.remove('fade'); caption.textContent = text; logLine('parent', text); },
    onSpeakEnd() { setTimeout(() => caption.classList.add('fade'), 2500); },
    onMirror(affect) {
      el.style.background = matchMedia('(prefers-color-scheme: dark)').matches ? '' : (TINT[affect] || '');
      tilesEl.querySelectorAll('.tile').forEach((t) => t.classList.toggle('on', t.dataset.a === affect));
    },
    onModelProgress(p) {
      status.className = 'status' + (p.error ? ' bad' : p.progress >= 1 ? ' ok' : '');
      status.textContent = p.progress >= 1 ? (p.error ? p.text : '') : `${p.text || 'Loading model'} ${Math.round((p.progress || 0) * 100)}%`;
      if (p.error) setTimeout(() => (status.textContent = ''), 6000);
    },
    onWordsBack() { openSheet(wordsBackSheet()); },
    onSafety(on) { if (on) openSheet(safetySheet()); else closeSheet(); },
    onTier(t) { if (t !== 'bewith') leadBtn.classList.remove('on'); },
    onEnd(info) {
      const ep = store.data.episodes.at(-1);
      const ask = shouldAskOnEnd({ pref: s.endPrompt, lastShown: store.data.endPromptShownAt, minutes: ep?.minutes ?? 0, saidCount: info.said.length, mode });
      // No sheet: the closing words still play, the End button becomes the way home,
      // and Save lines stays up top for anyone who wants it.
      tilesEl.style.display = 'none'; inputBar.style.display = 'none';
      endBtn.textContent = 'Home'; endBtn.classList.add('on');
      if (ask) { store.setData({ endPromptShownAt: Date.now() }); setTimeout(() => openSheet(keepSheet({ ...info, ending: true })), 400); }
    },
  };
  const session = createSession({ archetype: a, presence, ui, mode });

  for (const [k, l] of TILES) tilesEl.append(h('button', { class: 'tile', 'data-a': k, onclick: () => { logLine('tap', `You tapped “${l}”`); session.onTile(k); } }, l));
  if (mode !== 'hold') tilesEl.style.display = 'none';

  leadBtn.onclick = () => {
    const on = !leadBtn.classList.contains('on');
    leadBtn.classList.toggle('on', on); leadBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    session.setLead(on);
    toast(on ? `${first} will keep talking softly. You don't have to answer.` : `${first} will wait for you.`);
  };

  const send = () => { const t = ta.value.trim(); if (!t) return; ta.value = ''; ta.style.height = ''; caption.textContent = ''; logLine('you', t); session.onText(t); };
  sendBtn.onclick = send;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  ta.addEventListener('input', () => { ta.style.height = ''; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });

  // dictation: browser speech recognition (may use the browser vendor's servers) or the local server
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if ((!SR && s.stt.provider !== 'server') || s.stt.provider === 'off') micBtn.style.display = 'none';
  micBtn.onclick = async () => {
    if (rec) { rec.stop(); return; }
    if (s.stt.provider === 'server' && s.stt.baseUrl) return serverDictation();
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    micBtn.textContent = 'Stop';
    rec.onresult = (e) => { ta.value = [...e.results].map((r) => r[0].transcript).join(' '); };
    rec.onend = () => { rec = null; micBtn.textContent = 'Mic'; if (ta.value.trim()) send(); };
    rec.onerror = () => { rec = null; micBtn.textContent = 'Mic'; };
    rec.start();
  };
  async function serverDictation() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream); const chunks = [];
      rec = { stop: () => mr.stop() }; micBtn.textContent = 'Stop';
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); rec = null; micBtn.textContent = 'Mic';
        const fd = new FormData(); fd.append('file', new Blob(chunks, { type: mr.mimeType }), 'speech.webm'); fd.append('model', 'whisper');
        const r = await fetch(`${s.stt.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', body: fd, headers: s.stt.token ? { 'X-Pair-Token': s.stt.token, Authorization: `Bearer ${s.stt.token}` } : {} });
        const j = await r.json(); ta.value = j.text || ''; if (ta.value.trim()) send();
      };
      mr.start();
    } catch (e) { toast('Microphone not available: ' + e.message); }
  }

  // sheets
  function openSheet(content) { clear(sheet).append(h('div', { class: 'grab' }), content); sheet.classList.add('open'); }
  function closeSheet() { sheet.classList.remove('open'); }
  function wordsBackSheet() {
    return h('div', { class: 'stack' },
      h('h3', {}, 'Words are coming back.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => { closeSheet(); tilesEl.style.display = 'none'; session.chooseWordsBack('tell'); ta.focus(); } }, 'Tell you what happened'),
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
  // One sheet for both: the always-available "Save lines" button (ending: false) and the
  // occasional end-of-conversation offer (ending: true, adds the how-big slider and an opt-out).
  function keepSheet({ said, ending }) {
    const kept = new Set(store.data.keepsakes.filter((k) => k.archetype === a.id).map((k) => k.text));
    const chosen = new Set();
    let distress = 5;
    const lines = said.slice(-10);
    const list = lines.length
      ? h('div', { class: 'keep-list' }, lines.map((t) => {
        if (kept.has(t)) return h('button', { class: 'on', disabled: true, 'aria-label': `${t} (saved)` }, t);
        const b = h('button', { 'aria-pressed': 'false', onclick: () => { chosen.has(t) ? chosen.delete(t) : chosen.add(t); const on = b.classList.toggle('on'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); } }, t);
        return b;
      }))
      : h('p', { class: 'muted', style: { margin: 0 } }, `Nothing yet. Lines ${first} says will show up here.`);
    const rule = mode === 'makesense' ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Your new rule, in your words'), h('textarea', { placeholder: 'When I fall apart and reach out…' })) : null;
    const out = h('output', {}, '5');
    const save = () => {
      for (const t of chosen) store.push('keepsakes', { text: t, archetype: a.id });
      const rt = rule?.querySelector('textarea').value.trim();
      if (rt) store.push('rules', { text: rt, evidence: [new Date().toISOString().slice(0, 10)] });
      return chosen.size + (rt ? 1 : 0);
    };
    const finish = (n) => { if (!ending) { closeSheet(); if (n) toast(n === 1 ? 'Saved. It\'s in Memory.' : `Saved ${n}. They're in Memory.`); } else nav('home'); };
    return h('div', { class: 'stack' },
      h('h3', {}, ending ? 'Keep a line that helped?' : 'Save lines'),
      h('p', { class: 'muted', style: { margin: 0 } }, `Saved lines can be played back in ${first}'s voice any time, even offline.`),
      list,
      rule,
      ending ? h('label', { class: 'field slider' }, h('span', { class: 'lbl' }, 'How big is it now?'), h('div', { class: 'row' }, h('input', { type: 'range', min: 0, max: 10, step: 1, value: 5, oninput: (e) => { distress = +e.target.value; out.textContent = e.target.value; } }), out)) : null,
      h('div', { class: 'row wrap', style: { justifyContent: 'flex-end' } },
        ending ? h('button', { class: 'btn ghost', onclick: () => { store.setSettings({ endPrompt: 'never' }); toast('Won\'t ask again. Save lines is always up top.'); nav('home'); } }, 'Don\'t ask again') : null,
        h('button', { class: 'btn ghost', onclick: () => (ending ? nav('home') : closeSheet()) }, ending ? 'Skip' : 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          const n = save();
          if (ending) { const eps = [...store.data.episodes]; if (eps.length) { eps[eps.length - 1] = { ...eps[eps.length - 1], after: distress }; store.setData({ episodes: eps }); } }
          finish(n);
        } }, ending ? 'Done' : 'Save')));
  }

  if (s.camera && mode === 'hold') {
    startCamera(video, (affect, intensity) => { session.state.lastInputAt = Date.now(); presence.mirror(affect, Math.min(.8, intensity)); ui.onMirror(affect); })
      .then((stop) => { stopCam = stop; status.innerHTML = '<span class="cam-dot"></span>Camera mirroring on (stays on this device)'; setTimeout(() => (status.textContent = ''), 4000); })
      .catch((e) => { status.textContent = 'Camera mirroring unavailable: ' + (e.message || e); });
  }

  session.start();
  return () => { session.destroy(); presence.destroy(); stopCam?.(); rec?.stop?.(); };
}
