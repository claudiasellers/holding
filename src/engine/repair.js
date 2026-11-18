// Repair ritual (research doc §7.5), as pure functions the session and tests share.
//
//   "A 'that missed' control is always visible. The coach also self-detects
//    likely misses: silence after a coach turn, sharp language, the user
//    apologizing. The script is fixed: name the specific miss ('I jumped to
//    fixing when you needed me to just stay'), own it without groveling, check
//    ('Is that it, or something else?'), and re-attune at the right tier.
//    Repairs are logged, and the user can see the running record."
//
// So a repair is a short sequence, not one line:
//   1. name   what the parent actually did on its last turn, specifically
//   2. own    plainly, once, no groveling (groveling is the helpless pole)
//   3. check  "Is that it, or something else?" (a tap-able statement in Be-with,
//             where questions are off)
//   4. re-attune at the right tier, after the user answers: do the opposite of
//             the miss, and keep doing it for the next few turns.
import { pick, getPath } from './scripts.js';
import { fill } from './fill.js';
import { sentences } from './guard.js';

const AFFECT_WORD = {
  sad: 'sadness', scared: 'fear', angry: 'anger', ashamed: 'shame', numb: 'numbness',
  overwhelmed: 'overwhelm', lonely: 'loneliness', calm: 'calm', hopeful: 'hope', glad: 'gladness',
};

