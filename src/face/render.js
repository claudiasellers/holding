// Procedural SVG face. Static parts are built once per archetype; expression
// parts (brows, lids, mouth, cheeks, creases, head pose) update every frame
// from an action-unit vector. Stylized on purpose: flat illustration sits on
// the safe side of the uncanny valley.
import { computeTuning, applyTuning } from './tuning.js';
import { clampAU } from './expressions.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const f = (n) => Math.round(n * 10) / 10;

export function shade(hex, amt) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

const SHAPES = {
  round:  { hw: 120, hh: 142, jaw: .92, chin: 1.15 },
  oval:   { hw: 110, hh: 150, jaw: .78, chin: .9 },
  long:   { hw: 102, hh: 160, jaw: .76, chin: .85 },
  square: { hw: 118, hh: 146, jaw: 1.0, chin: 1.35 },
  heart:  { hw: 116, hh: 148, jaw: .64, chin: .7 },
};

function geometry(face) {
  const s = SHAPES[face.shape] || SHAPES.oval;
  const cx = 200, cy = 236;
  const eyes = face.eyes || {}, brows = face.brows || {}, nose = face.nose || {}, mouth = face.mouth || {};
  const ew = 17 + (eyes.size ?? .5) * 9;
  const g = {
    ...s, cx, cy,
    eyeY: cy - s.hh * 0.04,
    eyeDX: s.hw * (0.36 + (eyes.gap ?? .5) * 0.1),
    ew, eh: ew * 0.52,
    lid: eyes.lid ?? .3,
    browY: cy - s.hh * 0.04 - ew * 0.52 - 16 - (brows.arch ?? .5) * 4,
    browLen: ew * 1.45 + 8,
    browW: 5 + (brows.thick ?? .5) * 9,
    browArch: 4 + (brows.arch ?? .5) * 9,
    noseY: cy + s.hh * 0.27 + (nose.length ?? .5) * 8,
    noseW: 13 + (nose.width ?? .5) * 10,
    mouthY: cy + s.hh * 0.5,
    mw: 26 + (mouth.width ?? .5) * 16,
    lips: 3 + (mouth.lips ?? .5) * 6,
  };
  return g;
}

function headPath(g) {
  const { cx, cy, hw, hh, jaw, chin } = g;
  const top = cy - hh;
  return `M${cx},${top}` +
    ` C${cx + hw * .58},${top} ${cx + hw},${cy - hh * .6} ${cx + hw},${cy - hh * .1}` +
    ` C${cx + hw},${cy + hh * .38} ${cx + hw * jaw},${cy + hh * .64} ${cx + hw * jaw * .52},${cy + hh * .88}` +
    ` C${cx + hw * .2 * chin},${cy + hh * 1.01} ${cx - hw * .2 * chin},${cy + hh * 1.01} ${cx - hw * jaw * .52},${cy + hh * .88}` +
    ` C${cx - hw * jaw},${cy + hh * .64} ${cx - hw},${cy + hh * .38} ${cx - hw},${cy - hh * .1}` +
    ` C${cx - hw},${cy - hh * .6} ${cx - hw * .58},${top} ${cx},${top} Z`;
}

