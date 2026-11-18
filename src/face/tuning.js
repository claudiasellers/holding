// Tune expression amplitudes to each face's features. The same action unit
// reads differently on different faces: a heavy brow hides brow motion, hooded
// lids hide lid motion, a beard hides mouth corners, creases on an older face
// make a small smile read big. Gains here make each face's expressions read
// at the intended strength — that is what "tuned to their facial features" means.
import { AU_KEYS } from './expressions.js';

export function computeTuning(face, expressive = {}) {
  const g = {}; for (const k of AU_KEYS) g[k] = 1;
  const notes = [];
  const age = face.age ?? 50;
  const ageF = Math.max(0, Math.min(1, (age - 30) / 50));       // 0 at 30, 1 at 80
  const brows = face.brows || {}, eyes = face.eyes || {}, mouth = face.mouth || {};

  // Brows: thick brows move less visibly; high arches already look surprised.
  const thick = brows.thick ?? .5, arch = brows.arch ?? .5;
  const browG = 1 + (thick - .5) * .5 - (arch - .5) * .45;
  g.au1 *= browG; g.au2 *= browG * (1 - (arch - .5) * .3); g.au4 *= 1 + (thick - .5) * .3;
  if (Math.abs(browG - 1) > .05) notes.push(`brow motion ×${browG.toFixed(2)} (thickness ${thick.toFixed(2)}, arch ${arch.toFixed(2)})`);

  // Glasses frame the eyes: brows must clear the frame to read.
  if (face.glasses && face.glasses !== 'none') { g.au1 *= 1.15; g.au2 *= 1.15; notes.push('brows ×1.15 to clear glasses'); }

  // Hooded lids hide lid tightening; carry warmth through the cheeks instead.
  const lid = eyes.lid ?? .3;
  g.au7 *= 1 + lid * .6; g.au43 *= 1 + lid * .25; g.au6 *= 1 + lid * .3;
  if (lid > .45) notes.push(`hooded lids: lid ×${(1 + lid * .6).toFixed(2)}, cheeks ×${(1 + lid * .3).toFixed(2)}`);

  // Big eyes exaggerate closure; small eyes need a little more.
  const es = eyes.size ?? .5;
  g.au43 *= 1 - (es - .5) * .4;

  // Mouth: wide mouths exaggerate corner movement; full lips show it more.
  const mw = mouth.width ?? .5, lips = mouth.lips ?? .5;
  const mouthG = 1 / (0.75 + mw * .5) * (1 - (lips - .5) * .2);
  g.au12 *= mouthG; g.au15 *= mouthG;
  notes.push(`mouth corners ×${mouthG.toFixed(2)} (width ${mw.toFixed(2)})`);

  // Facial hair hides corners and chin: shift the message to brows and tilt.
  if (face.beard === 'full' || face.beard === 'short') {
    const h = face.beard === 'full' ? .45 : .25;
    g.au15 *= 1 + h; g.au17 *= 1 - h; g.au1 *= 1 + h * .4; g.tilt *= 1 + h * .5; g.au6 *= 1 + h * .3;
    notes.push(`${face.beard} beard: corners ×${(1 + h).toFixed(2)}, brows ×${(1 + h * .4).toFixed(2)}, tilt ×${(1 + h * .5).toFixed(2)}`);
  }
  if (face.mustache) { g.au12 *= 1.2; g.au6 *= 1.1; notes.push('mustache: smile ×1.2, cheeks ×1.1'); }

  // Age: creases deepen warmth, so a smaller smile reads as warm.
  g.au12 *= 1 - ageF * .2; g.au6 *= 1 - ageF * .1;
  if (ageF > .3) notes.push(`age ${age}: smile ×${(1 - ageF * .2).toFixed(2)} (creases carry warmth)`);

  // Face shape: round faces get gentler tilt; long faces read tilt less.
  const shapeTilt = { round: .8, oval: 1, long: 1.2, square: .9, heart: 1 }[face.shape] ?? 1;
  g.tilt *= shapeTilt;

  // Archetype-level expressiveness.
  const gain = expressive.gain ?? 1;
  for (const k of AU_KEYS) if (k !== 'gx' && k !== 'gy') g[k] *= gain;

  return { gains: g, ageF, notes };
}

export function applyTuning(e, gains) {
  const o = {}; for (const k in e) o[k] = e[k] * (gains[k] ?? 1); return o;
}
