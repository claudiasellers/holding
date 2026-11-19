// Settings → AI → Chat models in this browser: the in-browser AI's downloads
// (WebLLM, kept in this browser's storage), with sizes and Delete. Holding Local
// can't use these files: they're a WebGPU build of the model, and Holding Local
// runs its own copies through Ollama. So once the parent uses your computer, these
// are only taking up space. Renders nothing when the browser holds none.
import { h, clear, toast } from './dom.js';
import { cachedBrowserModels, deleteBrowserModel } from '../ai/webllm.js';
import { formatBytes } from '../voice/models.js';

const armed = new Map();
function confirmTap(key, label) {
  const t = armed.get(key);
  if (t && Date.now() - t < 4000) { armed.delete(key); return true; }
  armed.set(key, Date.now()); toast(`Tap "Delete" again to remove ${label}.`); return false;
}

/**
 * @param {{ provider: string, model?: string }} opts  provider: what writes the parent's words now;
 *   model: the in-browser model picked in Settings (marked In use while that's the provider).
 */
export function browserModelsPanel({ provider, model }) {
  const wrap = h('div', { class: 'stack vm', hidden: true });
  const draw = (list) => {
    clear(wrap);
    if (!list.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const total = list.reduce((n, m) => n + m.bytes, 0);
    const local = provider === 'openai-local' || provider === 'holding-rag';
    wrap.append(h('div', { class: 'lbl', style: { fontWeight: 600 } }, 'Chat models in this browser',
      h('small', { style: { display: 'block', fontWeight: 400 } }, local
        ? 'The parent uses your computer now, and Holding Local can\'t use these browser copies (it keeps its own). Delete them to get the space back.'
        : 'Downloaded by the in-browser AI. Holding Local on a computer can\'t reuse them; it downloads its own.')));
    for (const m of list) {
      const inUse = provider === 'webllm' && (m.id === model || list.length === 1);
      wrap.append(h('div', { class: 'vm-row' + (inUse ? ' on' : '') },
        h('div', { class: 'vm-head' }, h('b', {}, m.label), inUse ? h('span', { class: 'vm-badge' }, 'In use') : null),
        h('p', { class: 'status vm-status' }, `In this browser · ${formatBytes(m.bytes)}`),
        inUse ? h('p', { class: 'muted vm-note' }, 'Deleting it means the in-browser AI downloads it again next time.') : null,
        h('div', { class: 'row wrap' }, h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, onclick: async (e) => {
          if (!confirmTap('webllm-' + m.id, m.label)) return;
          e.target.disabled = true;
          try { await deleteBrowserModel(m.id); toast(`${m.label} deleted. ${formatBytes(m.bytes)} freed.`); } catch (err) { toast(err.message || String(err)); }
          refresh();
        } }, 'Delete'))));
    }
    wrap.append(h('p', { class: 'muted', style: { margin: 0, fontSize: '.85rem' } }, `Chat models use ${formatBytes(total)} in this browser.`));
  };
  const refresh = () => cachedBrowserModels().then(draw).catch(() => { wrap.hidden = true; });
  refresh();
  return wrap;
}