function hairLayers(g, face, back, front, defs) {
  const { cx, cy, hw, hh } = g;
  const style = face.hair?.style || 'short';
  const col = face.hair?.color || '#3b2a20';
  const dark = shade(col, -0.25);
  const top = cy - hh;
  const cap = (drop = .38, sideDrop = .1, puff = 14) =>
    `M${cx - hw - 6},${cy - hh * sideDrop}` +
    ` C${cx - hw - 10},${top - puff} ${cx - hw * .3},${top - puff - 18} ${cx},${top - puff - 12}` +
    ` C${cx + hw * .3},${top - puff - 18} ${cx + hw + 10},${top - puff} ${cx + hw + 6},${cy - hh * sideDrop}` +
    ` C${cx + hw * .9},${cy - hh * drop - 10} ${cx + hw * .55},${cy - hh * .72} ${cx + hw * .15},${cy - hh * .74}` +
    ` C${cx - hw * .2},${cy - hh * .62} ${cx - hw * .75},${cy - hh * .64} ${cx - hw - 6},${cy - hh * sideDrop} Z`;
  switch (style) {
    case 'bun':
      el('circle', { cx, cy: top - 30, r: 38, fill: col }, back);
      el('path', { d: cap(.4, .05, 6), fill: col }, front);
      el('path', { d: `M${cx - 30},${top - 6} Q${cx},${top - 20} ${cx + 30},${top - 6}`, stroke: dark, 'stroke-width': 2, fill: 'none', opacity: .5 }, front);
      break;
    case 'long':
      el('path', { d: `M${cx - hw - 14},${cy - hh * .3} C${cx - hw - 30},${cy + hh * .6} ${cx - hw - 20},${cy + hh * 1.2} ${cx - hw * .5},${cy + hh * 1.25} L${cx + hw * .5},${cy + hh * 1.25} C${cx + hw + 20},${cy + hh * 1.2} ${cx + hw + 30},${cy + hh * .6} ${cx + hw + 14},${cy - hh * .3} Z`, fill: dark }, back);
      el('path', { d: cap(.5, -.1, 12), fill: col }, front);
      break;
    case 'curly': {
      const gr = el('g', { fill: col }, front);
      for (let i = 0; i <= 14; i++) {
        const a = Math.PI * (1.02 + i / 14 * 0.96);
        const r = 18 + (i % 3) * 4;
        el('circle', { cx: cx + Math.cos(a) * (hw + 4), cy: cy - hh * .25 + Math.sin(a) * (hh * .88), r }, gr);
      }
      el('path', { d: cap(.32, .1, 18), fill: col }, front);
      break;
    }
    case 'locs': {
      const gb = el('g', { stroke: dark, 'stroke-width': 13, 'stroke-linecap': 'round', fill: 'none' }, back);
      for (let i = 0; i < 12; i++) {
        const x = cx - hw - 8 + i * ((hw * 2 + 16) / 11);
        el('path', { d: `M${x},${cy - hh * .5} Q${x + (i % 2 ? 6 : -6)},${cy + hh * .5} ${x},${cy + hh * (0.9 + (i % 3) * .08)}` }, gb);
      }
      el('path', { d: cap(.42, 0, 14), fill: col }, front);
      break;
    }
    case 'wavy':
      el('path', { d: `M${cx - hw - 12},${cy - hh * .2} C${cx - hw - 26},${cy + hh * .3} ${cx - hw - 4},${cy + hh * .45} ${cx - hw - 16},${cy + hh * .7} L${cx - hw + 12},${cy + hh * .5} Z M${cx + hw + 12},${cy - hh * .2} C${cx + hw + 26},${cy + hh * .3} ${cx + hw + 4},${cy + hh * .45} ${cx + hw + 16},${cy + hh * .7} L${cx + hw - 12},${cy + hh * .5} Z`, fill: dark }, back);
      el('path', { d: cap(.46, -.05, 16), fill: col }, front);
      break;
    case 'crop':
      el('path', { d: cap(.55, .15, 2), fill: col, opacity: .92 }, front);
      break;
    case 'bald':
      el('path', { d: `M${cx - hw - 3},${cy - hh * .05} C${cx - hw - 4},${cy - hh * .35} ${cx - hw * .8},${cy - hh * .5} ${cx - hw * .7},${cy - hh * .42} L${cx - hw * .8},${cy} Z M${cx + hw + 3},${cy - hh * .05} C${cx + hw + 4},${cy - hh * .35} ${cx + hw * .8},${cy - hh * .5} ${cx + hw * .7},${cy - hh * .42} L${cx + hw * .8},${cy} Z`, fill: col, opacity: .85 }, front);
      el('ellipse', { cx: cx - hw * .3, cy: cy - hh * .72, rx: 26, ry: 10, fill: '#fff', opacity: .12 }, front);
      break;
    default: // short
      el('path', { d: cap(.4, .08, 10), fill: col }, front);
      el('path', { d: `M${cx - hw * .2},${cy - hh * .74} Q${cx - hw * .05},${cy - hh * .92} ${cx + hw * .3},${top - 14}`, stroke: dark, 'stroke-width': 3, fill: 'none', opacity: .45 }, front);
  }
}

