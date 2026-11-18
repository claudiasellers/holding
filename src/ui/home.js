import { h } from './dom.js';
import { mountFace } from './faceview.js';
import { store } from '../store.js';

export function renderHome(root, nav) {
  const a = store.data.archetype;
  const box = h('div', { class: 'home-face' });
  const eps = store.data.episodes;
  const lastHold = [...eps].reverse().find((e) => e.mode === 'hold');
  const recent = lastHold && Date.now() - lastHold.at < 3 * 864e5;
  const screen = h('main', { class: 'screen' },
    h('div', { class: 'topbar' },
      h('span', { class: 'title' }, 'Holding'),
      h('div', { class: 'row' },
        h('button', { class: 'icon-btn', onclick: () => nav('memory'), 'aria-label': 'Memory and keepsakes' }, 'Memory'),
        h('button', { class: 'icon-btn', onclick: () => nav('settings'), 'aria-label': 'Settings' }, 'Settings'))),
    box,
    h('h1', { class: 'home-name' }, a.name),
    h('p', { class: 'hold-hint' }, a.title),
    h('div', { class: 'home-actions' },
      h('button', { class: 'btn primary big', onclick: () => nav('session', { mode: 'hold' }) }, 'Hold me'),
      h('p', { class: 'hold-hint' }, `${a.name} speaks first. You don't have to say or type anything.`),
      h('button', { class: 'btn', onclick: () => nav('session', { mode: 'talk' }) }, 'Just talk'),
      recent ? h('button', { class: 'btn', onclick: () => nav('session', { mode: 'makesense' }) }, 'Make sense of a hard night') : null,
      h('button', { class: 'btn ghost', onclick: () => nav('builder') }, `Change or build a parent figure`)),
    h('p', { class: 'disclaimer' }, `${a.name} is an AI companion, not a person and not a therapist. Everything stays on this device. If you might hurt yourself, call or text 988 (US) or your local emergency number.`));
  root.append(screen);
  const presence = mountFace(box, a, { ripple: false });
  setTimeout(() => presence.mirror('glad', .45), 700);   // glad you came (delight, IPF)
  return () => presence.destroy();
}
