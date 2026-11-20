// Settings → What's downloaded: one list of everything the parent has downloaded,
// wherever it lives. In this browser: chat models for the in-browser AI and voices.
// On your computer (Holding Local): chat models and voices. Each row says what it's
// for, where it is, how big it is, whether it's in use, and has Delete.
import { h, clear, toast } from './dom.js';
import { store } from '../store.js';
import { cachedBrowserModels, deleteBrowserModel, DEFAULT_WEBLLM_MODEL } from '../ai/webllm.js';
import { VOICE_MODELS, cachedSize, deleteCached, storageEstimate, formatBytes } from '../voice/models.js';
import { getTTSProvider } from '../voice/providers.js';
import { listChatModels, deleteChatModel } from './chat-models.js';
import { listServerModels, deleteServerModel } from '../voice/server-models.js';
import { isLocalUrl, isHoldingLocal } from './now.js';
import { friendlyError } from './errors.js';

const S = () => store.settings;
const sameModel = (a, b) => !!a && !!b && (a.includes(':') ? a : `${a}:latest`) === (b.includes(':') ? b : `${b}:latest`);

/** The Holding Local connection to ask, if one is set up: { baseUrl, token } or null. */
export function localConnection(s = S()) {
  const ai = s.ai?.['openai-local'];
  if (ai && isHoldingLocal(ai)) return { baseUrl: ai.baseUrl, token: ai.token || ai.apiKey || '' };
  for (const c of [s.tts?.['openai-speech'], s.stt]) {
    if (c && isLocalUrl(c.baseUrl)) return { baseUrl: c.baseUrl, token: c.token || c.apiKey || '' };
  }
  return null;
}

/** Two taps to delete: the button itself says "Tap again" for 4 seconds. */
function deleteButton(label, run) {
  const b = h('button', { class: 'btn ghost sm danger' }, 'Delete');
  b.setAttribute('aria-label', `Delete ${label}`);
  let timer = 0;
  b.onclick = async () => {
    if (!b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Tap again to delete';
      timer = setTimeout(() => { delete b.dataset.armed; b.textContent = 'Delete'; }, 4000);
      return;
    }
    clearTimeout(timer); b.disabled = true; b.textContent = 'Deleting…';
    await run();
  };
  return b;
}

function item({ kind, name, where, bytes, inUse, note, del }) {
  return h('div', { class: 'dl-row' + (inUse ? ' on' : '') },
    h('div', { class: 'dl-main' },
      h('div', { class: 'dl-head' }, h('span', { class: 'dl-kind' }, kind), h('b', {}, name), inUse ? h('span', { class: 'vm-badge' }, 'In use') : null),
      h('small', {}, `${where} · ${formatBytes(bytes)}`),
      note ? h('small', { class: 'dl-note' }, note) : null),
    del || null);
}

/**
 * @param {{ rerender: () => void }} hooks  rerender: redraw Settings after a delete changes what's in use.
 */
