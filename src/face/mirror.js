// Presence controller: runs the face's animation loop and implements MARKED
// mirroring (Gergely & Watson 1996). A marked mirror is:
//   contingent  - follows the user's signal after a human beat (~450 ms), not instantly
//   ostensive   - starts with a small eyebrow flash and a ripple: "this is for you"
//   exaggerated - the feeling's signature action units are shown bigger than life
//   own-state   - the parent's steady cues stay on throughout (soft cheeks, no
//                 lid widening, a tilt): "this is YOUR feeling, I'm not in it"
//   brief       - it eases back to the parent's steady holding face, modelling regulation
import { OWN, AFFECT_FORMS, zero, lerp, add, ease, clampAU } from './expressions.js';

export function markedForm(affect, intensity = .7, markedness = .7, warmth = .5) {
  const form = AFFECT_FORMS[affect] || AFFECT_FORMS.calm;
  const k = Math.min(1.2, intensity * (0.75 + markedness * 0.6));
  // keep part of the parent's own baseline under the mirrored feeling
  const own = lerp(zero(), OWN.holding, 0.55 + (1 - markedness) * 0.25);
  const t = add(own, form, k);
  t.au6 = Math.max(t.au6, 0.2 + warmth * 0.18);          // eyes stay soft
  t.au5 = 0;                                              // never alarm-widened eyes
  t.tilt = t.tilt + markedness * 0.45;                    // the marked tilt
  if (affect === 'angry') { t.au12 = Math.max(t.au12, .04); t.au7 = Math.min(t.au7, .35); }
  if (affect === 'scared') t.au43 = Math.max(t.au43, .2); // slow, soft blink instead of fear eyes
  return clampAU(t);
}

export function createPresence(face, archetype, opts = {}) {
  const reduced = opts.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
  let own = OWN.holding, cur = { ...OWN.holding };
  let env = null;            // active mirror envelope
  let speak = 0, speakTarget = 0;
  let blinkAt = performance.now() + 2500, blinkStart = 0, blinkDur = 160;
  let bpm = opts.bpm ?? 6;
  let breathT = 0, last = performance.now(), raf = 0, alive = true;
  const listeners = new Set();
  const emit = (ev, data) => listeners.forEach((fn) => fn(ev, data));

  function setOwn(name) { own = OWN[name] || own; }
  function setSpeaking(level) { speakTarget = Math.max(0, Math.min(1, level)); }
  function setBreath(v) { bpm = v; }

  function mirror(affect, intensity = .7, o = {}) {
    const m = archetype.mirror || {}, x = archetype.expressive || {};
    const markedness = o.markedness ?? m.markedness ?? .7;
    const warmth = o.warmth ?? archetype.stance?.warmth ?? .5;
    const target = markedForm(affect, intensity, markedness, warmth);
    const delay = o.immediate ? 0 : (m.delayMs ?? 450);
    const cue = 300, onset = (x.onsetMs ?? 600) * (reduced ? 1.4 : 1);
    const hold = (x.holdMs ?? 1800) * (0.7 + markedness * 0.6);
    const release = 1600, after = 4200;
    const t0 = performance.now() + delay;
    return new Promise((resolve) => {
      env?.resolve?.();
      env = { affect, target, t0, cue, onset, hold, release, after, resolve, phase: 'wait' };
    });
  }

  function envelopeTarget(now) {
    if (!env) return own;
    const t = now - env.t0;
    const { cue, onset, hold, release, after, target } = env;
    let phase, out;
    if (t < 0) { phase = 'wait'; out = OWN.listening; }
    else if (t < cue) { phase = 'cue'; out = OWN.flash; }
    else if (t < cue + onset) { phase = 'mirror'; out = lerp(OWN.flash, target, ease((t - cue) / onset)); }
    else if (t < cue + onset + hold) { phase = 'mirror'; out = target; }
    else if (t < cue + onset + hold + release) { phase = 'return'; out = lerp(target, lerp(own, target, .18), ease((t - cue - onset - hold) / release)); }
    else if (t < cue + onset + hold + release + after) { phase = 'after'; out = lerp(lerp(own, target, .18), own, ease((t - cue - onset - hold - release) / after)); }
    else { phase = 'done'; out = own; const r = env.resolve; env = null; r?.(); }
    if (env && phase !== env.phase) { env.phase = phase; emit('phase', { phase, affect: env.affect }); }
    return out;
  }

  function loop(now) {
    if (!alive) return;
    const dt = Math.min(64, now - last); last = now;
    const tgt = envelopeTarget(now);
    const tau = reduced ? 320 : 170;
    const a = 1 - Math.exp(-dt / tau);
    for (const k in cur) cur[k] += (tgt[k] - cur[k]) * a;
    speak += (speakTarget - speak) * (1 - Math.exp(-dt / 60));
    breathT += dt / 1000 * (bpm / 60) * Math.PI * 2;
    const breath = Math.sin(breathT);
    // blinks: slower, softer when holding
    let blink = 0;
    if (now >= blinkAt && !blinkStart) { blinkStart = now; blinkDur = Math.random() < .3 ? 420 : 170; }
    if (blinkStart) {
      const p = (now - blinkStart) / blinkDur;
      if (p >= 1) { blinkStart = 0; blinkAt = now + 2800 + Math.random() * 3800; }
      else blink = Math.sin(p * Math.PI);
    }
    face.frame(cur, { blink, mouth: speak, breath: reduced ? breath * .4 : breath });
    emit('breath', breath);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    setOwn, mirror, setSpeaking, setBreath,
    flash: () => mirror('calm', .2, { immediate: true }),
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    get state() { return { ...cur }; },
    get phase() { return env?.phase || 'idle'; },
    destroy() { alive = false; cancelAnimationFrame(raf); env?.resolve?.(); face.destroy(); },
  };
}
