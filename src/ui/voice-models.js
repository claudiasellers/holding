// Settings → Voice → Voice models: download, use and delete voice models, and
// see the space each one takes. Two places a model can live:
//   - this browser (Kokoro, Chatterbox, Chatterbox Turbo), kept in its model cache;
//   - Holding Local on your computer, when "Voice from my computer" is the engine.
import { h, clear, toast, slider } from './dom.js';
import { store } from '../store.js';
import { getTTSProvider } from '../voice/providers.js';
import { VOICE_MODELS, cachedSize, deleteCached, storageEstimate, formatBytes, canRun, memoryWarning, hasFeelingDial } from '../voice/models.js';
import { listServerModels, downloadServerModel, deleteServerModel, selectServerModel, startPrerender, prerenderStatus, stopPrerender } from '../voice/server-models.js';
import { scriptedTexts } from '../voice/scripted-texts.js';
import { voiceFor } from '../voice/resolve.js';
import { feelingFor, FEELING_MIN, FEELING_MAX } from '../voice/feeling.js';

const S = () => store.settings;
const set = (patch) => store.setSettings(patch);

// Two taps to delete, like "Delete everything": no blocking dialog.
const armed = new Map();
function confirmTap(key, label) {
  const t = armed.get(key);
  if (t && Date.now() - t < 4000) { armed.delete(key); return true; }
  armed.set(key, Date.now()); toast(`Tap "Delete" again to remove ${label}.`); return false;
}

function row(m, { inUse, status, note, buttons, prog }) {
  return h('div', { class: 'vm-row' + (inUse ? ' on' : '') },
    h('div', { class: 'vm-head' }, h('b', {}, m.name), inUse ? h('span', { class: 'vm-badge' }, 'In use') : null, m.feeling ? h('span', { class: 'vm-badge soft' }, 'Feeling dial') : null),
    m.blurb ? h('p', { class: 'muted vm-blurb' }, m.blurb) : null,
    h('p', { class: 'status vm-status' }, status),
    note ? h('p', { class: 'muted vm-note' }, note) : null,
    prog || null,
    buttons?.length ? h('div', { class: 'row wrap' }, buttons) : null);
}

/**
 * @param {{ rerender: () => void, preview: (arch?: object) => void }} hooks
 */
export function voiceModelsPanel({ rerender, preview }) {
  const ttsId = S().tts.provider;
  const wrap = h('div', { class: 'stack vm' },
    h('div', { class: 'lbl', style: { fontWeight: 600 } }, 'Voice models',
      h('small', { style: { display: 'block', fontWeight: 400 } }, 'Download a voice once, then it works offline. Delete one any time to get the space back.')));
  const list = h('div', { class: 'stack' });
  const foot = h('p', { class: 'muted', style: { margin: 0, fontSize: '.85rem' } }, '');
  wrap.append(list, foot);
  if (ttsId === 'openai-speech') serverPanel(list, foot, rerender);
  else browserPanel(list, foot, ttsId, rerender);
  const dial = feelingDial(preview);
  if (dial) wrap.append(dial);
  return wrap;
}

function feelingDial(preview) {
  const p = getTTSProvider(S().tts.provider);
  if (!hasFeelingDial(p, S().tts)) return null;
  const a = store.data.archetype;
  const field = slider(`${a.name}'s feeling`, feelingFor(a), (v) => {
    const arch = store.data.archetype;
    const next = { ...arch, voice: { ...arch.voice, feeling: v } };
    store.setData({ archetype: next, saved: (store.data.saved || []).map((x) => (x.id === next.id ? next : x)) });
  }, { min: FEELING_MIN, max: FEELING_MAX, step: 0.05, hint: 'How much emotion comes through. Lower is calm and even, higher is more expressive. The parent steadies a little on their own when things are hardest.' });
  field.querySelector('input')?.addEventListener('change', () => preview());
  return field;
}

