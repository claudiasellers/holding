// Suggested replies: three short things the user could say next, shown above
// the input. Pure functions only (no DOM, no storage) so they run in tests.
//
// Two layers (see docs/SUGGESTIONS.md for the research behind the sizes):
//  1. Rules: instant, no model, works in scripted mode on every device. Reads a
//     small "gist" of the session (tier, feeling, what the parent just did, and
//     people/places the user has named) and picks from a hand-written bank.
//  2. Model (optional): once the user has typed their own words and a local
//     model is ready and idle, ask it for three replies from a ~250-token
//     prompt: the gist plus the last four turns. Every model line passes
//     suggestionGuard(); anything missing is filled from the rules.
import { RISK, readText } from './affect.js';

export const MAX_WORDS = 9;          // a chip is a tap, not a paragraph
export const RECENT_TURNS = 4;       // last 2 exchanges go to the model
export const TURN_CHARS = 220;       // each turn trimmed to ~55 tokens
export const MAX_TOPICS = 3;

// ---------- context ("gist") ----------

const TOPIC_RES = [
  [/\bmy (best friend|mom|mum|mother|dad|father|parents|partner|husband|wife|boyfriend|girlfriend|ex|boss|manager|friend|sister|brother|son|daughter|kids|kid|family|roommate|teacher|therapist|grandma|grandmother|grandpa|grandfather|dog|cat)\b/i, (m) => `my ${m[1].toLowerCase()}`],
  [/\b(at work|my job|my work|the office)\b/i, () => 'work'],
  [/\b(at school|my class|my exam|my exams|uni|college)\b/i, () => 'school'],
];

/** People and places the user has named, newest first. Taps are ignored. */
export function topicsFrom(userTexts) {
  const out = [];
  for (let i = userTexts.length - 1; i >= 0 && out.length < MAX_TOPICS; i--) {
    const t = userTexts[i];
    for (const [re, name] of TOPIC_RES) {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(t))) { const n = name(m); if (!out.includes(n) && out.length < MAX_TOPICS) out.push(n); }
    }
  }
  return out;
}

/**
 * Everything suggestions need from a session, and nothing more. A few hundred
 * bytes no matter how long the session runs: counts and labels, plus the last
 * RECENT_TURNS turns trimmed to TURN_CHARS.
 */
