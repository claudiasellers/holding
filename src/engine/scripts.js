// Scripted line selection. Always available; used for the opening line, when
// no model is configured, and whenever a model reply fails the guard.
import LINES from '../data/lines.json';
import { guard } from './guard.js';
import { policyFor } from './policy.js';
import { fill } from './fill.js';
export { fill };

const recent = [];

export function getPath(path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), LINES);
}

/**
 * Pick a line from a category, weighting by archetype IPF emphasis and the
 * user's warmth dose, avoiding recent repeats.
 */
export function pick(path, archetype, ctx = {}) {
  let pool = getPath(path);
  if (!Array.isArray(pool) || !pool.length) pool = LINES.fallback;
  const dose = ctx.warmth ?? archetype?.stance?.warmth ?? .5;
  const ipf = archetype?.ipf || {};
  const scored = pool.map((l) => {
    let w = 1;
    w *= 0.4 + (ipf[l.ipf] ?? .5);
    w *= 1.2 - Math.min(1, Math.abs((l.w ?? .5) - dose) * 1.4);
    if (recent.includes(l.t)) w *= 0.03;
    return [l, Math.max(0.001, w)];
  });
  const sigs = archetype?.lexicon?.signatures || [];
  if (ctx.allowSignature && sigs.length && Math.random() < .12) {
    const s = sigs[Math.floor(Math.random() * sigs.length)];
    if (!recent.includes(s)) { remember(s); return fill(s, ctx); }
  }
  const total = scored.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [l, w] of scored) {
    r -= w;
    if (r <= 0) { remember(l.t); return fill(l.t, ctx); }
  }
  const l = scored[0][0]; remember(l.t); return fill(l.t, ctx);
}

function remember(t) { recent.push(t); if (recent.length > 16) recent.shift(); }

export function validateLibrary() {
  const bad = [];
  const walk = (o, p) => {
    if (Array.isArray(o)) o.forEach((l, i) => {
      const tier = l.tier || (/bewith|opening|stillHere|permission|selfTouch|orient|breath/.test(p) ? 'bewith' : /\.name$|wordsBack|bodyBudget|repair|roleReversal|tooMuch|angerAtCoach|critic|close|metaprocess|safety/.test(p) ? 'name' : /makesense/.test(p) ? 'makesense' : 'ordinary');
      const g = guard(fill(l.t, { endearment: 'love', userName: 'Sam' }), policyFor(tier));
      if (!g.ok) bad.push({ path: `${p}[${i}]`, t: l.t, reasons: g.reasons });
    });
    else if (o && typeof o === 'object') for (const k in o) walk(o[k], p ? `${p}.${k}` : k);
  };
  walk(LINES, '');
  return bad;
}
export { LINES };
