// Every scripted line a parent can say, filled exactly as the engine fills it
// (same endearment and name), most-used first: what Holding Local pre-records
// with an expressive voice so those lines play at once.
import { getPath } from '../engine/scripts.js';
import { fill } from '../engine/fill.js';

// "Hold me" opens with these, so they go first.
const ORDER = ['opening', 'stillHere', 'permission', 'affect', 'selfTouch', 'breath', 'orient', 'bodyBudget', 'safety',
  'close', 'wordsBack', 'fallback', 'tooMuch', 'critic', 'roleReversal', 'angerAtCoach', 'metaprocess', 'makesense', 'ordinary', 'repair'];

function collect(node, out) {
  if (Array.isArray(node)) { for (const l of node) if (l?.t) out.push(l.t); return; }
  if (node && typeof node === 'object') {
    // bewith (peak distress) before name
    const keys = Object.keys(node).sort((a, b) => (a === 'bewith' ? -1 : b === 'bewith' ? 1 : 0));
    for (const k of keys) collect(node[k], out);
  }
}

/**
 * @param {object} archetype
 * @param {{endearments?: boolean, userName?: string}} settings
 * @returns {string[]}
 */
export function scriptedTexts(archetype, settings = {}) {
  const ctx = {
    endearment: settings.endearments === false ? '' : (archetype?.lexicon?.endearments?.[0] || ''),
    userName: settings.userName || '',
  };
  const raw = [];
  for (const k of ORDER) collect(getPath(k), raw);
  for (const s of archetype?.lexicon?.signatures || []) raw.push(s);
  const seen = new Set(); const out = [];
  for (const t of raw) {
    if (/\{miss\}/.test(t)) continue; // depends on what went wrong: always live
    const text = fill(t, ctx);
    if (text && !seen.has(text)) { seen.add(text); out.push(text); }
  }
  return out;
}
