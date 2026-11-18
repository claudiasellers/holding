// Deterministic turn policy (research doc §9): the model never decides length,
// questions, pacing or warmth. Values are starting parameters for tuning.
export const POLICY = {
  bewith:    { maxSentences: 2, maxWords: 22, question: false, beatMs: [1800, 3000], rate: .86, pitch: .94, temperature: .6, maxTokens: 60 },
  name:      { maxSentences: 4, maxWords: 55, question: true,  beatMs: [1200, 2000], rate: .92, pitch: .98, temperature: .7, maxTokens: 110 },
  makesense: { maxSentences: 6, maxWords: 90, question: true,  beatMs: [900, 1500],  rate: .98, pitch: 1,   temperature: .75, maxTokens: 180 },
  ordinary:  { maxSentences: 5, maxWords: 80, question: true,  beatMs: [800, 1400],  rate: 1,   pitch: 1,   temperature: .8, maxTokens: 160 },
};

export function policyFor(tier, warmth = .5) {
  const p = POLICY[tier] || POLICY.bewith;
  return { tier, ...p, warmth };
}

export function beat(p) {
  const [a, b] = p.beatMs; return a + Math.random() * (b - a);
}
