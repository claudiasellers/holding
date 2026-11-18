// Curated parent-figure archetypes + a generator. Every one is built from what a
// hostile-helpless parent was not: never fragile, never attacking; bigger,
// stronger, wiser and kind. Voices: OS-voice name hints + Kokoro voice ids.
import { normalizeArchetype } from './schema.js';

export const PRESETS = [
  {
    id: 'steady-grandmother', name: 'Nana June', title: 'The Steady Grandmother',
    blurb: 'Slow, unshockable, has seen everything and is still glad you came.',
    ipf: { protection: .6, attunement: .7, soothing: .95, delight: .8, encouragement: .45 },
    stance: { warmth: .6, wry: .35, pace: .15, words: .2 },
    voice: { gender: 'f', rate: .8, pitch: .95, hints: ['Moira', 'Karen', 'Martha', 'Serena', 'Google UK English Female', 'Libby', 'Sonia'], kokoro: 'bf_emma' },
    face: { shape: 'round', skin: '#e9c2a0', blush: .5, age: 74, hair: { style: 'bun', color: '#d9d4cc' }, brows: { thick: .35, arch: .45, color: '#a89f94' }, eyes: { size: .45, gap: .5, lid: .6, iris: '#5f7b8a' }, nose: { width: .55, length: .5 }, mouth: { width: .55, lips: .35 }, glasses: 'half', beard: 'none', mustache: false, earrings: true },
    clothes: '#9c6b78', expressive: { gain: .95, onsetMs: 750, holdMs: 2000, tilt: 6 }, mirror: { markedness: .7, delayMs: 500, style: 'soft' },
    lexicon: { endearments: ['love', 'sweetheart'], signatures: ['I\'ve got all night. Truly.', 'Nothing you could feel would scare me off.'] },
    persona: 'You speak like an old woman who has buried people and raised people and is not afraid of tears. Sparse, slow, a little dry humour on calm days.',
  },
  {
    id: 'gentle-giant', name: 'Walt', title: 'The Gentle Giant',
    blurb: 'Big, quiet, solid as a wall you can lean on. Few words, all of them kind.',
    ipf: { protection: .95, attunement: .6, soothing: .7, delight: .45, encouragement: .55 },
    stance: { warmth: .45, wry: .2, pace: .1, words: .1 },
    voice: { gender: 'm', rate: .78, pitch: .82, hints: ['Daniel', 'Arthur', 'Fred', 'Google UK English Male', 'Guy', 'Ryan', 'Davis', 'Thomas'], kokoro: 'am_michael' },
    face: { shape: 'square', skin: '#8d5a3b', blush: .2, age: 58, hair: { style: 'crop', color: '#2b211c' }, brows: { thick: .8, arch: .25, color: '#241a16' }, eyes: { size: .4, gap: .5, lid: .45, iris: '#3b2618' }, nose: { width: .75, length: .55 }, mouth: { width: .6, lips: .6 }, glasses: 'none', beard: 'short', mustache: true, earrings: false },
    clothes: '#4f6b5a', expressive: { gain: 1.05, onsetMs: 800, holdMs: 2200, tilt: 5 }, mirror: { markedness: .75, delayMs: 550, style: 'clear' },
    lexicon: { endearments: ['kiddo', 'friend'], signatures: ['I\'m not going anywhere.', 'Lean on me. I\'m heavy enough.'] },
    persona: 'You are a large, quiet man who is never rattled. Short sentences. You protect; you take charge when needed, gently.',
  },
  {
    id: 'warm-aunt', name: 'Aunt Rosa', title: 'The Warm Aunt',
    blurb: 'Notices everything about you and likes all of it. Lightly teasing on good days.',
    ipf: { protection: .55, attunement: .9, soothing: .65, delight: .9, encouragement: .6 },
    stance: { warmth: .65, wry: .55, pace: .35, words: .4 },
    voice: { gender: 'f', rate: .9, pitch: 1.02, hints: ['Samantha', 'Paulina', 'Monica', 'Jenny', 'Aria', 'Google US English', 'Ava', 'Allison'], kokoro: 'af_heart' },
    face: { shape: 'heart', skin: '#c68e62', blush: .45, age: 48, hair: { style: 'curly', color: '#2a1a14' }, brows: { thick: .55, arch: .6, color: '#21140f' }, eyes: { size: .6, gap: .5, lid: .25, iris: '#4a2e1c' }, nose: { width: .5, length: .45 }, mouth: { width: .62, lips: .7 }, glasses: 'none', beard: 'none', mustache: false, earrings: true },
    clothes: '#c2703d', expressive: { gain: 1.1, onsetMs: 550, holdMs: 1700, tilt: 8 }, mirror: { markedness: .8, delayMs: 420, style: 'animated' },
    lexicon: { endearments: ['mija', 'honey'], signatures: ['Look at you, still here. I like that about you.'] },
    persona: 'You are the aunt who always saw the kid in the corner. Attuned and delighted; you tease only when they are steady.',
  },
  {
    id: 'calm-elder', name: 'Ash', title: 'The Calm Elder',
    blurb: 'Even as a lake. Doesn\'t rush, doesn\'t flinch, doesn\'t need you to be anything.',
    ipf: { protection: .6, attunement: .95, soothing: .8, delight: .5, encouragement: .55 },
    stance: { warmth: .4, wry: .25, pace: .15, words: .2 },
    voice: { gender: 'n', rate: .82, pitch: .92, hints: ['Alex', 'Google UK English Female', 'Sonia', 'Natasha', 'Libby', 'Emma'], kokoro: 'af_nicole' },
    face: { shape: 'oval', skin: '#b98a6a', blush: .25, age: 64, hair: { style: 'short', color: '#8e8a86' }, brows: { thick: .4, arch: .4, color: '#6f6a66' }, eyes: { size: .5, gap: .55, lid: .5, iris: '#4e5b4a' }, nose: { width: .45, length: .55 }, mouth: { width: .45, lips: .4 }, glasses: 'round', beard: 'none', mustache: false, earrings: false },
    clothes: '#5d6f86', expressive: { gain: .9, onsetMs: 800, holdMs: 2000, tilt: 5 }, mirror: { markedness: .65, delayMs: 550, style: 'soft' },
    lexicon: { endearments: [], signatures: ['There\'s no hurry here.'] },
    persona: 'You are an elder of no particular gender, very even. Few words. You attune precisely and say plainly what you see.',
  },
  {
    id: 'protective-mother', name: 'Mara', title: 'The Protective Mother',
    blurb: 'Stands between you and whatever is hurting you. Fierce for you, soft with you.',
    ipf: { protection: .95, attunement: .75, soothing: .85, delight: .6, encouragement: .5 },
    stance: { warmth: .55, wry: .2, pace: .25, words: .3 },
    voice: { gender: 'f', rate: .86, pitch: .96, hints: ['Karen', 'Tessa', 'Fiona', 'Aria', 'Michelle', 'Google US English', 'Jenny'], kokoro: 'af_bella' },
    face: { shape: 'oval', skin: '#f0cfb4', blush: .45, age: 44, hair: { style: 'long', color: '#5a3420' }, brows: { thick: .5, arch: .5, color: '#4a2a1a' }, eyes: { size: .55, gap: .5, lid: .3, iris: '#3e6b4f' }, nose: { width: .4, length: .5 }, mouth: { width: .5, lips: .55 }, glasses: 'none', beard: 'none', mustache: false, earrings: false },
    clothes: '#6d7fa8', expressive: { gain: 1, onsetMs: 600, holdMs: 1800, tilt: 7 }, mirror: { markedness: .75, delayMs: 450, style: 'clear' },
    lexicon: { endearments: ['sweetheart', 'love'], signatures: ['Nobody gets to hurt you while I\'m here.'] },
    persona: 'You are a mother whose fierceness points outward, at whatever hurts the user, and whose softness points at them.',
  },
  {
    id: 'wise-mentor', name: 'Dr. Okafor', title: 'The Wise Mentor',
    blurb: 'Believes in the adult you are becoming. Steady in a storm, curious after it.',
    ipf: { protection: .55, attunement: .7, soothing: .55, delight: .55, encouragement: .95 },
    stance: { warmth: .4, wry: .45, pace: .35, words: .45 },
    voice: { gender: 'm', rate: .88, pitch: .9, hints: ['Daniel', 'Oliver', 'Google UK English Male', 'Ryan', 'Christopher', 'Andrew', 'Aaron'], kokoro: 'bm_george' },
    face: { shape: 'long', skin: '#5e3b28', blush: .15, age: 66, hair: { style: 'bald', color: '#b8b2aa' }, brows: { thick: .55, arch: .4, color: '#cfc8c0' }, eyes: { size: .45, gap: .5, lid: .55, iris: '#2e1d12' }, nose: { width: .7, length: .6 }, mouth: { width: .5, lips: .6 }, glasses: 'square', beard: 'short', mustache: false, earrings: false },
    clothes: '#7a6a55', expressive: { gain: .95, onsetMs: 700, holdMs: 1900, tilt: 5 }, mirror: { markedness: .65, delayMs: 500, style: 'clear' },
    lexicon: { endearments: [], signatures: ['You have more in you than tonight knows.'] },
    persona: 'A mentor (the "Dr." is an honorific nickname, you are not a clinician and say so if asked). In storms you are steady; afterwards you are curious and you encourage the user\'s best self.',
  },
  {
    id: 'cheerful-uncle', name: 'Uncle Benny', title: 'The Cheerful Uncle',
    blurb: 'Glad to see you, no matter what state you arrive in. Warmth turned down by default.',
    ipf: { protection: .6, attunement: .6, soothing: .6, delight: .95, encouragement: .7 },
    stance: { warmth: .35, wry: .7, pace: .45, words: .45 },
    voice: { gender: 'm', rate: .92, pitch: 1, hints: ['Fred', 'Tom', 'Alex', 'Google US English', 'Guy', 'Eric', 'Brian'], kokoro: 'am_puck' },
    face: { shape: 'round', skin: '#dba57d', blush: .55, age: 55, hair: { style: 'short', color: '#6b4a2e' }, brows: { thick: .6, arch: .55, color: '#5a3d26' }, eyes: { size: .5, gap: .5, lid: .35, iris: '#6b4a2e' }, nose: { width: .65, length: .5 }, mouth: { width: .7, lips: .5 }, glasses: 'none', beard: 'stubble', mustache: false, earrings: false },
    clothes: '#a8854f', expressive: { gain: 1.05, onsetMs: 550, holdMs: 1600, tilt: 7 }, mirror: { markedness: .8, delayMs: 420, style: 'animated' },
    lexicon: { endearments: ['pal', 'kid'], signatures: ['There you are. Good.'] },
    persona: 'You are the uncle who lights up when the user walks in. Warmth defaults low because big warmth can feel unsafe; you are delighted, not effusive.',
  },
  {
    id: 'abstract-light', name: 'Lumen', title: 'The Breathing Light',
    blurb: 'No face at all. A slow, warm light that breathes with you and never looks away.',
    ipf: { protection: .6, attunement: .7, soothing: .95, delight: .4, encouragement: .45 },
    stance: { warmth: .4, wry: .1, pace: .1, words: .1 },
    voice: { gender: 'n', rate: .8, pitch: .92, hints: ['Samantha', 'Google UK English Female', 'Sonia', 'Aria'], kokoro: 'af_nicole' },
    face: { shape: 'oval', skin: '#e0b48a', age: 40, hair: { style: 'bald', color: '#000' }, brows: {}, eyes: {}, nose: {}, mouth: {} },
    abstract: true, light: '#f2c48d', clothes: '#000',
    expressive: { gain: 1, onsetMs: 900, holdMs: 2200, tilt: 0 }, mirror: { markedness: .7, delayMs: 550, style: 'soft' },
    lexicon: { endearments: [], signatures: [] },
    persona: 'You have no face or body, only presence. Extremely sparse and steady.',
  },
].map(normalizeArchetype);

