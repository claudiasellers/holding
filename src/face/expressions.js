// FACS-style action units. Values are 0..1 unless noted.
// au1 inner brow raise · au2 outer brow raise · au4 brow lower/furrow
// au5 upper lid raise · au6 cheek raise (warm eyes) · au7 lid tighten
// au12 lip corner pull (smile) · au15 lip corner depress · au17 chin raise
// au25 lips part · au26 jaw drop · au43 eyes closing (soft/slow)
// tilt: head tilt in -1..1 (scaled by archetype) · gx, gy: gaze -1..1
export const AU_KEYS = ['au1', 'au2', 'au4', 'au5', 'au6', 'au7', 'au12', 'au15', 'au17', 'au25', 'au26', 'au43', 'tilt', 'gx', 'gy'];

export function zero() { const o = {}; for (const k of AU_KEYS) o[k] = 0; return o; }
export function au(partial) { return { ...zero(), ...partial }; }

// The parent's own resting states. "holding" is the steady-warm baseline the
// face always returns to: soft cheeks, the hint of a smile, nothing alarmed.
export const OWN = {
  holding:   au({ au6: .35, au12: .24, au1: .15, au2: .04, au43: .08 }),
  listening: au({ au6: .3, au12: .14, au1: .2, au2: .08, tilt: .35 }),
  speaking:  au({ au6: .32, au12: .2, au1: .12 }),
  delight:   au({ au6: .8, au12: .75, au25: .18, au2: .15 }),
  resting:   au({ au6: .25, au12: .12, au43: .35 }),           // very quiet presence
  flash:     au({ au1: .55, au2: .65, au6: .35, au12: .25 }),  // ostensive eyebrow flash ("this is for you")
};

// Signature form of each user affect, as it would look on the parent if it were
// simply mirrored. mirror.js marks these: it exaggerates the signature AUs but
// keeps the parent's own steady cues (cheeks, no lid widening, tilt).
export const AFFECT_FORMS = {
  sad:         au({ au1: .9, au15: .65, au17: .25, au4: .15, au43: .15, tilt: .6, gy: .1 }),
  scared:      au({ au1: .8, au2: .35, au4: .3, au12: .02, au25: .08, au43: .2 }),
  angry:       au({ au4: .85, au7: .3, au17: .35, au15: .1 }),
  ashamed:     au({ au1: .5, au15: .3, au43: .2, gy: .55, gx: -.2, tilt: .5 }),
  numb:        au({ au43: .3, au12: .04, au1: .15 }),
  overwhelmed: au({ au1: .7, au15: .3, au43: .5, au25: .3, tilt: .3 }),
  lonely:      au({ au1: .7, au15: .45, au12: .08, tilt: .9, gy: .1 }),
  calm:        au({ au6: .3, au12: .2, au43: .25 }),
  hopeful:     au({ au1: .3, au2: .3, au12: .5, au6: .5 }),
  glad:        au({ au6: .8, au12: .8, au25: .22, au2: .15 }),
};

// Never shown by the parent: these are the hostile and frightened parent's faces.
// mirror.js enforces these caps on every frame.
export const CAPS = { au5: 0.05, au7: 0.45, au4: 0.75 };

export function lerp(a, b, t) {
  const o = {};
  for (const k of AU_KEYS) o[k] = a[k] + (b[k] - a[k]) * t;
  return o;
}
export function add(a, b, s = 1) {
  const o = {};
  for (const k of AU_KEYS) o[k] = a[k] + b[k] * s;
  return o;
}
export function clampAU(e) {
  const o = {};
  for (const k of AU_KEYS) {
    const lo = (k === 'tilt' || k === 'gx' || k === 'gy') ? -1 : 0;
    o[k] = Math.max(lo, Math.min(1.25, e[k]));
  }
  for (const k in CAPS) o[k] = Math.min(o[k], CAPS[k]);
  return o;
}
export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
