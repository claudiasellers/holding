import { h, clear, toast } from './dom.js';
import { store } from '../store.js';
import { getTTSProvider } from '../voice/providers.js';
import { voiceFor } from '../voice/resolve.js';

export function renderMemory(root, nav) {
  const a = store.data.archetype;
  const body = h('div', { class: 'stack' });
  root.append(h('main', { class: 'screen' },
    h('div', { class: 'topbar' }, h('span', { class: 'title' }, `What ${a.name} remembers`), h('button', { class: 'icon-btn', onclick: () => nav('home') }, 'Done')),
    h('p', { class: 'muted' }, 'Everything here is stored only on this device. You can delete any of it.'),
    body));

  async function play(text) {
    const tts = getTTSProvider(store.settings.tts.provider) || getTTSProvider('webspeech');
    const pre = window.HoldingMobile?.prerecorded;
    try {
      if (pre?.has && await Promise.resolve(pre.has(a.id, text)).catch(() => false)) { try { return await pre.play(a.id, text, {}); } catch {} }
      await tts.speak(text, { voiceId: await voiceFor(tts.id, a), rate: a.voice.rate * .9, pitch: a.voice.pitch, archetype: a });
    } catch (e) { toast('Voice unavailable'); }
  }

  function render() {
    clear(body);
    const d = store.data;
    const section = (title, hint, items, row, list) => h('section', { class: 'card stack' },
      h('h2', {}, title), hint ? h('p', { class: 'muted', style: { margin: 0 } }, hint) : null,
      items.length ? h('div', { class: 'list' }, items.map((it, i) => row(it, i, list))) : h('p', { class: 'muted' }, 'Nothing yet.'));
    const del = (list, i) => h('button', { class: 'pill', onclick: () => { store.remove(list, i); render(); }, 'aria-label': 'Delete' }, 'Delete');
    body.append(
      section('Keepsakes', 'Lines that helped. Play them any time.', d.keepsakes, (k, i) => h('div', { class: 'item' }, h('p', {}, k.text), h('div', { class: 'row' }, h('button', { class: 'pill', onclick: () => play(k.text) }, 'Play'), del('keepsakes', i)))),
      section('Your new rules', 'Written after hard nights. Each one is evidence against the old rule.', d.rules, (r, i) => h('div', { class: 'item' }, h('div', {}, h('p', {}, r.text), h('small', {}, `Evidence: ${(r.evidence || []).join(', ')}`)), h('div', { class: 'row' },
        h('button', { class: 'pill', onclick: () => { const rules = [...store.data.rules]; rules[i] = { ...r, evidence: [...(r.evidence || []), new Date().toISOString().slice(0, 10)] }; store.setData({ rules }); render(); toast('Another night of evidence.'); } }, '+ Evidence'), del('rules', i)))),
      section('Repairs', `Every time ${a.name} missed, and came back. Misses happen; repair is the point.`, [...d.repairs].reverse(), (r, i) => h('div', { class: 'item' }, h('div', {}, h('p', {}, `Missed: ${r.miss}`), h('small', {}, new Date(r.at).toLocaleString())), del('repairs', d.repairs.length - 1 - i))),
      section('Hard moments', 'Times you came here. No streaks, no scores.', [...d.episodes].reverse().slice(0, 30), (e, i) => h('div', { class: 'item' }, h('div', {}, h('p', {}, `${new Date(e.at).toLocaleDateString()} · ${e.mode === 'hold' ? 'Held' : e.mode === 'makesense' ? 'Made sense' : 'Talked'}${e.minutes ? ` · ${e.minutes} min` : ''}`), h('small', {}, [e.affect, e.afterSize ? `after: ${e.afterSize}` : e.after != null ? `after: ${e.after}/10` : ''].filter(Boolean).join(' · '))), del('episodes', d.episodes.length - 1 - i))),
    );
  }
  render();
  return () => {};
}
