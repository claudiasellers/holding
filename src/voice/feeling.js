// How much emotion an expressive voice puts into a line ("exaggeration" in
// Chatterbox). Saved per parent figure as archetype.voice.feeling, 0.25..1.
// 0.5 is the model's neutral-natural point; above ~0.7 delivery gets more
// animated and a little faster.
export const DEFAULT_FEELING = 0.55;
export const FEELING_MIN = 0.25;
export const FEELING_MAX = 1;

const clamp = (x) => Math.min(FEELING_MAX, Math.max(FEELING_MIN, x));

/**
 * @param {object} archetype
 * @param {string} [tier] the turn policy tier; 'bewith' is peak distress
 */
export function feelingFor(archetype, tier) {
  const f = Number(archetype?.voice?.feeling);
  const base = Number.isFinite(f) ? f : DEFAULT_FEELING;
  // At peak distress the parent steadies: same warmth, less drama.
  return clamp(tier === 'bewith' ? base * 0.8 : base);
}
