import { createFace, createLight } from '../face/render.js';
import { createPresence } from '../face/mirror.js';
import { h } from './dom.js';
import { store } from '../store.js';

/** Mount an animated face (or the abstract light) and return its presence controller. */
export function mountFace(box, archetype, opts = {}) {
  box.classList.add('face-wrap');
  const halo = h('div', { class: 'halo' });
  const ripple = h('div', { class: 'ripple' });
  box.append(halo);
  const face = archetype.abstract ? createLight(box, archetype) : createFace(box, archetype, opts);
  box.append(ripple);
  const rm = store.settings.reducedMotion;
  const presence = createPresence(face, archetype, { reducedMotion: rm ?? undefined, bpm: opts.bpm });
  presence.on((ev, d) => {
    if (ev === 'phase' && d.phase === 'cue' && opts.ripple !== false) { ripple.classList.remove('go'); void ripple.offsetWidth; ripple.classList.add('go'); }
  });
  presence.face = face;
  return presence;
}
