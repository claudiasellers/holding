// Widget mode: a small, always-there parent for the Mac menu-bar widget (mac-widget/) or any
// tiny window. Opened with ?widget=1. The resting screen is just the face, breathing, with
// "Hold me" one click away; the parent speaks first, so nothing has to be typed or said.
import './widget.css';
import { h } from './dom.js';
import { mountFace } from './faceview.js';
import { store } from '../store.js';

const q = new URLSearchParams(location.search);
/** True inside the native Mac widget, or when the page was opened with ?widget=1. */
export const isWidget = q.has('widget') || !!window.HoldingWidgetNative;

/** Talk to the native shell, if there is one. Messages: {type:'size', size:'compact'|'large'}, {type:'hide'}, {type:'openFull'}. */
export function toNative(msg) {
  try { window.webkit?.messageHandlers?.holding?.postMessage(msg); } catch { /* not in the Mac widget */ }
}

// Screens that need room ask the window to grow; everything else stays widget-sized.
const LARGE = new Set(['builder', 'settings', 'memory']);
export function sizeFor(screen) { return LARGE.has(screen) ? 'large' : 'compact'; }

export function renderWidget(root, nav) {
  const a = store.data.archetype;
  const box = h('div', { class: 'widget-face' });
  const el = h('main', { class: 'widget' },
    box,
    h('div', { class: 'widget-name' }, a.name),
    h('div', { class: 'widget-actions' },
      h('button', { class: 'btn primary', onclick: () => nav('session', { mode: 'hold' }), title: `${a.name} speaks first. You don't have to say anything.` }, 'Hold me'),
      h('button', { class: 'btn', onclick: () => nav('session', { mode: 'talk' }) }, 'Talk')),
    h('div', { class: 'widget-more' },
      h('button', { class: 'linkish', onclick: () => nav('builder') }, 'Change'),
      h('button', { class: 'linkish', onclick: () => nav('memory') }, 'Memory'),
      h('button', { class: 'linkish', onclick: () => nav('settings') }, 'Settings')));
  root.append(el);
  const presence = mountFace(box, a, { ripple: false });
  setTimeout(() => presence.mirror('glad', .4), 700);
  return () => presence.destroy();
}
