// Settings → Voice → Voice models: download, use and delete voice models, and
// see the space each one takes. Two places a model can live:
//   - this browser (Kokoro, Chatterbox), kept in its model cache;
//   - Holding Local on your computer, when "Voice from my computer" is the engine.
import { h, clear, toast, slider } from './dom.js';
import { store } from '../store.js';
import { getTTSProvider } from '../voice/providers.js';
import { VOICE_MODELS, cachedSize, deleteCached, storageEstimate, formatBytes, canRun, isExpressive } from '../voice/models.js';
import { listServerModels, downloadServerModel, deleteServerModel, selectServerModel } from '../voice/server-models.js';
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
  if (!isExpressive(p, S().tts)) return null;
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
      note: can.ok ? null : can.reason,
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
    for (const m of data.models || []) {
      if (m.downloading) downloading = true;
      const inUse = selected === m.id && m.downloaded;
      const pct = m.total_bytes ? Math.round((m.done_bytes || 0) / m.total_bytes * 100) : 0;
      const prog = m.downloading ? h('div', { class: 'progress' }, h('i', { style: { width: pct + '%' } })) : null;
      const buttons = [];
      if (!m.downloaded && !m.downloading) buttons.push(h('button', { class: 'btn primary', onclick: async (e) => { e.target.disabled = true; try { await downloadServerModel(cfg(), m.id); } catch (err) { toast(err.message); } refresh(); } }, m.bytes ? 'Finish download' : 'Download'));
      if (m.downloaded && !inUse) buttons.push(h('button', { class: 'btn', onclick: async () => { try { await selectServerModel(cfg(), m.id); set({ tts: { 'openai-speech': { ...cfg(), model: m.id } } }); toast(`${m.name} is now the voice.`); } catch (err) { toast(err.message); } rerender(); } }, 'Use'));
      if (m.bytes && m.deletable && !m.downloading) buttons.push(h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, onclick: async () => {
        if (!confirmTap('srv-' + m.id, m.name)) return;
        try {
          const r = await deleteServerModel(cfg(), m.id);
          if (inUse) set({ tts: { 'openai-speech': { ...cfg(), model: r?.selected || 'kokoro' } } });
          toast(`${m.name} deleted from your computer. ${formatBytes(r?.freed_bytes || m.bytes)} freed.`);
        } catch (err) { toast(err.message); }
        rerender();
      } }, 'Delete'));
      list.append(row(m, {
        inUse,
        status: m.downloading ? `Downloading · ${formatBytes(m.done_bytes)} of ${formatBytes(m.total_bytes)}` : m.downloaded ? `On your computer · ${formatBytes(m.bytes)}` : m.bytes ? `Partly downloaded · ${formatBytes(m.bytes)} of ${m.size_note}` : `Not downloaded · ${m.size_note}`,
        note: m.error ? `Last download failed: ${m.error}` : (!m.deletable && m.downloaded ? m.keep_reason : null),
        buttons, prog,
      }));
    }
    const used = (data.models || []).reduce((n, m) => n + (m.bytes || 0), 0);
    foot.textContent = `Voices on your computer use ${formatBytes(used)}.` + (data.disk?.free_bytes != null ? ` It has ${formatBytes(data.disk.free_bytes)} free.` : '');
    clearTimeout(timer);
    if (downloading && document.body.contains(list)) timer = setTimeout(refresh, 1000);
  };
  const refresh = () => listServerModels(cfg()).then(draw).catch((err) => {
    clear(list); list.append(h('p', { class: 'status bad', style: { margin: 0 } }, err.message || String(err)));
  });
  refresh();
}