export function createFace(container, archetype, opts = {}) {
  const face = archetype.face;
  const g = geometry(face);
  const { gains, ageF, notes } = computeTuning(face, archetype.expressive);
  const skin = face.skin || '#d9a77c';
  const skinD = shade(skin, -0.18), skinDD = shade(skin, -0.32), skinL = shade(skin, 0.12);
  const lipCol = shade(skin, -0.28);
  const browCol = face.brows?.color || shade(face.hair?.color || '#3b2a20', -0.1);
  const clothes = opts.clothes || archetype.clothes || '#7d8f86';

  const svg = el('svg', { viewBox: '0 0 400 480', class: 'face-svg', role: 'img', 'aria-label': `${archetype.name}, ${archetype.title}` });
  const defs = el('defs', {}, svg);
  const uid = 'f' + Math.random().toString(36).slice(2, 8);
  const grad = el('radialGradient', { id: `${uid}-skin`, cx: '45%', cy: '40%', r: '70%' }, defs);
  el('stop', { offset: '0%', 'stop-color': skinL }, grad);
  el('stop', { offset: '100%', 'stop-color': skin }, grad);

  const body = el('g', { class: 'body' }, svg);
  // shoulders + neck (static, outside the head group so the head can tilt)
  el('path', { d: `M60,480 C70,420 120,392 200,392 C280,392 330,420 340,480 Z`, fill: clothes }, body);
  el('path', { d: `M150,404 Q200,436 250,404`, stroke: shade(clothes, -0.2), 'stroke-width': 3, fill: 'none' }, body);
  el('path', { d: `M${g.cx - 34},${g.cy + g.hh * .7} L${g.cx - 38},${400} Q${g.cx},${418} ${g.cx + 38},${400} L${g.cx + 34},${g.cy + g.hh * .7} Z`, fill: skinD }, body);

  const head = el('g', { class: 'head' }, svg);
  const back = el('g', {}, head);
  // ears
  for (const s of [-1, 1]) {
    el('ellipse', { cx: g.cx + s * (g.hw - 2), cy: g.eyeY + 18, rx: 15, ry: 25, fill: skinD }, head);
    el('ellipse', { cx: g.cx + s * (g.hw + 1), cy: g.eyeY + 18, rx: 7, ry: 14, fill: skinDD, opacity: .4 }, head);
    if (face.earrings) el('circle', { cx: g.cx + s * (g.hw + 2), cy: g.eyeY + 44, r: 4.5, fill: '#e8c66a' }, head);
  }
  el('path', { d: headPath(g), fill: `url(#${uid}-skin)` }, head);

  // static creases (age), opacity animated
  const creases = el('g', { fill: 'none', stroke: skinDD, 'stroke-linecap': 'round' }, head);
  const nasoL = el('path', { 'stroke-width': 2.2 }, creases), nasoR = el('path', { 'stroke-width': 2.2 }, creases);
  const crowL = el('path', { 'stroke-width': 1.6 }, creases), crowR = el('path', { 'stroke-width': 1.6 }, creases);
  const fore = el('path', { 'stroke-width': 1.6 }, creases);
  const glab = el('path', { 'stroke-width': 1.8 }, creases);

  // cheeks
  const cheekL = el('ellipse', { rx: 24, ry: 14, fill: '#e2706a' }, head);
  const cheekR = el('ellipse', { rx: 24, ry: 14, fill: '#e2706a' }, head);

  // eyes
  const eyes = [-1, 1].map((s) => {
    const x = g.cx + s * g.eyeDX;
    const clip = el('clipPath', { id: `${uid}-eye${s}` }, defs);
    const clipPath = el('path', {}, clip);
    const ge = el('g', {}, head);
    const socket = el('path', { fill: skinD, opacity: .35 }, ge);
    const inner = el('g', { 'clip-path': `url(#${uid}-eye${s})` }, ge);
    el('rect', { x: x - g.ew - 2, y: g.eyeY - g.eh * 2, width: g.ew * 2 + 4, height: g.eh * 4, fill: '#fbf7f2' }, inner);
    const iris = el('circle', { r: g.eh * 1.02, fill: face.eyes?.iris || '#5a3d2b' }, inner);
    const pupil = el('circle', { r: g.eh * .5, fill: '#1d1511' }, inner);
    const hl = el('circle', { r: g.eh * .22, fill: '#fff', opacity: .9 }, inner);
    const lid = el('path', { fill: skin }, inner);       // upper lid skin over the eye when closing
    const lash = el('path', { fill: 'none', stroke: '#2a1d17', 'stroke-width': 3, 'stroke-linecap': 'round' }, ge);
    const lower = el('path', { fill: 'none', stroke: skinDD, 'stroke-width': 1.3, opacity: .6, 'stroke-linecap': 'round' }, ge);
    const crease = el('path', { fill: 'none', stroke: skinDD, 'stroke-width': 1.6, opacity: .55, 'stroke-linecap': 'round' }, ge);
    return { s, x, clipPath, socket, iris, pupil, hl, lid, lash, lower, crease };
  });

  // brows
  const brows = [-1, 1].map((s) => ({ s, p: el('path', { fill: 'none', stroke: browCol, 'stroke-width': g.browW, 'stroke-linecap': 'round' }, head) }));

  // nose
  const nw = g.noseW;
  el('path', { d: `M${g.cx - 4},${g.eyeY + 12} Q${g.cx - 10},${g.noseY - 18} ${g.cx - nw * .55},${g.noseY - 2}`, stroke: skinDD, 'stroke-width': 1.8, fill: 'none', opacity: .4, 'stroke-linecap': 'round' }, head);
  el('path', { d: `M${g.cx - nw},${g.noseY - 4} Q${g.cx - nw - 4},${g.noseY + 6} ${g.cx - nw * .45},${g.noseY + 5} Q${g.cx},${g.noseY + 11} ${g.cx + nw * .45},${g.noseY + 5} Q${g.cx + nw + 4},${g.noseY + 6} ${g.cx + nw},${g.noseY - 4}`, stroke: skinDD, 'stroke-width': 2.2, fill: 'none', 'stroke-linecap': 'round' }, head);
  el('ellipse', { cx: g.cx, cy: g.noseY - 6, rx: nw * .5, ry: 6, fill: '#fff', opacity: .12 }, head);

  // facial hair
  const hairTone = face.hair?.color || '#3b2a20';
  if (face.beard && face.beard !== 'none') {
    const { cx, cy, hw, hh, jaw } = g;
    const d = `M${cx - hw + 2},${g.eyeY + 30} C${cx - hw},${cy + hh * .45} ${cx - hw * jaw},${cy + hh * .7} ${cx - hw * jaw * .5},${cy + hh * .92}` +
      ` C${cx - 20},${cy + hh * 1.08} ${cx + 20},${cy + hh * 1.08} ${cx + hw * jaw * .5},${cy + hh * .92}` +
      ` C${cx + hw * jaw},${cy + hh * .7} ${cx + hw},${cy + hh * .45} ${cx + hw - 2},${g.eyeY + 30}` +
      ` C${cx + hw * .8},${g.mouthY - 30} ${cx + g.mw + 14},${g.mouthY - 10} ${cx + g.mw + 8},${g.mouthY + 14}` +
      ` Q${cx},${g.mouthY + 34} ${cx - g.mw - 8},${g.mouthY + 14}` +
      ` C${cx - g.mw - 14},${g.mouthY - 10} ${cx - hw * .8},${g.mouthY - 30} ${cx - hw + 2},${g.eyeY + 30} Z`;
    el('path', { d, fill: hairTone, opacity: face.beard === 'stubble' ? .28 : face.beard === 'short' ? .8 : .95 }, head);
  }
  if (face.mustache) {
    el('path', { d: `M${g.cx - g.mw - 4},${g.mouthY - 2} Q${g.cx - g.mw * .5},${g.noseY + 6} ${g.cx},${g.noseY + 12} Q${g.cx + g.mw * .5},${g.noseY + 6} ${g.cx + g.mw + 4},${g.mouthY - 2} Q${g.cx},${g.mouthY - 6} ${g.cx - g.mw - 4},${g.mouthY - 2} Z`, fill: hairTone }, head);
  }

  // mouth
  const mouthG = el('g', {}, head);
  const mouthInner = el('path', { fill: '#5b2b2b' }, mouthG);
  const lowerLip = el('path', { fill: lipCol, opacity: .85 }, mouthG);
  const upperLip = el('path', { fill: lipCol, opacity: .7 }, mouthG);
  const mouthLine = el('path', { fill: 'none', stroke: shade(lipCol, -0.35), 'stroke-width': 2.4, 'stroke-linecap': 'round' }, mouthG);
  const chin = el('path', { fill: 'none', stroke: skinDD, 'stroke-width': 1.6, opacity: 0, 'stroke-linecap': 'round' }, head);

  // hair
  const front = el('g', {}, head);
  hairLayers(g, face, back, front, defs);

  // glasses
  if (face.glasses && face.glasses !== 'none') {
    const gg = el('g', { fill: 'none', stroke: '#3a3330', 'stroke-width': 3 }, head);
    for (const e of eyes) {
      if (face.glasses === 'round') el('circle', { cx: e.x, cy: g.eyeY, r: g.ew + 9 }, gg);
      else if (face.glasses === 'square') el('rect', { x: e.x - g.ew - 10, y: g.eyeY - g.eh - 10, width: (g.ew + 10) * 2, height: g.eh * 2 + 22, rx: 8 }, gg);
      else el('path', { d: `M${e.x - g.ew - 10},${g.eyeY + 2} Q${e.x},${g.eyeY + g.eh + 18} ${e.x + g.ew + 10},${g.eyeY + 2}` }, gg);
    }
    el('path', { d: `M${g.cx - g.eyeDX + g.ew + 9},${g.eyeY - 2} Q${g.cx},${g.eyeY - 8} ${g.cx + g.eyeDX - g.ew - 9},${g.eyeY - 2}` }, gg);
    for (const e of eyes) el('path', { d: `M${e.x + e.s * (g.ew + 9)},${g.eyeY - 3} L${g.cx + e.s * (g.hw - 4)},${g.eyeY - 8}` }, gg);
  }

  container.appendChild(svg);

  let blinkT = 0, breathPhase = 0, mouthLevel = 0;
  const blush = face.blush ?? .3;

  function frame(raw, extra = {}) {
    const e = clampAU(applyTuning(raw, gains));
    const blink = extra.blink ?? 0;
    const level = extra.mouth ?? 0;  // speech mouth level 0..1
    const breath = extra.breath ?? 0; // -1..1
    const tiltDeg = e.tilt * (archetype.expressive?.tilt ?? 6);
    head.setAttribute('transform', `translate(${f(e.gx * 2)},${f(breath * 1.6 + e.gy * 3)}) rotate(${f(tiltDeg)} ${g.cx} ${g.cy + g.hh})`);
    body.setAttribute('transform', `translate(0,${f(breath * 1.1)})`);

    // eyes
    const close = Math.min(1, e.au43 * .55 + blink + e.au7 * .25 + e.au6 * .12);
    const open = Math.max(0.02, 1 + e.au5 * .3 - close);
    const lowerRaise = e.au6 * .35 + e.au7 * .3;
    for (const ey of eyes) {
      const { x } = ey, y = g.eyeY, w = g.ew, h = g.eh;
      // inner-corner lift for sad/worried: au1 lifts the inner end of the upper lid
      const innerLift = e.au1 * 2.5 - e.au4 * 2;
      const xi = x - ey.s * w, xo = x + ey.s * w;
      const upY = y - h * 1.9 * open;
      const loY = y + h * 1.5 * (1 - lowerRaise);
      const upper = `M${f(xo)},${f(y)} Q${f(x)},${f(upY)} ${f(xi)},${f(y - innerLift)}`;
      const lowerC = `Q${f(x)},${f(loY)} ${f(xo)},${f(y)}`;
      ey.clipPath.setAttribute('d', `${upper} ${lowerC} Z`);
      ey.socket.setAttribute('d', `M${f(xo + ey.s * 4)},${f(y)} Q${f(x)},${f(y - h * 2.6)} ${f(xi - ey.s * 4)},${f(y - innerLift)} Q${f(x)},${f(y + h * 1.9)} ${f(xo + ey.s * 4)},${f(y)} Z`);
      ey.lash.setAttribute('d', upper);
      ey.lower.setAttribute('d', `M${f(xi)},${f(y - innerLift)} ${lowerC}`);
      const creaseLift = g.lid > .5 ? 3 : 8;
      ey.crease.setAttribute('d', `M${f(xo - ey.s * 2)},${f(y - 4)} Q${f(x)},${f(y - h * 1.9 - creaseLift - e.au1 * 2)} ${f(xi + ey.s * 3)},${f(y - innerLift - 5)}`);
      ey.crease.setAttribute('opacity', f(.3 + g.lid * .5));
      const ix = x + e.gx * w * .35, iy = y + e.gy * h * .5 + h * .05;
      ey.iris.setAttribute('cx', f(ix)); ey.iris.setAttribute('cy', f(iy));
      ey.pupil.setAttribute('cx', f(ix)); ey.pupil.setAttribute('cy', f(iy));
      ey.hl.setAttribute('cx', f(ix - h * .35)); ey.hl.setAttribute('cy', f(iy - h * .4));
      ey.lid.setAttribute('d', '');
    }

    // brows: inner end (near nose) raised by au1, outer by au2, both lowered and pulled in by au4
    for (const b of brows) {
      const s = b.s;
      const xi = g.cx + s * (g.eyeDX - g.browLen * .55) - s * e.au4 * 5;
      const xo = g.cx + s * (g.eyeDX + g.browLen * .55);
      const base = g.browY + e.au4 * 9 - e.au1 * 1.5;
      const yi = base - e.au1 * 11 + e.au4 * 5;
      const yo = base - e.au2 * 10 + e.au1 * 2.5;
      const peakX = xi + (xo - xi) * .6;
      const peakY = Math.min(yi, yo) - g.browArch - e.au2 * 3 + e.au1 * 2 + e.au4 * 3;
      b.p.setAttribute('d', `M${f(xi)},${f(yi)} Q${f(peakX)},${f(peakY)} ${f(xo)},${f(yo + 3)}`);
    }

    // mouth
    const mw = g.mw * (1 + e.au12 * .12 - e.au15 * .05);
    const cornerY = -e.au12 * 9 + e.au15 * 8 - e.au17 * 1.5;
    const mid = g.mouthY + e.au12 * 4 - e.au15 * 3 - e.au17 * 2;
    const openH = Math.max(0, e.au25 * 5 + e.au26 * 12 + level * 9);
    const xL = g.cx - mw, xR = g.cx + mw, yC = g.mouthY + cornerY;
    const topY = mid - openH * .25, botY = mid + openH;
    mouthLine.setAttribute('d', `M${f(xL)},${f(yC)} Q${f(g.cx)},${f(topY + (mid - yC) * .6)} ${f(xR)},${f(yC)}`);
    if (openH > .8) {
      mouthInner.setAttribute('d', `M${f(xL + 4)},${f(yC)} Q${f(g.cx)},${f(topY + (mid - yC) * .6)} ${f(xR - 4)},${f(yC)} Q${f(g.cx)},${f(botY + (mid - yC) * .7)} ${f(xL + 4)},${f(yC)} Z`);
    } else mouthInner.setAttribute('d', '');
    const lb = botY + (mid - yC) * .5 + g.lips;
    lowerLip.setAttribute('d', `M${f(xL + 3)},${f(yC + .5)} Q${f(g.cx)},${f(botY + (mid - yC) * .7)} ${f(xR - 3)},${f(yC + .5)} Q${f(g.cx)},${f(lb + g.lips * .9 - e.au17 * 3)} ${f(xL + 3)},${f(yC + .5)} Z`);
    upperLip.setAttribute('d', `M${f(xL + 2)},${f(yC)} Q${f(g.cx - mw * .45)},${f(topY - g.lips * .9)} ${f(g.cx)},${f(topY - g.lips * .35)} Q${f(g.cx + mw * .45)},${f(topY - g.lips * .9)} ${f(xR - 2)},${f(yC)} Q${f(g.cx)},${f(topY + (mid - yC) * .6)} ${f(xL + 2)},${f(yC)} Z`);
    chin.setAttribute('d', `M${f(g.cx - 10)},${f(g.mouthY + 30 - e.au17 * 4)} Q${f(g.cx)},${f(g.mouthY + 26 - e.au17 * 6)} ${f(g.cx + 10)},${f(g.mouthY + 30 - e.au17 * 4)}`);
    chin.setAttribute('opacity', f(e.au17 * .6));

    // cheeks lift with au6/au12
    const ch = e.au6 * 6 + e.au12 * 3;
    for (const [c, s] of [[cheekL, -1], [cheekR, 1]]) {
      c.setAttribute('cx', f(g.cx + s * (g.eyeDX + 6)));
      c.setAttribute('cy', f(g.eyeY + g.eh * 3.3 - ch));
      c.setAttribute('opacity', f(Math.min(.55, blush * .35 + e.au6 * .18)));
    }

    // creases: deepen with smiles on older faces
    const nas = Math.min(.8, ageF * .35 + (e.au12 + e.au6 * .5) * (.18 + ageF * .4));
    for (const [p, s] of [[nasoL, -1], [nasoR, 1]]) {
      const x0 = g.cx + s * (g.noseW + 6), y0 = g.noseY - 2;
      const x1 = g.cx + s * (mw + 8), y1 = yC + 12;
      p.setAttribute('d', `M${f(x0)},${f(y0)} Q${f(x0 + s * (12 + e.au12 * 6))},${f((y0 + y1) / 2)} ${f(x1)},${f(y1)}`);
      p.setAttribute('opacity', f(nas));
    }
    const crow = Math.min(.7, e.au6 * ageF * .9);
    for (const [p, s] of [[crowL, -1], [crowR, 1]]) {
      const x0 = g.cx + s * (g.eyeDX + g.ew + 6);
      p.setAttribute('d', `M${f(x0)},${f(g.eyeY - 5)} l${s * 9},-4 M${f(x0 + s)},${f(g.eyeY + 1)} l${s * 10},1 M${f(x0)},${f(g.eyeY + 7)} l${s * 9},5`);
      p.setAttribute('opacity', f(crow));
    }
    const fy = g.browY - 22;
    fore.setAttribute('d', `M${g.cx - 36},${f(fy)} Q${g.cx},${f(fy - 6 - e.au1 * 4)} ${g.cx + 36},${f(fy)} M${g.cx - 28},${f(fy - 11)} Q${g.cx},${f(fy - 16 - e.au1 * 4)} ${g.cx + 28},${f(fy - 11)}`);
    fore.setAttribute('opacity', f(Math.min(.6, (e.au1 + e.au2) * .5 * (.25 + ageF))));
    glab.setAttribute('d', `M${g.cx - 6},${f(g.browY - 2)} l-1,12 M${g.cx + 6},${f(g.browY - 2)} l1,12`);
    glab.setAttribute('opacity', f(Math.min(.6, e.au4 * .55 + e.au1 * e.au4 * .3)));
  }

  return { svg, frame, tuningNotes: notes, gains, geometry: g, destroy: () => svg.remove() };
}