// ---------- this browser ----------
function browserPanel(list, foot, ttsId, rerender) {
  // Built-in device voices: nothing to download or delete.
  list.append(row({ name: 'Device voices', blurb: 'The voices built into this phone or computer.' }, {
    inUse: ttsId === 'webspeech', status: 'Built in · no download',
    buttons: ttsId === 'webspeech' ? [] : [h('button', { class: 'btn', onclick: () => { set({ tts: { provider: 'webspeech' } }); rerender(); } }, 'Use')],
  }));
  let total = 0;
  const pending = VOICE_MODELS.map(async (m) => {
    const slot = h('div'); list.append(slot);
    const [{ bytes }, can] = await Promise.all([cachedSize(m), canRun(m)]);
    total += bytes;
    const have = bytes > m.sizeMB * 1e6 * 0.5; // most of the files are here
    const inUse = ttsId === m.provider;
    const prov = getTTSProvider(m.provider);
    const prog = h('div', { class: 'progress', style: { display: 'none' } }, h('i'));
    const msg = h('p', { class: 'status' }, '');
    const download = async (e) => {
      e.target.disabled = true; prog.style.display = '';
      try {
        await prov.init(S().tts[m.provider] || {}, (p) => { prog.firstChild.style.width = Math.round((p.progress || 0) * 100) + '%'; if (p.text) msg.textContent = p.text; });
        set({ tts: { provider: m.provider } });
        toast(`${m.name} is ready.`);
        rerender();
      } catch (err) { msg.className = 'status bad'; msg.textContent = err.message || String(err); e.target.disabled = false; }
    };
    const remove = async () => {
      if (!confirmTap(m.id, m.name)) return;
      try {
        if (inUse) set({ tts: { provider: 'webspeech' } });
        await prov?.dispose?.();
        const freed = await deleteCached(m);
        toast(`${m.name} deleted. ${formatBytes(freed)} freed.`);
      } catch (err) { toast(`Could not delete ${m.name}: ${err.message || err}`); }
      rerender();
    };
    const buttons = [];
    if (!have) buttons.push(h('button', { class: 'btn primary', disabled: !can.ok, onclick: download }, partial(bytes) ? 'Finish download' : 'Download and use'));
    else if (!inUse) buttons.push(h('button', { class: 'btn', disabled: !can.ok, onclick: download }, 'Use'));
    if (bytes) buttons.push(h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, onclick: remove }, 'Delete'));
    slot.replaceWith(row(m, {
      inUse,
      status: have ? `On this device · ${formatBytes(bytes)}` : partial(bytes) ? `Partly downloaded · ${formatBytes(bytes)} of ${m.sizeNote}` : `Not downloaded · ${m.sizeNote}`,
      note: can.ok ? (have ? null : memoryWarning(m)) : can.reason,
      buttons, prog: h('div', { class: 'stack' }, prog, msg),
    }));
  });
  Promise.all(pending).then(async () => {
    const est = await storageEstimate();
    const free = est?.quota && est?.usage != null ? est.quota - est.usage : null;
    foot.textContent = `Voices in this browser use ${formatBytes(total)}.` + (free != null ? ` It can store about ${formatBytes(free)} more.` : '');
  });
}
const partial = (bytes) => bytes > 0;

// ---------- Holding Local ----------
function serverPanel(list, foot, rerender) {
  const cfg = () => S().tts['openai-speech'] || {};
  list.append(h('p', { class: 'muted', style: { margin: 0 } }, 'Checking your computer…'));
  let timer = 0;
  const draw = (data) => {
    clear(list);
    const selected = cfg().model || data.selected || 'kokoro';
    let downloading = false;
    const models = data.models || [];
    const groups = [
      ['any', 'Run on any computer', null],
      ['mac', 'Mac only', 'These run on the graphics chip of a Mac with Apple silicon, through mlx-audio. The first one you download also installs that engine (about 300 MB, once).'],
    ];
    for (const [g, title, hint] of groups) {
      const ms = models.filter((m) => (m.group || 'any') === g);
      if (!ms.length) continue;
      if (g !== 'any' || models.some((m) => m.group === 'mac')) {
        list.append(h('div', { class: 'vm-group' }, h('b', {}, title), hint ? h('small', { class: 'muted' }, hint) : null));
      }
      if (g === 'mac' && ms.every((m) => m.runs_here === false)) {
        list.append(h('p', { class: 'muted vm-note' }, `${ms[0].why_not} This computer can't run them: ${ms.map((m) => m.name).join(', ')}.`));
        continue;
      }
      for (const m of ms) {
        if (m.downloading) downloading = true;
        list.append(serverRow(m, selected));
      }
    }
    const cur = models.find((m) => m.id === selected);
    if (cur?.downloaded && cur.id !== 'kokoro') list.append(prerenderBlock(cfg, cur));
    const used = models.reduce((n, m) => n + (m.bytes || 0) + (m.lines_bytes || 0), 0);
    foot.textContent = `Voices on your computer use ${formatBytes(used)}.` + (data.disk?.free_bytes != null ? ` It has ${formatBytes(data.disk.free_bytes)} free.` : '');
    clearTimeout(timer);
    if (downloading && document.body.contains(list)) timer = setTimeout(refresh, 1000);
  };
  const serverRow = (m, selected) => {
    const inUse = selected === m.id && m.downloaded;
    const pct = m.total_bytes ? Math.round((m.done_bytes || 0) / m.total_bytes * 100) : 0;
    const prog = m.downloading ? h('div', { class: 'progress' }, h('i', { style: { width: (m.phase === 'downloading' ? pct : m.phase === 'preparing' ? 100 : 3) + '%' } })) : null;
    const buttons = [];
    if (m.runs_here !== false) {
      if (!m.downloaded && !m.downloading) buttons.push(h('button', { class: 'btn primary', onclick: async (e) => { e.target.disabled = true; try { await downloadServerModel(cfg(), m.id); } catch (err) { toast(err.message); } refresh(); } }, m.bytes ? 'Finish download' : 'Download'));
      if (m.downloaded && !inUse) buttons.push(h('button', { class: 'btn', onclick: async () => { try { await selectServerModel(cfg(), m.id); set({ tts: { 'openai-speech': { ...cfg(), model: m.id } } }); toast(`${m.name} is now the voice.`); if (m.id !== 'kokoro') await prerenderFor(cfg(), m.id).catch(() => {}); } catch (err) { toast(err.message); } rerender(); } }, 'Use'));
    }
    if (m.bytes && m.deletable && !m.downloading) buttons.push(h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, onclick: async () => {
      if (!confirmTap('srv-' + m.id, m.name)) return;
      try {
        const r = await deleteServerModel(cfg(), m.id);
        if (inUse) set({ tts: { 'openai-speech': { ...cfg(), model: r?.selected || 'kokoro' } } });
        toast(`${m.name} deleted from your computer. ${formatBytes(r?.freed_bytes || m.bytes)} freed.`);
      } catch (err) { toast(err.message); }
      rerender();
    } }, 'Delete'));
    const status = m.downloading
      ? (m.phase === 'installing' ? 'Installing the Mac voice engine (once)…'
        : m.phase === 'preparing' ? 'Getting it ready: loading it and speaking a first line…'
          : `Downloading · ${formatBytes(m.done_bytes)} of ${formatBytes(m.total_bytes)}`)
      : m.runs_here === false ? `Mac only · ${m.size_note}`
        : m.downloaded ? `On your computer · ${formatBytes(m.bytes)}`
          : m.bytes ? `Partly downloaded · ${formatBytes(m.bytes)} of ${m.size_note}` : `Not downloaded · ${m.size_note}`;
    return row(m, {
      inUse, status, buttons, prog,
      note: m.error ? `Last download failed: ${m.error}` : m.runs_here === false ? m.why_not : (!m.deletable && m.downloaded ? m.keep_reason : null),
    });
  };
  const refresh = () => listServerModels(cfg()).then(draw).catch((err) => {
    clear(list); list.append(h('p', { class: 'status bad', style: { margin: 0 } }, err.message || String(err)));
  });
  refresh();
}

