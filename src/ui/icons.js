// Small drawn icon set for the session (one stroke weight, currentColor).
// Returned as a span so it can sit inside any button built with h().
import { h } from './dom.js';

const P = {
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  undo: '<path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-2"/>',
  keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2.5"/><path d="M7 10.5h.01M10.3 10.5h.01M13.7 10.5h.01M17 10.5h.01M8 14h8"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  send: '<path d="M4.5 12 19.5 4.5 15 19.5l-3.2-6.3z"/><path d="m11.8 13.2 7.7-8.7"/>',
  log: '<path d="M5 6.5h14M5 11.5h14M5 16.5h9"/>',
  bookmark: '<path d="M7 3.5h10v17l-5-3.6-5 3.6z"/>',
  talk: '<path d="M4 12a8 8 0 1 1 3.3 6.5L4 19.5l1-3.3A8 8 0 0 1 4 12z"/><path d="M9 11.5h.01M12 11.5h.01M15 11.5h.01"/>',
  spark: '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M18 6l-2.6 2.6M8.6 15.4 6 18"/>',
  door: '<path d="M14 4.5H6.5v15H14"/><path d="M11 12h9M17 9l3 3-3 3"/>',
  home: '<path d="M4 11 12 4.5 20 11"/><path d="M6.5 9.5v10h11v-10"/>',
};

export function icon(name) {
  return h('span', { class: 'ico', 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>` });
}