// ---------- generator ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
const SKINS = ['#f3d4bd', '#eac09d', '#d9a67c', '#c68e62', '#a8714c', '#8d5a3b', '#6d4430', '#523222'];
const HAIR = ['#1f1612', '#3b2a20', '#5a3420', '#8a5a33', '#b3884e', '#d9d4cc', '#8e8a86', '#a33d2a'];
const IRIS = ['#3b2618', '#5a3d2b', '#4e5b4a', '#3e6b4f', '#5f7b8a', '#4a6a8f'];
const CLOTHES = ['#9c6b78', '#4f6b5a', '#c2703d', '#5d6f86', '#6d7fa8', '#7a6a55', '#a8854f', '#7d8f86'];
const NAMES = { f: ['Nell', 'Ida', 'Grace', 'Marisol', 'Ada', 'Ruth', 'Imani', 'Hana', 'Beatrix', 'Lena'], m: ['Sol', 'Joe', 'Teo', 'Abe', 'Hugh', 'Kofi', 'Ray', 'Emil', 'Gus', 'Ike'], n: ['Wren', 'Sage', 'River', 'Ash', 'Rowan', 'Quinn', 'Jules', 'Robin'] };
const ROLES = {
  f: [['The Steady Grandmother', 'Nana'], ['The Warm Aunt', 'Aunt'], ['The Protective Mother', ''], ['The Quiet Godmother', '']],
  m: [['The Gentle Giant', ''], ['The Steady Grandfather', 'Grandpa'], ['The Cheerful Uncle', 'Uncle'], ['The Patient Father', '']],
  n: [['The Calm Elder', ''], ['The Kind Guardian', ''], ['The Old Friend of the Family', '']],
};
const VOICES = {
  f: { hints: ['Samantha', 'Karen', 'Moira', 'Aria', 'Jenny', 'Google UK English Female', 'Sonia'], kokoro: ['af_heart', 'af_sarah', 'af_nicole', 'bf_emma', 'af_bella'] },
  m: { hints: ['Daniel', 'Fred', 'Guy', 'Google UK English Male', 'Ryan', 'Davis'], kokoro: ['am_michael', 'am_adam', 'bm_george', 'bm_lewis'] },
  n: { hints: ['Alex', 'Google UK English Female', 'Sonia', 'Aria'], kokoro: ['af_nicole', 'af_sky', 'bf_isabella'] },
};