// Abstract presence: the research doc's original breathing light, for users who
// find faces threatening. Same expression interface, mapped to light.
export function createLight(container, archetype) {
  const svg = el('svg', { viewBox: '0 0 400 480', class: 'face-svg light', role: 'img', 'aria-label': `${archetype.name}, a breathing light` });
  const defs = el('defs', {}, svg);
  const uid = 'l' + Math.random().toString(36).slice(2, 8);
  const grad = el('radialGradient', { id: `${uid}-g` }, defs);
  const s0 = el('stop', { offset: '0%', 'stop-color': '#fff8ea' }, grad);
  const s1 = el('stop', { offset: '45%', 'stop-color': archetype.light || '#f2c48d' }, grad);
  el('stop', { offset: '100%', 'stop-color': archetype.light || '#f2c48d', 'stop-opacity': 0 }, grad);
  const halo = el('circle', { cx: 200, cy: 230, r: 170, fill: `url(#${uid}-g)`, opacity: .55 }, svg);
  const core = el('circle', { cx: 200, cy: 230, r: 90, fill: `url(#${uid}-g)` }, svg);
  const tint = el('circle', { cx: 200, cy: 230, r: 70, fill: '#8fb3d9', opacity: 0 }, svg);
  container.appendChild(svg);
  function frame(e, extra = {}) {
    const breath = extra.breath ?? 0;
    core.setAttribute('r', f(88 + breath * 9 + (extra.mouth ?? 0) * 8 + e.au12 * 6));
    halo.setAttribute('r', f(165 + breath * 14));
    halo.setAttribute('opacity', f(.45 + e.au6 * .3));
    // marked mirror: the user's feeling shows as a tint inside the light, while the halo stays steady
    const sadish = Math.max(e.au1 * .6 + e.au15 * .4, 0);
    tint.setAttribute('opacity', f(Math.min(.55, sadish * .5 + e.au4 * .4)));
    tint.setAttribute('fill', e.au4 > .4 ? '#c9796b' : '#8fb3d9');
    tint.setAttribute('r', f(55 + breath * 6));
  }
  return { svg, frame, tuningNotes: ['abstract light: mirroring shown as an inner tint; the halo never changes'], gains: {}, destroy: () => svg.remove() };
}