const ADVICE = /\b(try|(maybe )?you (could|might|can) (try|do|write|call|text|go|take|get|start|ask|tell|say|think about|consider)|it (might|may|can|could) help|what if you|have you (tried|thought)|consider|let'?s (try|do|write)|how about)\b/i;
const NAMING = /\b(sounds like|it seems|that'?s (so much|a lot of)|i hear|you'?re feeling|you feel|maybe it'?s|part of you)\b/i;

// One down from where the miss happened: slower, fewer words, more presence.
const STEP_DOWN = { makesense: 'name', ordinary: 'name', name: 'bewith', bewith: 'bewith' };

/**
 * Work out what the parent's last turn did wrong, from what it actually said.
 * @param {object} t
 * @param {string} t.last          the parent's last line
 * @param {string} t.kind          the engine's kind for that line (affect, stillHere, bodyBudget, ...)
 * @param {string} t.tier          tier the miss happened in
 * @param {string|null} t.affect   affect the parent was reflecting
 * @param {boolean} t.answeredUser the last line was a reply to something the user typed
 * @param {boolean} t.again        a second miss right after a repair
 * @param {number} t.maxWords      the tier's word budget
 * @returns {{ id:string, text:string, fix:object, reattune:string, tier:string, instruction:string }}
 */
export function nameMiss({ last = '', kind = '', tier = 'bewith', affect = null, answeredUser = false, again = false, maxWords = 22 } = {}) {
  const words = last.split(/\s+/).filter(Boolean).length;
  const bewith = tier === 'bewith';
  const m = (id, text, fix, reattune, nextTier, instruction) => ({ id, text, fix, reattune, tier: nextTier, instruction });

  if (again) return m('again', 'still didn\'t get it right',
    { noQuestions: 4, short: 4, noAdvice: true, quietMs: 180000 }, 'listen', 'bewith',
    'You have missed twice. Say very little. No questions, no suggestions, no interpretation. Reflect only what the user has actually told you, in their words, and stay.');
  if (!last) return m('none', 'wasn\'t with you yet', { short: 2 }, 'listen', tier,
    'Reflect only what the user has told you, in their words.');

  if (/\?\s*$/.test(last) || sentences(last).some((x) => x.endsWith('?'))) {
    return bewith
      ? m('question', 'asked you something when you needed me to just stay', { noQuestions: 6, short: 3 }, 'noQuestions', 'bewith',
        'Ask nothing. Stay, and reflect what they have said in a few plain words.')
      : m('question', 'asked you a question before I had really heard you', { noQuestions: 4 }, 'heard', tier,
        'Ask nothing this turn. Reflect back the specific thing they said, in their words, before anything else.');
  }
  if (ADVICE.test(last) || ['bodyBudget', 'orient', 'breath', 'selfTouch'].includes(kind)) {
    const text = kind === 'bodyBudget' ? 'jumped to water and rest when you needed me with the feeling'
      : kind === 'orient' ? 'pulled you toward the room when you needed me with you'
      : kind === 'breath' ? 'gave you something to do with your breathing when you needed company'
      : kind === 'selfTouch' ? 'asked you to do something with your hands when you needed me to just stay'
      : 'jumped to fixing when you needed me to just stay';
    return m('fixing', text, { noAdvice: true, noQuestions: 2, short: 3 }, 'stay', STEP_DOWN[tier],
      'No suggestions, techniques or fixing. Stay with the feeling they have, and say so plainly.');
  }
  if (words > Math.max(maxWords, 14) || (bewith && words > 16)) {
    return m('tooMuch', 'said too much when you needed me quiet and close', { short: 4, quietMs: 150000 }, 'quiet', STEP_DOWN[tier],
      'One short sentence at most. Quiet, close, steady.');
  }
  if (kind === 'makesense') return m('meaning', 'went looking for meaning before you were ready', { noQuestions: 2, short: 3 }, 'slower', 'name',
    'Leave meaning alone for now. Stay with how it feels, slowly.');
  if (kind === 'ordinary') return m('light', 'kept it light when this needed more', { short: 0 }, 'deeper', 'name',
    'Drop the lightness. Take what they said seriously and stay with it.');
  if (['tooMuch', 'critic', 'roleReversal', 'angerAtCoach'].includes(kind) && answeredUser) {
    return m('stock', 'gave you a stock answer instead of hearing what you actually said', { short: 3 }, 'heard', tier,
      'Answer the specific thing they said last, in their words. Do not argue with it or reassure in general terms.');
  }
  if (kind === 'affect' && !bewith && (NAMING.test(last) || affect)) {
    const word = AFFECT_WORD[affect] || 'the feeling';
    return m('named', `called it ${word} before I knew that was it`, { noQuestions: 1, clearAffect: true, short: 3 }, 'listen', tier,
      'Do not name the feeling for them. Use only their words for it.');
  }
  if (answeredUser) {
    return m('generic', 'answered with something general instead of what you actually said', { short: 3 }, 'heard', tier,
      'Reflect the specific thing they said last, in their words, so they can tell you heard it.');
  }
  return bewith
    ? m('talking', 'kept talking when you wanted quiet', { short: 4, quietMs: 150000 }, 'quiet', 'bewith', 'One short sentence at most. Quiet, close, steady.')
    : m('fast', 'moved too fast', { short: 3, noQuestions: 2 }, 'slower', STEP_DOWN[tier], 'Slow down. Fewer words. Stay with what they said.');
}

/**
 * The fixed repair line: [opener] + name + own + check.
 * @param {object} miss     from nameMiss
 * @param {object} o
 * @param {string} o.tier   tier the repair is spoken in (Be-with gets a tap-able check, not a question)
 * @param {string} o.trigger 'button' | 'sharp' | 'apology' | 'silence'
 * @param {object} o.archetype
 * @param {object} o.ctx    fill context (endearment, name, warmth)
 */
export function repairLine(miss, { tier = 'bewith', trigger = 'button', repeat = false, archetype, ctx = {} } = {}) {
  ctx = { ...ctx, allowSignature: false };   // never let a signature line stand in for a step
  const parts = [];
  const opener = miss.id === 'again' ? 'again' : repeat ? 'repeat' : trigger !== 'button' ? trigger : null;
  if (opener && getPath(`repair.opener.${opener}`)) parts.push(pick(`repair.opener.${opener}`, archetype, ctx));
  // Self-detected misses are a guess, so the naming is tentative; a tapped one is not.
  if (miss.id !== 'again') parts.push(fill(`${trigger === 'button' || trigger === 'sharp' ? 'I' : 'I think I'} ${miss.text}.`, ctx));
  parts.push(pick('repair.own', archetype, ctx));
  parts.push(pick(tier === 'bewith' ? 'repair.checkQuiet' : 'repair.check', archetype, ctx));
  return parts.join(' ');
}

/** The "tell me what I got wrong" prompt after the user says it was something else. */
export function listenLine(tier, archetype, ctx = {}) {
  ctx = { ...ctx, allowSignature: false };
  return pick(tier === 'bewith' ? 'repair.listenQuiet' : 'repair.listen', archetype, ctx);
}

/** Scripted re-attune line for a fix (the model gets miss.instruction instead). */
export function reattuneLine(key, archetype, ctx = {}) {
  ctx = { ...ctx, allowSignature: false };
  return getPath(`repair.reattune.${key}`) ? pick(`repair.reattune.${key}`, archetype, ctx) : pick('stillHere', archetype, ctx);
}

const YES = /^(yes|yeah|yep|yup|ya|mm+|mhm|exactly|right|true|kind of|kinda|sort of|a bit|that'?s (it|right)|that was it|pretty much)\b/i;
const NO = /^(no|nope|nah|not (really|quite|it|exactly)|something else|that'?s not it|it'?s not that|wrong)\b/i;

const STAY = /^(please,?\s*)?(just\s+)?stay(\s+with\s+me)?(,?\s*please)?[\s.!]*$/i;
const BARE = /^(that'?s it|that was it|exactly|it|that|it'?s something else|something else)?[\s.!]*$/i;

/**
 * Read the user's typed (or chip-tapped) answer to the check.
 * @returns {{ answer: 'yes'|'else'|'stay', rest: string }} rest = anything they said beyond the answer (a correction)
 */
export function readCheckAnswer(text) {
  const t = String(text || '').trim();
  if (STAY.test(t)) return { answer: 'stay', rest: '' };
  const strip = (re) => { const r = t.replace(re, '').replace(/^[\s,.!-]+/, '').trim(); return BARE.test(r) ? '' : r; };
  if (YES.test(t)) return { answer: 'yes', rest: strip(YES) };
  if (NO.test(t)) return { answer: 'else', rest: strip(NO) };
  return { answer: 'else', rest: t };   // anything else is them telling us what it was
}

/**
 * Does a generated reply break what the last repair promised? (A model can be
 * told; the engine still checks.)
 */
export function breaksPromise(text, fix) {
  if (!fix || !text) return false;
  if (fix.noAdviceUntil > Date.now() && ADVICE.test(text)) return true;
  return false;
}

/** Drop negated feeling words ("not sad", "isn't fear") so a correction is read for what it IS. */
export function withoutNegated(text) {
  return String(text || '').replace(/\b(not|never|no longer|isn'?t|wasn'?t|aren'?t|ain'?t|didn'?t feel)\s+(really\s+|just\s+|so\s+|even\s+|that\s+|feeling\s+)*[\w'-]+/gi, ' ');
}

/** Likely-miss signals in what the user typed (§7.5 self-detection). */
const SHARP = /\b(that'?s not (it|what i (said|meant|asked))|not what i (said|meant|asked)|you'?re not (listening|getting it|hearing me)|you don'?t (get it|understand|listen)|that'?s not help(ful|ing)|not helping|that didn'?t help|i didn'?t (say|mean) that|stop saying|you missed|that missed|missing the point|(you'?re|you are|that'?s|that is) wrong)\b/i;
const APOLOGY = /\b(sorry|my bad|never ?mind|forget it|i'?m not (explaining|making sense|saying it right)|i don'?t know how to (say|explain))\b/i;

export function missSignals(text, { lastWasQuestion = false } = {}) {
  const t = String(text || '').trim();
  const sharp = SHARP.test(t) || (!lastWasQuestion && /^no+[.!]*$/i.test(t));
  return { sharp, apology: !sharp && APOLOGY.test(t) };
}
