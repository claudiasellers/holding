// Settings → AI → Chat models on your computer: the language models Holding Local
// keeps in Ollama, with their sizes. Pick one, download another, or delete the
// ones you don't use to get the space back. Same look as the Voice models list.
//
// GET    /v1/chat-models               -> { models, selected, suggested, disk, pull }
// POST   /v1/chat-models/select {name} -> the model used when a request names none
// POST   /v1/chat-models/pull {name}   -> background download; progress in GET .pull
// DELETE /v1/chat-models/pull          -> stop that download
// DELETE /v1/chat-models/{name}        -> delete, returns { freed_bytes }
import { h, clear, toast } from './dom.js';
import { formatBytes } from '../voice/models.js';

function api(cfg = {}) {
  const base = String(cfg.baseUrl || 'http://127.0.0.1:8787/v1').replace(/\/$/, '');
  const headers = cfg.token ? { Authorization: `Bearer ${cfg.token}`, 'X-Pair-Token': cfg.token } : {};
  return async (path, init = {}) => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(60000) });
    let body = null; try { body = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw new Error(body?.detail || body?.error?.message || (r.status === 404 && path === '/chat-models' ? 'This Holding Local is too old to manage chat models. Update it and try again.' : `Holding Local answered ${r.status}`));
    return body;
  };
}

export const listChatModels = (cfg) => api(cfg)('/chat-models');
export const selectChatModel = (cfg, name) => api(cfg)('/chat-models/select', { method: 'POST', body: JSON.stringify({ name }) });
export const pullChatModel = (cfg, name) => api(cfg)('/chat-models/pull', { method: 'POST', body: JSON.stringify({ name }) });
export const stopChatPull = (cfg) => api(cfg)('/chat-models/pull', { method: 'DELETE' });
export const deleteChatModel = (cfg, name) => api(cfg)(`/chat-models/${encodeURIComponent(name)}`, { method: 'DELETE' });

const sameModel = (a, b) => !!a && !!b && (a.includes(':') ? a : `${a}:latest`) === (b.includes(':') ? b : `${b}:latest`);

const armed = new Map();
function confirmTap(key, label) {
  const t = armed.get(key);
  if (t && Date.now() - t < 4000) { armed.delete(key); return true; }
  armed.set(key, Date.now()); toast(`Tap "Delete" again to remove ${label}.`); return false;
}

/**
 * @param {{ cfg: () => object, setModel: (name: string) => void, rerender: () => void }} hooks
 *   cfg: the app's Holding Local connection ({ baseUrl, token, model }).
 *   setModel: point the app at a model (the app names its model on every request).
 */