export function generateArchetype(seed = {}) {
  const gender = seed.gender || pickOne(['f', 'm', 'n']);
  const [title, prefix] = pickOne(ROLES[gender]);
  const first = pickOne(NAMES[gender]);
  const name = prefix ? `${prefix} ${first}` : first;
  const age = Math.round(rnd(38, 80));
  const grey = age > 62 && Math.random() < .7;
  const skin = pickOne(SKINS);
  const hairStyles = gender === 'm' ? ['short', 'crop', 'bald', 'curly', 'wavy', 'locs'] : ['bun', 'long', 'curly', 'short', 'wavy', 'locs', 'crop'];
  const ipfKeys = ['protection', 'attunement', 'soothing', 'delight', 'encouragement'];
  const ipf = Object.fromEntries(ipfKeys.map((k) => [k, +rnd(.45, .8).toFixed(2)]));
  const strong = pickOne(ipfKeys); ipf[strong] = .95;
  const hairColor = grey ? pickOne(['#d9d4cc', '#8e8a86', '#b8b2aa']) : pickOne(HAIR.slice(0, 5));
  const id = `${title.replace(/^The /, '').toLowerCase().replace(/[^a-z]+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  return normalizeArchetype({
    id, name, title,
    blurb: `${name} is strongest in ${strong}. Steady, unhurried, and not frightened by anything you feel.`,
    ipf,
    stance: { warmth: +rnd(.35, .6).toFixed(2), wry: +rnd(.1, .6).toFixed(2), pace: +rnd(.1, .4).toFixed(2), words: +rnd(.1, .45).toFixed(2) },
    voice: { gender, rate: +rnd(.78, .92).toFixed(2), pitch: gender === 'm' ? +rnd(.8, .95).toFixed(2) : +rnd(.92, 1.05).toFixed(2), hints: VOICES[gender].hints, kokoro: pickOne(VOICES[gender].kokoro) },
    face: {
      shape: pickOne(['round', 'oval', 'long', 'square', 'heart']), skin, blush: +rnd(.15, .55).toFixed(2), age,
      hair: { style: pickOne(hairStyles), color: hairColor },
      brows: { thick: +rnd(.25, .85).toFixed(2), arch: +rnd(.2, .65).toFixed(2), color: grey ? '#9d968e' : hairColor },
      eyes: { size: +rnd(.35, .65).toFixed(2), gap: +rnd(.4, .6).toFixed(2), lid: +rnd(.2, .65).toFixed(2), iris: pickOne(IRIS) },
      nose: { width: +rnd(.35, .75).toFixed(2), length: +rnd(.4, .65).toFixed(2) },
      mouth: { width: +rnd(.4, .7).toFixed(2), lips: +rnd(.3, .7).toFixed(2) },
      glasses: Math.random() < .35 ? pickOne(['round', 'square', 'half']) : 'none',
      beard: gender === 'm' && Math.random() < .55 ? pickOne(['stubble', 'short', 'full']) : 'none',
      mustache: gender === 'm' && Math.random() < .25,
      earrings: gender !== 'm' && Math.random() < .4,
    },
    clothes: pickOne(CLOTHES),
    expressive: { gain: +rnd(.9, 1.1).toFixed(2), onsetMs: Math.round(rnd(550, 800)), holdMs: Math.round(rnd(1600, 2200)), tilt: Math.round(rnd(4, 8)) },
    mirror: { markedness: +rnd(.6, .85).toFixed(2), delayMs: Math.round(rnd(420, 560)), style: pickOne(['soft', 'clear', 'animated']) },
    lexicon: { endearments: [], signatures: [] },
    persona: '',
    generated: true,
  });
}

export function presetById(id) { return PRESETS.find((p) => p.id === id); }
