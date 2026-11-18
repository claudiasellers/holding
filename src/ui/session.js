import { h, clear, toast } from './dom.js';
import { mountFace } from './faceview.js';
import { createSession } from '../engine/dialogue.js';
import { store } from '../store.js';
import { startCamera } from '../engine/camera.js';

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
  let stopCam = null, rec = null;

  const el = h('div', { class: 'session' },
    h('div', { class: 'topbar' },
      h('button', { class: 'pill', onclick: () => session.end() }, 'End'),
      h('div', { class: 'row' },
        h('button', { class: 'pill safe', onclick: () => session.enterSafety(), 'aria-label': 'I am not safe' }, 'Not safe'),
        leadBtn,
        h('button', { class: 'pill', onclick: () => session.onMiss(), title: 'Tell them they got it wrong' }, 'That missed'))),
    h('div', { class: 'stage' }, h('div', { style: { position: 'relative', minHeight: 0, display: 'grid' } }, faceBox, ring), h('div', {}, caption, status)),
    tilesEl,
    inputBar,
    sheet, video);
  root.append(el);

  const presence = mountFace(faceBox, a, { bpm: s.breathPacer ? 5.5 : 6 });
  presence.on((ev, v) => {
    if (ev === 'breath') { const k = 1 + v * .18; ring.style.transform = `scale(${k})`; ring.style.opacity = String(.25 + (v + 1) * .2); }
  });
  ring.style.display = s.breathPacer ? '' : 'none';

  const ui = {
    onSay(text) { caption.classList.remove('fade'); caption.textContent = text; },
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
    onEnd(info) { setTimeout(() => openSheet(endSheet(info)), 400); },
  };
  const session = createSession({ archetype: a, presence, ui, mode });

  for (const [k, l] of TILES) tilesEl.append(h('button', { class: 'tile', 'data-a': k, onclick: () => session.onTile(k) }, l));
  if (mode !== 'hold') tilesEl.style.display = 'none';

  leadBtn.onclick = () => {
    const on = !leadBtn.classList.contains('on');
    leadBtn.classList.toggle('on', on); leadBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    session.setLead(on);
    toast(on ? `${first} will keep talking softly. You don't have to answer.` : `${first} will wait for you.`);
  };

  const send = () => { const t = ta.value.trim(); if (!t) return; ta.value = ''; ta.style.height = ''; caption.textContent = ''; session.onText(t); };
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
  function endSheet({ said }) {
    const chosen = new Set();
    let distress = 5;
    const list = h('div', { class: 'keep-list' }, said.slice(-10).map((t) => {
      const b = h('button', { onclick: () => { chosen.has(t) ? chosen.delete(t) : chosen.add(t); b.classList.toggle('on'); } }, t);
      return b;
    }));
    const rule = mode === 'makesense' ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Your new rule, in your words'), h('textarea', { placeholder: 'When I fall apart and reach out…' })) : null;
    const out = h('output', {}, '5');
    return h('div', { class: 'stack' },
      h('h3', {}, 'Keep a line that helped?'),
      h('p', { class: 'muted', style: { margin: 0 } }, `Saved lines can be played back in ${first}'s voice any time, even offline.`),
      list,
      rule,
      h('label', { class: 'field slider' }, h('span', { class: 'lbl' }, 'How big is it now?'), h('div', { class: 'row' }, h('input', { type: 'range', min: 0, max: 10, step: 1, value: 5, oninput: (e) => { distress = +e.target.value; out.textContent = e.target.value; } }), out)),
      h('div', { class: 'row wrap', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn primary', onclick: () => {
          for (const t of chosen) store.push('keepsakes', { text: t, archetype: a.id });
          const rt = rule?.querySelector('textarea').value.trim();
          if (rt) store.push('rules', { text: rt, evidence: [new Date().toISOString().slice(0, 10)] });
          const eps = [...store.data.episodes]; if (eps.length) { eps[eps.length - 1] = { ...eps[eps.length - 1], after: distress }; store.setData({ episodes: eps }); }
          nav('home');
        } }, 'Done')));
  }

  if (s.camera && mode === 'hold') {
    startCamera(video, (affect, intensity) => { session.state.lastInputAt = Date.now(); presence.mirror(affect, Math.min(.8, intensity)); ui.onMirror(affect); })
      .then((stop) => { stopCam = stop; status.innerHTML = '<span class="cam-dot"></span>Camera mirroring on (stays on this device)'; setTimeout(() => (status.textContent = ''), 4000); })
      .catch((e) => { status.textContent = 'Camera mirroring unavailable: ' + (e.message || e); });
  }

  session.start();
  return () => { session.destroy(); presence.destroy(); stopCam?.(); rec?.stop?.(); };
}