export function downloadsCard({ rerender }) {
  const browser = h('div', { class: 'dl-list' }, h('p', { class: 'muted small' }, 'Checking this browser…'));
  const browserFoot = h('p', { class: 'muted small' });
  const computer = h('div', { class: 'dl-list' });
  const computerFoot = h('p', { class: 'muted small' });
  const conn = localConnection();
  const card = h('section', { class: 'card stack', id: 'downloads-card' },
    h('h2', {}, 'What\'s downloaded'),
    h('p', { class: 'muted lead' }, 'Everything the parent has downloaded, and where it lives. Delete anything to get the space back.'),
    h('h3', { class: 'dl-place' }, 'In this browser'), browser, browserFoot,
    conn ? h('h3', { class: 'dl-place' }, 'On your computer (Holding Local)') : null, conn ? computer : null, conn ? computerFoot : null);

  // ---- this browser
  (async () => {
    const s = S();
    const rows = [];
    let total = 0;
    const chats = await cachedBrowserModels().catch(() => []);
    for (const m of chats) {
      const want = s.ai?.webllm?.model || DEFAULT_WEBLLM_MODEL;
      const inUse = s.ai?.provider === 'webllm' && (m.id === want || (want === 'auto' && m === chats[0]));
      total += m.bytes;
      rows.push(item({ kind: 'Words', name: m.label, where: 'In this browser', bytes: m.bytes, inUse,
        note: inUse ? 'The AI on this device. Deleting it means it downloads again next time.' : (s.ai?.provider === 'openai-local' ? 'Holding Local keeps its own copies, so this one isn\'t used.' : null),
        del: deleteButton(m.label, async () => {
          try { await deleteBrowserModel(m.id); toast(`${m.label} deleted. ${formatBytes(m.bytes)} freed.`); } catch (e) { toast(friendlyError(e, 'delete')); }
          rerender();
        }) }));
    }
    for (const m of VOICE_MODELS) {
      const { bytes } = await cachedSize(m);
      if (!bytes) continue;
      total += bytes;
      const inUse = s.voiceOn && s.tts?.provider === m.provider;
      const partial = bytes < m.sizeMB * 1e6 * 0.5;
      rows.push(item({ kind: 'Voice', name: m.name, where: partial ? 'Partly downloaded' : 'In this browser', bytes, inUse,
        note: inUse ? 'Deleting it switches the parent to the device voice.' : null,
        del: deleteButton(m.name, async () => {
          try {
            if (s.tts?.provider === m.provider) store.setSettings({ tts: { provider: 'webspeech' } });
            await getTTSProvider(m.provider)?.dispose?.();
            const freed = await deleteCached(m);
            toast(`${m.name} deleted. ${formatBytes(freed || bytes)} freed.`);
          } catch (e) { toast(friendlyError(e, 'delete')); }
          rerender();
        }) }));
    }
    clear(browser);
    if (!rows.length) browser.append(h('p', { class: 'muted small' }, 'Nothing downloaded here yet. The device voice is built in.'));
    else browser.append(...rows);
    const est = await storageEstimate();
    const free = est?.quota && est?.usage != null ? est.quota - est.usage : null;
    browserFoot.textContent = rows.length ? `${formatBytes(total)} in this browser.${free != null ? ` Room for about ${formatBytes(free)} more.` : ''}` : '';
  })();

  // ---- your computer
  if (conn) {
    computer.append(h('p', { class: 'muted small' }, 'Asking your computer…'));
    Promise.allSettled([listChatModels(conn), listServerModels(conn)]).then(([chatR, voiceR]) => {
      const s = S();
      clear(computer);
      if (chatR.status === 'rejected' && voiceR.status === 'rejected') {
        computer.append(h('p', { class: 'status bad' }, `${friendlyError(chatR.reason, 'list')} Its downloads will show here when it answers.`));
        return;
      }
      let total = 0;
      const rows = [];
      if (chatR.status === 'fulfilled') {
        const data = chatR.value || {};
        const appModel = s.ai?.['openai-local']?.model && s.ai['openai-local'].model !== 'default' ? s.ai['openai-local'].model : data.selected;
        for (const m of data.models || []) {
          const inUse = s.ai?.provider === 'openai-local' && m.kind === 'chat' && sameModel(m.name, appModel);
          total += m.bytes || 0;
          const locked = !m.deletable || inUse;
          rows.push(item({ kind: m.kind === 'embed' ? 'Memory' : 'Words', name: m.name, where: 'On your computer', bytes: m.bytes, inUse,
            note: inUse ? 'Pick another chat model under Your computer before deleting this one.' : (!m.deletable ? m.keep_reason : null),
            del: locked ? null : deleteButton(m.name, async () => {
              try { const r = await deleteChatModel(conn, m.name); toast(`${m.name} deleted. ${formatBytes(r?.freed_bytes || m.bytes)} freed.`); } catch (e) { toast(friendlyError(e, 'delete')); }
              rerender();
            }) }));
        }
      }
      if (voiceR.status === 'fulfilled') {
        const data = voiceR.value || {};
        const selected = s.tts?.['openai-speech']?.model || data.selected || 'kokoro';
        for (const m of (data.models || []).filter((x) => x.downloaded || x.bytes)) {
          const bytes = (m.bytes || 0) + (m.lines_bytes || 0);
          total += bytes;
          const inUse = s.voiceOn && s.tts?.provider === 'openai-speech' && selected === m.id && m.downloaded;
          rows.push(item({ kind: 'Voice', name: m.name, where: m.downloaded ? 'On your computer' : 'Partly downloaded', bytes, inUse,
            note: m.lines_bytes ? `Includes ${formatBytes(m.lines_bytes)} of lines recorded ahead.` : (!m.deletable ? m.keep_reason : null),
            del: m.deletable && !m.downloading ? deleteButton(m.name, async () => {
              try {
                const r = await deleteServerModel(conn, m.id);
                if (selected === m.id) store.setSettings({ tts: { 'openai-speech': { ...(s.tts['openai-speech'] || {}), model: r?.selected || 'kokoro' } } });
                toast(`${m.name} deleted from your computer. ${formatBytes(r?.freed_bytes || bytes)} freed.`);
              } catch (e) { toast(friendlyError(e, 'delete')); }
              rerender();
            }) : null }));
        }
        total += data.engine_bytes || 0;
      }
      if (!rows.length) computer.append(h('p', { class: 'muted small' }, 'Nothing downloaded on your computer yet.'));
      else computer.append(...rows);
      const free = chatR.value?.disk?.free_bytes ?? voiceR.value?.disk?.free_bytes;
      computerFoot.textContent = `${formatBytes(total)} on your computer.${free != null ? ` It has ${formatBytes(free)} free.` : ''}`;
    });
  }
  return card;
}
