// On-device reading of the user's turn. No text leaves the device for this.
// Returns affect + intensity + intent flags the dialogue engine branches on.

const LEX = {
  sad: /\b(sad|cry|crying|sob|sobbing|tears|grief|griev|heartbroken|hurts?|aching|miss (him|her|them)|lost)\b/i,
  scared: /\b(scared|afraid|terrified|panic|panicking|anxious|anxiety|fear|frightened|can'?t breathe|shaking|unsafe)\b/i,
  angry: /\b(angry|furious|rage|mad|pissed|hate|livid|so done|sick of)\b/i,
  ashamed: /\b(ashamed|shame|embarrass|humiliat|disgusting|pathetic|stupid|idiot|worthless|my fault)\b/i,
  numb: /\b(numb|nothing|empty|blank|unreal|floating|far away|can'?t feel|dissociat|fog)\b/i,
  overwhelmed: /\b(overwhelm|too much|can'?t do this|can'?t cope|drowning|falling apart|breaking|everything)\b/i,
  lonely: /\b(alone|lonely|no ?one|nobody|abandon|left me|isolated)\b/i,
  calm: /\b(calmer|settling|ok now|okay now|better|quieter|breathing)\b/i,
  hopeful: /\b(hope|maybe|try|could|might)\b/i,
  glad: /\b(glad|happy|good news|did it|proud|relieved|thank)\b/i,
};

export const RISK = /\b(kill (myself|me)|suicid|end (it|my life|things)|want(ed)? to die|don'?t want to (be here|live|exist|wake up)|better off without me|hurt(ing)? myself|self[- ]?harm|cut(ting)? myself|overdose|no reason to (live|go on)|not safe with myself)\b/i;

const INTENTS = {
  roleReversal: /\b(are you (ok|okay|alright|tired|sick of me|mad at me)|sorry (i'?m|for being) (so much|a lot|annoying|like this)|i'?m sorry,? i'?m sorry|you must (be tired|hate)|am i (too much|annoying|a burden) (for|to) you)\b/i,
  tooMuch: /\b(i'?m (too much|a burden|broken|unlovable|a mess|pathetic|worthless|the problem)|everyone leaves|no ?one (could|would|will) (love|stay)|i ruin everything|something wrong with me)\b/i,
  angerAtCoach: /\b(you('?re| are) (useless|fake|not real|a bot|stupid|no help)|shut up|this is (stupid|pointless)|i hate (you|this app)|you don'?t (care|understand))\b/i,
  critic: /\b(i should (be over|know better)|i'?m so stupid|what'?s wrong with me|i hate myself|grow up|get it together|pathetic)\b/i,
  done: /\b(i'?m (ok|okay|good|done) now|i think i'?m (ok|okay)|that helped|i can go|thank you)\b/i,
};

export function readText(text) {
  const t = String(text || '');
  const scores = {};
  for (const [k, re] of Object.entries(LEX)) {
    const m = t.match(new RegExp(re.source, 'gi'));
    if (m) scores[k] = m.length;
  }
  let affect = null, best = 0;
  for (const [k, v] of Object.entries(scores)) if (v > best && k !== 'hopeful') { best = v; affect = k; }
  if (!affect && scores.hopeful) affect = 'hopeful';
  const caps = (t.match(/[A-Z]{3,}/g) || []).length;
  const bangs = (t.match(/!/g) || []).length;
  const intensity = Math.min(1, 0.45 + best * .12 + caps * .1 + bangs * .05 + (t.length < 12 ? .1 : 0));
  const intents = {};
  for (const [k, re] of Object.entries(INTENTS)) if (re.test(t)) intents[k] = true;
  const words = t.trim().split(/\s+/).filter(Boolean).length;
  const sentencesN = (t.match(/[.!?]+(\s|$)/g) || []).length + 1;
  return { affect, intensity, intents, risk: RISK.test(t), words, wordsBack: words >= 9 && sentencesN >= 2 };
}

// Camera blendshapes (MediaPipe Face Landmarker, ARKit-style names) -> affect.
export function readBlendshapes(bs) {
  const g = (n) => bs[n] ?? 0;
  const frown = (g('mouthFrownLeft') + g('mouthFrownRight')) / 2;
  const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
  const browDown = (g('browDownLeft') + g('browDownRight')) / 2;
  const browInner = g('browInnerUp');
  const wide = (g('eyeWideLeft') + g('eyeWideRight')) / 2;
  const squint = (g('eyeSquintLeft') + g('eyeSquintRight')) / 2;
  const press = (g('mouthPressLeft') + g('mouthPressRight')) / 2;
  const c = {
    sad: browInner * .6 + frown * .8 + g('mouthShrugLower') * .3,
    scared: wide * .7 + browInner * .4 + g('mouthStretchLeft') * .3,
    angry: browDown * .8 + press * .4 + g('noseSneerLeft') * .3,
    glad: smile * .9 + squint * .2,
  };
  let affect = 'calm', v = .22;
  for (const [k, s] of Object.entries(c)) if (s > v) { v = s; affect = k; }
  return { affect, intensity: Math.min(1, v * 1.4) };
}
