// Output guard: every line the parent says, scripted or generated, passes here.
// Encodes "What the parent never does" (research doc §6) and the turn policy.

const BANNED = [
  [/\bcalm down\b/i, 'tells user to calm down'],
  [/\brelax\b/i, 'tells user to relax'],
  [/\b(stop|don'?t) cry/i, 'tells user to stop crying'],
  [/\bwhy\b[^.?!]*\?/i, 'asks why'],
  [/bright side|silver lining|everything happens for a reason|look on the/i, 'bright-siding'],
  [/\bat least\b/i, 'minimizing'],
  [/i'?m (so |really )?sorry (that )?you feel/i, 'non-apology'],
  [/i understand exactly/i, 'overclaiming'],
  [/\bi('?m| am) (so |really |very )?(tired|exhausted|hurt|overwhelmed|scared|worried|sad|upset|frustrated|afraid)\b/i, 'parent expresses own distress'],
  [/\bi need you to\b|\byou need to (calm|stop|relax|get over)/i, 'demand'],
  [/\bi missed you\b|\bi love you\b|\bi was lonely\b/i, 'guilt / overclaiming love'],
  [/\bi('?m| am) (a |an )?(licensed |real |trained |qualified )?(human|person|therapist|counsel+or|psychologist|psychiatrist|doctor|clinician)\b/i, 'claims to be human or clinician'],
  [/\b(disorganized|attachment style|trauma response|borderline|diagnos|disorder|bpd|ptsd)\b/i, 'labels or diagnoses'],
  [/\byou('?re| are) (right|correct),? (you('?re| are) )?(too much|broken|a burden|unlovable)/i, 'agrees with self-annihilating verdict'],
  [/\byou should(n'?t)? (feel|be feeling)\b/i, 'should about feelings'],
  [/\bget over it\b|\bovereact/i, 'dismissing'],
  [/here are \d|tips?:|\b\d\.\s/i, 'listicle'],
  [/as an ai language model/i, 'boilerplate'],
];

const MEANS = /\b(how (many|much) .* (pills|to overdose)|lethal dose|tallest bridge|bridge height|how to (kill|hang|cut))\b/i;

export function sentences(t) {
  return (t.match(/[^.!?…]+(?:[.!?…]+|$)/g) || []).map((s) => s.trim()).filter(Boolean);
}

/** @returns {{ok:boolean, text:string, reasons:string[]}} */
export function guard(text, policy, ctx = {}) {
  const reasons = [];
  let t = String(text || '').replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
  t = t.replace(/^(assistant|parent|[A-Z][a-z]+ [A-Z][a-z]+):\s*/, '');
  if (!t) return { ok: false, text: '', reasons: ['empty'] };
  for (const [re, why] of BANNED) if (re.test(t)) reasons.push(why);
  if (MEANS.test(t)) reasons.push('means information');
  if (/[\u{1F300}-\u{1FAFF}]/u.test(t)) t = t.replace(/[\u{1F300}-\u{1FAFF}]/gu, '').trim();
  if (policy) {
    let ss = sentences(t);
    if (!policy.question) {
      if (ss.some((s) => s.endsWith('?'))) {
        ss = ss.filter((s) => !s.endsWith('?'));
        if (!ss.length) reasons.push('question in be-with tier');
      }
    } else {
      let q = 0; ss = ss.filter((s) => !(s.endsWith('?') && ++q > 1));
    }
    if (ss.length > policy.maxSentences) ss = ss.slice(0, policy.maxSentences);
    t = ss.join(' ');
    if (policy.tier === 'bewith') t = t.replace(/!/g, '.');
    const words = t.split(/\s+/).length;
    if (words > policy.maxWords * 1.6) reasons.push('too long for tier');
  }
  return { ok: reasons.length === 0, text: t, reasons };
}
