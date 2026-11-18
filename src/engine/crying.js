// The parent never assumes the user is crying (PLAN.md §6, "never does").
// Tears are only mentioned once the user has said so themselves: by typing it
// ("I can't stop crying") or by tapping the Crying tile. Nothing else counts.
// The camera can't see tears (a frown and raised inner brows read as "sad",
// and sad is not crying), and a sad word like "it hurts" is not crying either.

// Any mention of crying in a line the parent would say. "tear" on its own is
// left out so "tear apart" stays allowed.
export const TEARS = /\b(cry|cries|crying|cried|tears|teary|tearful|tearing up|teardrops?|weep|weeps|weeping|wept|sob|sobs|sobbing|sobbed|bawl|bawling|bawled)\b|\bwipe (your|those) eyes\b/i;

// A crying word in the user's own text.
const USER_TEARS = /\b(cry|cries|crying|cried|tears|teary|tearful|tearing up|weep|weeping|wept|sob|sobbing|sobbed|bawl|bawling|bawled)\b/gi;
// "I", in the stretch of the sentence just before the crying word.
const FIRST_PERSON = /\b(i|i'?m|im|i'?ve|ive|i'?d|me|my|myself)\b/i;
// Someone else is the one crying ("my mom was crying", "he made her cry").
const SOMEONE_ELSE = /\b(she|he|they|her|him|them|his|their|mom|mum|dad|baby|kid|kids|son|daughter|sister|brother|friend|everyone|people|you)\b(?!.*\b(i|i'?m|im|me)\b)/i;
// Saying they are not crying, or can't.
const NOT_CRYING = /\b(not|never|no longer|isn'?t|wasn'?t|aren'?t|didn'?t|don'?t|doesn'?t|can'?t|cannot|couldn'?t|won'?t|wouldn'?t|trying not to|wish i could|want to|wanna|need to|going to|gonna|about to|might|almost|nearly)\s+(even\s+|really\s+|just\s+|ever\s+|be\s+)?(cry|cried|crying|sob|sobbed|sobbing|weep|wept|weeping|in tears)\b/i;
const STOPPED = /\b(stopped|done|finished|over) (crying|sobbing)\b|\bno more tears\b|\btears (have )?(stopped|dried)\b|\b(not|no longer) crying (any ?more|now)\b/i;

/**
 * Has the user just said they are crying?
 * @returns {true|false|null} true: they said so. false: they said they've
 *   stopped. null: nothing either way (the current state stands).
 */
export function cryingSignal(text) {
  const t = String(text || '');
  if (STOPPED.test(t)) return false;
  for (const sentence of t.split(/[.!?…\n]+/)) {
    USER_TEARS.lastIndex = 0;
    let m;
    while ((m = USER_TEARS.exec(sentence))) {
      const before = sentence.slice(Math.max(0, m.index - 40), m.index);
      const around = sentence.slice(Math.max(0, m.index - 30), m.index + m[0].length + 6);
      if (NOT_CRYING.test(around)) continue;
      // "Crying again." / "Tears everywhere." : the sentence starts with it
      if (!before.trim() || /^\s*(just|still|so much|so|all|and|keep|kept|been|started|can'?t stop|in)\s*$/i.test(before)) return true;
      if (SOMEONE_ELSE.test(before.replace(/\bmy (eyes|face)\b/gi, ''))) continue;
      if (FIRST_PERSON.test(before) || /\bin tears\b/i.test(around)) return true;
    }
  }
  return null;
}

/** True when the parent's line mentions crying or tears. */
export function mentionsTears(text) { return TEARS.test(String(text || '')); }
