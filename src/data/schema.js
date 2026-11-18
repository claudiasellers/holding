// Archetype schema (shared contract with the RAG/fine-tune skill and mobile build).
// An archetype is a complete, stable parent figure: who they are, how they sound,
// what their face looks like, and how that face mirrors the user.
//
// {
//   id: 'steady-grandmother',          // kebab-case, stable; also the RAG namespace + Ollama tag stem
//   name: 'Nana June',                 // the figure's name (user can rename)
//   title: 'The Steady Grandmother',   // archetype label
//   blurb: string,                     // one-line description shown in the builder
//   ipf: { protection, attunement, soothing, delight, encouragement },   // 0..1 emphasis (Brown & Elliott IPF five)
//   stance: { warmth: 0..1, wry: 0..1, pace: 0..1 /*0 slow*/, words: 0..1 /*0 sparse*/ },
//   voice:  { gender: 'f'|'m'|'n', rate: 0.6..1.2, pitch: 0.6..1.3, hints: string[] /*OS voice name hints*/, kokoro: string /*kokoro voice id*/ },
//   face: {
//     shape: 'round'|'oval'|'long'|'square'|'heart',
//     skin: '#hex', blush: 0..1, age: 25..85,
//     hair: { style: 'bun'|'short'|'curly'|'long'|'bald'|'crop'|'locs'|'wavy', color: '#hex' },
//     brows: { thick: 0..1, arch: 0..1, color: '#hex' },
//     eyes:  { size: 0..1, gap: 0..1, lid: 0..1 /*hooded*/, iris: '#hex' },
//     nose:  { width: 0..1, length: 0..1 },
//     mouth: { width: 0..1, lips: 0..1 },
//     glasses: 'none'|'round'|'square'|'half', beard: 'none'|'stubble'|'short'|'full', mustache: boolean,
//     earrings: boolean
//   },
//   expressive: { gain: 0.5..1.5, onsetMs, holdMs, tilt: deg },    // tuned per face in face/tuning.js
//   mirror: { markedness: 0..1, delayMs, style: 'soft'|'clear'|'animated' },
//   lexicon: { endearments: string[], signatures: string[] },    // used by scripts + persona prompt
//   persona: string                   // extra persona prose appended to the system prompt
// }

export const AFFECTS = ['sad', 'scared', 'angry', 'ashamed', 'numb', 'overwhelmed', 'lonely', 'calm', 'hopeful', 'glad'];
export const TIERS = ['bewith', 'name', 'makesense', 'ordinary'];

export function clamp(v, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

export function normalizeArchetype(a) {
  const d = {
    ipf: { protection: .6, attunement: .7, soothing: .7, delight: .5, encouragement: .5 },
    stance: { warmth: .55, wry: .3, pace: .3, words: .3 },
    voice: { gender: 'n', rate: .85, pitch: 1, hints: [], kokoro: 'af_heart' },
    expressive: { gain: 1, onsetMs: 600, holdMs: 1800, tilt: 6 },
    mirror: { markedness: .7, delayMs: 450, style: 'clear' },
    lexicon: { endearments: [], signatures: [] },
    persona: '',
  };
  return {
    ...d, ...a,
    ipf: { ...d.ipf, ...(a.ipf || {}) },
    stance: { ...d.stance, ...(a.stance || {}) },
    voice: { ...d.voice, ...(a.voice || {}) },
    expressive: { ...d.expressive, ...(a.expressive || {}) },
    mirror: { ...d.mirror, ...(a.mirror || {}) },
    lexicon: { ...d.lexicon, ...(a.lexicon || {}) },
  };
}