export function chatModelsPanel({ cfg, setModel, rerender }) {
  const list = h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Checking your computer…'));
  const foot = h('p', { class: 'muted', style: { margin: 0, fontSize: '.85rem' } }, '');
  const wrap = h('div', { class: 'stack vm' },
    h('div', { class: 'lbl', style: { fontWeight: 600 } }, 'Chat models on your computer',
      h('small', { style: { display: 'block', fontWeight: 400 } }, 'These write the parent\'s words. Each one takes several GB. Delete the ones you don\'t use to get the space back.')),
    list, foot);
  let timer = 0;

  const draw = (data) => {
    clear(list);
    // The app names its model on each request; the computer's own pick covers "default".
    const appModel = cfg().model && cfg().model !== 'default' ? cfg().model : data.selected;
    const using = (name) => sameModel(name, appModel);
    for (const m of data.models || []) {
      const inUse = using(m.name);
      const buttons = [];
      if (m.kind === 'chat' && !inUse) {
        buttons.push(h('button', { class: 'btn', onclick: async () => {
          try { await selectChatModel(cfg(), m.name); setModel(m.name); toast(`The parent now uses ${m.name}.`); } catch (err) { toast(err.message); }
          rerender();
        } }, 'Use'));
      }
      const locked = !m.deletable || inUse;
      if (!locked) {
        buttons.push(h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, onclick: async () => {
          if (!confirmTap('chat-' + m.name, m.name)) return;
          try {
            const r = await deleteChatModel(cfg(), m.name);
            toast(`${m.name} deleted. ${formatBytes(r?.freed_bytes || m.bytes)} freed.`);
          } catch (err) { toast(err.message); }
          refresh();
        } }, 'Delete'));
      }
      list.append(h('div', { class: 'vm-row' + (inUse ? ' on' : '') },
        h('div', { class: 'vm-head' }, h('b', {}, m.name), inUse ? h('span', { class: 'vm-badge' }, 'In use') : null, m.kind === 'embed' ? h('span', { class: 'vm-badge soft' }, 'Memory') : null),
        h('p', { class: 'status vm-status' }, `On your computer · ${formatBytes(m.bytes)}` + (m.parameter_size ? ` · ${m.parameter_size}` : '')),
        m.note ? h('p', { class: 'muted vm-note' }, m.note) : null,
        locked && m.keep_reason ? h('p', { class: 'muted vm-note' }, m.keep_reason) : inUse ? h('p', { class: 'muted vm-note' }, 'The parent uses this one. Pick another one first to delete it.') : null,
        buttons.length ? h('div', { class: 'row wrap' }, buttons) : null));
    }
    const pull = data.pull || {};
    if (pull.running || pull.error) {
      const pct = pull.total ? Math.round((pull.done || 0) / pull.total * 100) : 2;
      list.append(h('div', { class: 'vm-row' },
        h('div', { class: 'vm-head' }, h('b', {}, pull.name)),
        h('p', { class: 'status vm-status' + (pull.error ? ' bad' : '') }, pull.error ? `Download failed: ${pull.error}` : pull.total ? `Downloading · ${formatBytes(pull.done)} of ${formatBytes(pull.total)}` : 'Starting the download…'),
        pull.running ? h('div', { class: 'progress' }, h('i', { style: { width: pct + '%' } })) : null,
        pull.running ? h('div', { class: 'row wrap' }, h('button', { class: 'btn ghost', onclick: async () => { await stopChatPull(cfg()).catch(() => {}); refresh(); } }, 'Stop')) : null));
    }
    const sug = (data.suggested || []).filter((s) => !(pull.running && sameModel(s.name, pull.name)));
    if (sug.length) {
      list.append(h('div', { class: 'vm-group' }, h('b', {}, 'Others you can download'), h('small', { class: 'muted' }, 'Bigger models write warmer, more careful replies but need more memory.')));
      for (const s of sug) {
        list.append(h('div', { class: 'vm-row' },
          h('div', { class: 'vm-head' }, h('b', {}, s.name)),
          h('p', { class: 'status vm-status' }, `Not downloaded · ${s.download}`),
          h('p', { class: 'muted vm-note' }, s.fits ? s.note : `${s.note} This computer probably doesn't have enough memory for it.`),
          h('div', { class: 'row wrap' }, h('button', { class: 'btn', disabled: !!pull.running, onclick: async (e) => {
            e.target.disabled = true;
            try { await pullChatModel(cfg(), s.name); } catch (err) { toast(err.message); }
            refresh();
          } }, 'Download'))));
      }
    }
    foot.textContent = `Chat models use ${formatBytes(data.total_bytes)} on your computer.` + (data.disk?.free_bytes != null ? ` It has ${formatBytes(data.disk.free_bytes)} free.` : '');
    clearTimeout(timer);
    if (pull.running && document.body.contains(list)) timer = setTimeout(refresh, 1000);
    else if (pull.status === 'success' && !draw.announced?.has(pull.name)) { (draw.announced ||= new Set()).add(pull.name); toast(`${pull.name} is downloaded. Tap Use to switch to it.`); }
  };
  const refresh = () => listChatModels(cfg()).then(draw).catch((err) => {
    clear(list); list.append(h('p', { class: 'status bad', style: { margin: 0 } }, err.message || String(err)));
  });
  refresh();
  return wrap;
}