export function gist(state = {}) {
  const history = state.history || [];
  const typed = history.filter((m) => m.role === 'user' && !/^\[tapped: /.test(m.content));
  const userTexts = typed.map((m) => String(m.content));
  const lastParent = [...history].reverse().find((m) => m.role === 'assistant')?.content || '';
  const recent = history.slice(-RECENT_TURNS).map((m) => ({
    role: m.role,
    text: /^\[tapped: (\w+)\]$/.test(m.content) ? `(tapped "${m.content.slice(9, -1)}")` : String(m.content).replace(/\s+/g, ' ').trim().slice(0, TURN_CHARS),
  }));
  return {
    mode: state.mode || 'hold',
    tier: state.tier || 'bewith',
    affect: state.affect || null,
    intensity: state.intensity || 0,
    lastKind: state.lastReplyKind || '',
    parentAsked: /\?\s*$/.test(lastParent),
    question: questionKind(lastParent),
    lastParent: lastParent.slice(0, TURN_CHARS),
    userTurns: typed.length,
    topics: topicsFrom(userTexts),
    sent: userTexts.map((t) => norm(t)),
    recent,
    safety: !!state.safety,
    ended: !!state.ended,
  };
}

// ---------- rules ----------

const BANK = {
  start: ['Just stay with me.', 'I don\'t know what I feel.', 'Something happened.'],
  affect: {
    overwhelmed: ['It\'s all too much.', 'I can\'t think straight.', 'Just stay with me.'],
    sad: ['I can\'t stop crying.', 'It hurts so much.', 'Just stay with me.'],
    scared: ['My heart is racing.', 'I\'m so scared.', 'Stay close.'],
    angry: ['I\'m so angry.', 'It wasn\'t fair.', 'I just need to be mad.'],
    ashamed: ['I feel so ashamed.', 'I want to hide.', 'Please don\'t look away.'],
    lonely: ['I feel so alone.', 'Nobody gets it.', 'Please stay.'],
    numb: ['I can\'t feel anything.', 'Everything feels far away.', 'Just keep talking.'],
    calm: ['It\'s a little quieter now.', 'I think I can talk now.', 'Can I tell you what happened?'],
    hopeful: ['Maybe it will be okay.', 'I think I can talk now.', 'Can I tell you what happened?'],
    glad: ['That actually helped.', 'I feel a bit lighter.', 'Can I tell you something good?'],
  },
  // answers to the parent's last question, by what kind of question it was
  check: ['Yes, that\'s it.', 'Not quite.', 'It\'s more like…'],       // "Is that close?" after a guess at the feeling
  day: ['Pretty good, actually.', 'Honestly, kind of hard.', 'A mixed sort of day.'],   // "How's today treating you?"
  sleep: ['Not great, honestly.', 'Pretty well.', 'On and off.'],
  body: ['Tired, mostly.', 'A bit sore.', 'Okay, actually.'],
  whatsUp: ['Something small went right.', 'Work is a lot right now.', 'Just checking in.'],
  choice: ['I want to tell you.', 'Stay a bit longer.', 'I\'m not sure yet.'],    // "tell me, or stay a bit longer?"
  reflect: ['It helped.', 'It felt strange, honestly.', 'I\'m not sure yet.'],     // "What was it like to have me stay?"
  yesNo: ['Yes.', 'Not really.', 'I\'m not sure.'],
  open: ['I\'m not sure.', 'Give me a second.', 'Let me think.'],
  // answers to the repair's check (§7.5); readCheckAnswer maps each to yes / else / stay
  repair: ['Yes, that\'s it.', 'Something else.', 'Just stay with me.'],
  wordsBack: ['Something happened today.', 'It started when…', 'I\'m not ready yet.'],
  bodyBudget: ['I\'ll get some water.', 'I haven\'t eaten.', 'I\'m cold.'],
  name: ['Can I tell you what happened?', 'It started when…', 'I keep going over it.'],
  makesense: ['The old rule says…', 'What actually happened was…', 'My new rule could be…'],
  ordinary: ['Something good happened today.', 'I\'m tired today.', 'Can I tell you about my day?'],
  going: ['Keep talking to me.', 'That helps.', 'There\'s more.'],
  topic: (t) => [`It's about ${t}.`, `I keep thinking about ${t}.`, `Can I tell you about ${t}?`],
};

/** Three rule-based suggestions for this gist. Deterministic for a given gist. */
export function ruleSuggestions(g) {
  // The repair's check gets exactly its three answers, in order (§7.5).
  if (g.lastKind === 'repair') return [...BANK.repair];
  const pools = [];
  if (g.lastKind === 'wordsBack') pools.push(BANK.wordsBack);
  if (g.lastKind === 'bodyBudget') pools.push(BANK.bodyBudget);
  // Answer the line she just said: a question gets answers to *that* question.
  // In make-sense, her open questions are about the old rule: the starters answer them.
  const answers = g.question === 'open' && g.tier === 'makesense' ? BANK.makesense : g.question && BANK[g.question];
  if (answers) {
    // A question is the whole moment: its answers lead (all three for a check
    // on a guess, which has exactly three honest answers; two otherwise).
    const seen0 = new Set(g.sent || []);
    const lead = answers.filter((x) => !seen0.has(norm(x))).slice(0, g.question === 'check' ? 3 : 2);
    return fillFrom(lead, g, restPools(g));
  }
  return fillFrom([], g, [...pools, ...restPools(g)]);
}

/** The situation's pools: topic, tier, feeling, then gentle fallbacks that fit the tier. */
function restPools(g) {
  const pools = [];
  if (g.topics.length && g.userTurns) pools.push(BANK.topic(g.topics[0]));
  if (g.tier === 'makesense') pools.push(BANK.makesense);
  else if (g.tier === 'ordinary') pools.push(BANK.ordinary);
  else if (g.tier === 'name') pools.push(BANK.name);
  if (g.affect && BANK.affect[g.affect]) pools.push(BANK.affect[g.affect]);
  if (!g.userTurns && !g.affect && g.tier === 'bewith') pools.push(BANK.start);
  // "Just stay with me" belongs to a hard moment, not an ordinary chat.
  const calm = g.tier === 'ordinary' || g.tier === 'makesense';
  if (g.userTurns) pools.push(BANK.going);
  const fallback = g.tier === 'ordinary' ? BANK.ordinary : g.tier === 'makesense' ? BANK.open : BANK.start;
  pools.push(fallback, calm ? BANK.going : BANK.start);
  return pools;
}

// Round-robin across pools so one situation can't take all three slots,
// rotating within each pool by turn count so the chips move as the talk does.
function fillFrom(lead, g, pools) {
  const out = [...lead];
  const seen = new Set([...(g.sent || []), ...lead.map(norm)]);
  const turn = g.userTurns || 0;
  for (let round = 0; out.length < 3 && round < 3; round++) {
    for (const pool of pools) {
      if (out.length >= 3) break;
      const line = pool[(round + turn) % pool.length];
      const k = norm(line);
      if (seen.has(k)) continue;
      seen.add(k); out.push(line);
    }
  }
  return out;
}

/**
 * What kind of question the parent's last line ends with, so the chips answer
 * it: a check on a guess at the feeling, a this-or-that, or an open question
 * about the day, sleep, the body, what's going on, or how it felt. null when
 * the line isn't a question.
 */
export function questionKind(line) {
  const t = String(line || '').trim();
  if (!/\?\s*$/.test(t)) return null;
  const q = (t.match(/[^.!?…]*\?\s*$/) || [t])[0].toLowerCase();
  if (/\b(is that (close|it|right)|does that (fit|sound right)|which is closer|am i close|or something else|have i got that)\b/.test(q)) return 'check';
  if (/\b(tell me|want to tell)\b.*\bor\b.*\b(stay|longer|wait)\b/.test(q)) return 'choice';
  if (/\b(sleep|slept)\b/.test(q)) return 'sleep';
  if (/\b(your body|body today|rested|sore)\b/.test(q)) return 'body';
  if (/\b(today|day)\b.*\b(treating|going|shaping|been|like)\b|\bhow('?s| is| was) (today|your day|the day|it going)\b|\bordinary day\b/.test(q)) return 'day';
  if (/\bwhat was it like|how does it feel|what helped|surprising|shifted|what do you notice\b/.test(q)) return 'reflect';
  if (/\b(what'?s going on|on your mind|what are we doing|tell me about|anything you want|plate|looking forward|went right)\b/.test(q)) return 'whatsUp';
  if (/^\s*(are|is|do|did|have|has|can|could|would|will|anything|any)\b/.test(q)) return 'yesNo';
  return 'open';
}

// ---------- guard for the user's side ----------

// Suggestions put words in the user's mouth, so they get their own guard:
// nothing about self-harm, no self-annihilating verdicts, no caretaking the
// parent, nothing the parent's guard would reject as a script, and short.
const USER_BANNED = [
  /\b(i'?m|i am) (too much|a burden|broken|unlovable|worthless|pathetic|the problem|stupid)\b/i,
  /\b(everyone leaves|no ?one (could|would|will) (love|stay)|i ruin everything|i hate myself|something wrong with me)\b/i,
  /\b(are you (ok|okay|alright|tired|mad)|sorry for being|you must be tired)\b/i,
  /\b(kill|die|dead|suicid|hurt myself|cut myself|overdose|pills)\b/i,
  /\b(diagnos|disorder|bpd|ptsd|attachment style)\b/i,
  /\b(calm down|get over it)\b/i,
  /https?:|[<>{}[\]#*_`]/,
];

/** @returns {string|null} the cleaned suggestion, or null when it must not be shown */
export function suggestionGuard(text) {
  let t = String(text || '')
    .replace(/^\s*(?:[-*•]|\d+[.)]|reply\s*\d*:|you:|me:|user:)\s*/i, '')
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length < 2) return null;
  if (t.split(' ').length > MAX_WORDS) return null;
  if (RISK.test(t)) return null;
  for (const re of USER_BANNED) if (re.test(t)) return null;
  const r = readText(t);
  if (r.intents.tooMuch || r.intents.critic || r.intents.roleReversal || r.intents.angerAtCoach) return null;
  if (!/[.!?…]$/.test(t)) t += '.';
  return t[0].toUpperCase() + t.slice(1);
}

// ---------- model prompt ----------

const TIER_NOTE = {
  bewith: 'they are at peak distress, so keep each reply very short and plain',
  name: 'words are coming back; they may want to say what happened',
  makesense: 'they are calmer and making sense of what happened',
  ordinary: 'an ordinary chat',
};

/**
 * Build the model request. Kept to ~250 tokens so it costs well under a
 * second of prefill on a desktop GPU (docs/SUGGESTIONS.md).
 */
export function buildSuggestPrompt(g, { parentName = 'the parent' } = {}) {
  const system = [
    `You write three things the USER might say next to ${parentName}, a steady, kind parent figure in a comfort app.`,
    `Rules: exactly 3 lines, one reply per line, no numbering, no quotes. First person, the user's own voice, under ${MAX_WORDS} words each. Make them different from each other and specific to what the user has said. Gentle and easy to tap.`,
    'Never mention self-harm or dying. Never have the user call themselves too much, broken or a burden. Never ask how the parent is.',
  ].join('\n');
  const lines = [];
  const feel = g.affect ? `${g.affect}${g.intensity > .75 ? ' (strongly)' : ''}` : 'unclear';
  lines.push(`Feeling: ${feel}. Stage: ${TIER_NOTE[g.tier] || TIER_NOTE.bewith}.`);
  if (g.topics.length) lines.push(`They have mentioned: ${g.topics.join(', ')}.`);
  lines.push('Recent:');
  for (const m of g.recent) lines.push(`${m.role === 'user' ? 'User' : parentName}: ${m.text}`);
  lines.push('Write the 3 lines now.');
  return { system, messages: [{ role: 'user', content: lines.join('\n') }], maxTokens: 48, temperature: .7 };
}

/** Pull up to three clean suggestions out of raw model text. */
export function parseModelSuggestions(text, g = {}) {
  const seen = new Set(g.sent || []);
  const out = [];
  for (const raw of String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').split(/\n+/)) {
    const t = suggestionGuard(raw);
    if (!t) continue;
    const k = norm(t);
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
    if (out.length === 3) break;
  }
  return out;
}

/** Model lines first, rule lines fill the rest, never more than three. */
export function mergeSuggestions(model, rules) {
  const out = []; const seen = new Set();
  for (const t of [...model, ...rules]) { const k = norm(t); if (!seen.has(k)) { seen.add(k); out.push(t); } if (out.length === 3) break; }
  return out;
}

/** A chip ending in an ellipsis is a sentence starter: it fills the box instead of sending. */
export function isStarter(t) { return /…$|\.\.\.$/.test(t); }

function norm(t) { return String(t).toLowerCase().replace(/[^a-z0-9' ]/g, '').replace(/\s+/g, ' ').trim(); }