// ---------- pre-recording scripted lines on Holding Local ----------
async function prerenderFor(cfg, model) {
  const a = store.data.archetype;
  return startPrerender(cfg, { model, texts: scriptedTexts(a, S()), voice: await voiceFor('openai-speech', a), exaggeration: feelingFor(a) });
}

function prerenderBlock(cfg, model) {
  const a = store.data.archetype;
  const status = h('p', { class: 'status vm-status' }, 'Checking…');
  const prog = h('div', { class: 'progress', style: { display: 'none' } }, h('i'));
  const btns = h('div', { class: 'row wrap' });
  const box = h('div', { class: 'vm-row' },
    h('div', { class: 'vm-head' }, h('b', {}, `${a.name}'s lines, recorded ahead`)),
    h('p', { class: 'muted vm-blurb' }, `${model.name} takes a moment to speak live. Your computer can record every scripted line once, in the background, so they play at once${model.feeling ? ' with feeling' : ''}. Your typed conversations are still spoken live.`),
    status, prog, btns);
  let timer = 0;
  const draw = (job) => {
    // A finished job for another model says nothing about this one.
    const j = job.model && job.model !== model.id && !job.running ? { running: false, done: 0, total: 0, lines_bytes: model.lines_bytes } : job;
    clear(btns);
    const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
    prog.style.display = j.running ? '' : 'none';
    prog.firstChild.style.width = pct + '%';
    const left = j.running && j.rendered > 2 && j.seconds ? Math.round((j.seconds / j.rendered) * (j.total - j.done) / 60) : null;
    status.className = 'status vm-status' + (j.error ? ' bad' : j.total && !j.running && j.done === j.total ? ' ok' : '');
    status.textContent = j.error ? `Stopped: ${j.error}`
      : j.running ? `Recording ${j.done} of ${j.total} lines${left != null ? `, about ${left} min left` : ''}. Leave Holding Local running.`
        : j.total && j.done === j.total ? `All ${j.total} lines recorded · ${formatBytes(j.lines_bytes || model.lines_bytes)}`
          : j.total ? `Stopped at ${j.done} of ${j.total} lines.` : `Not recorded yet${model.lines_bytes ? ` · ${formatBytes(model.lines_bytes)} of lines kept` : ''}.`;
    if (j.running) btns.append(h('button', { class: 'btn ghost', onclick: async () => { await stopPrerender(cfg()).catch(() => {}); refresh(); } }, 'Stop'));
    else btns.append(h('button', { class: 'btn', onclick: async (e) => { e.target.disabled = true; try { await prerenderFor(cfg(), model.id); } catch (err) { toast(err.message); } refresh(); } }, j.total && j.done === j.total && j.model === model.id ? (model.feeling ? 'Record again with this feeling' : 'Record again') : 'Record the lines'));
    clearTimeout(timer);
    if (j.running && document.body.contains(box)) timer = setTimeout(refresh, 2000);
  };
  const refresh = () => prerenderStatus(cfg()).then(draw).catch((err) => { status.className = 'status bad vm-status'; status.textContent = err.message; });
  refresh();
  return box;
}
