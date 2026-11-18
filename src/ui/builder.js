import { h, clear, slider, select, toggle, swatches, chips, toast } from './dom.js';
import { mountFace } from './faceview.js';
import { PRESETS, generateArchetype } from '../data/archetypes.js';
import { normalizeArchetype, AFFECTS } from '../data/schema.js';
import { store } from '../store.js';
import { getTTSProvider } from '../voice/providers.js';
import { pick } from '../engine/scripts.js';
import { voiceFor } from '../voice/resolve.js';

const SKINS = ['#f3d4bd', '#eac09d', '#e0b48a', '#d9a67c', '#c68e62', '#a8714c', '#8d5a3b', '#6d4430', '#5e3b28', '#4a2d1f'];
const HAIRC = ['#1f1612', '#3b2a20', '#5a3420', '#8a5a33', '#b3884e', '#a33d2a', '#d9d4cc', '#8e8a86', '#b8b2aa', '#f0ece6'];
const IRIS = ['#2e1d12', '#3b2618', '#5a3d2b', '#6b4a2e', '#4e5b4a', '#3e6b4f', '#5f7b8a', '#4a6a8f'];
const CLOTHES = ['#9c6b78', '#4f6b5a', '#c2703d', '#5d6f86', '#6d7fa8', '#7a6a55', '#a8854f', '#7d8f86', '#3f4a5a', '#b56a5a'];
const IPF = [['protection', 'Protected'], ['attunement', 'Really seen'], ['soothing', 'Soothed'], ['delight', 'Delighted in'], ['encouragement', 'Believed in']];
const clone = (o) => JSON.parse(JSON.stringify(o));

export function renderBuilder(root, nav) {
  let draft = clone(store.data.archetype || PRESETS[0]);
  let presence = null;
  let tab = 'who';
  let wished = new Set();
  const firstRun = !store.data.archetype;

  const faceBox = h('div', { class: 'face-box' });
  const nameEl = h('h2', { style: { textAlign: 'center', margin: '8px 0 0' } });
  const titleEl = h('p', { class: 'muted', style: { textAlign: 'center', margin: '0' } });
  const notesEl = h('ul', { class: 'notes' });
  const panel = h('div', { class: 'stack' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });

  function remount() {
    presence?.destroy();
    clear(faceBox);
    draft = normalizeArchetype(draft);
    presence = mountFace(faceBox, draft);
    nameEl.textContent = draft.name;
    titleEl.textContent = draft.title;
    clear(notesEl);
    (presence.face.tuningNotes || []).forEach((n) => notesEl.append(h('li', {}, n)));
  }
  let pending = 0;
  const update = (fn) => { fn(draft); cancelAnimationFrame(pending); pending = requestAnimationFrame(remount); };

  async function hear() {
    const tts = getTTSProvider(store.settings.tts.provider) || getTTSProvider('webspeech');
    const line = pick('opening', draft, { endearment: draft.lexicon.endearments[0] || '', warmth: store.warmthFor(draft) });
    try {
      await tts?.speak(line, { voiceId: await voiceFor(tts.id, draft), rate: draft.voice.rate * .9, pitch: draft.voice.pitch, archetype: draft, onLevel: (l) => presence?.setSpeaking(l) });
    } catch (e) { toast('Voice not available: ' + (e.message || e)); }
    presence?.setSpeaking(0);
  }

  const preview = h('section', { class: 'preview card' },
    faceBox, nameEl, titleEl,
    h('p', { class: 'muted', style: { textAlign: 'center', fontSize: '.9rem', margin: '10px 0 4px' } }, 'Tap a feeling to see how they mirror it back:'),
    h('div', { class: 'mirror-try' }, AFFECTS.filter((a) => a !== 'calm').map((a) => h('button', { class: 'chip', onclick: () => presence?.mirror(a, .8) }, a))),
    h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '10px' } },
      h('button', { class: 'btn', onclick: hear }, 'Hear them'),
      h('button', { class: 'btn', onclick: () => { draft = generateArchetype({ gender: draft.voice.gender === 'n' ? undefined : undefined }); remount(); renderTab(); } }, 'Make someone new')),
    h('details', {}, h('summary', { class: 'muted' }, 'How this face is tuned'), notesEl));

  const TABS = [['who', 'Who'], ['face', 'Face'], ['voice', 'Voice'], ['manner', 'Manner'], ['check', 'Check']];
  function renderTabs() {
    clear(tabsEl);
    for (const [id, l] of TABS) tabsEl.append(h('button', { class: 'tab' + (id === tab ? ' on' : ''), role: 'tab', 'aria-selected': id === tab ? 'true' : 'false', onclick: () => { tab = id; renderTabs(); renderTab(); } }, l));
  }

  function presetCard(p) {
    const mini = h('div', { class: 'mini' });
    const b = h('button', { class: 'preset' + (p.id === draft.id ? ' on' : ''), onclick: () => { draft = clone(p); remount(); renderTab(); } }, mini, h('b', {}, p.name), h('small', {}, p.title), h('small', {}, p.blurb));
    requestAnimationFrame(() => { const pr = mountFace(mini, p); b._p = pr; });
    return b;
  }

  function renderTab() {
    panel.querySelectorAll('.preset').forEach((b) => b._p?.destroy());
    clear(panel);
    const f = draft.face;
    if (tab === 'who') {
      const ipfRow = h('div', { class: 'chips' }, IPF.map(([k, l]) => {
        const b = h('button', { class: 'chip' + (wished.has(k) ? ' on' : ''), onclick: () => { wished.has(k) ? wished.delete(k) : wished.add(k); renderTab(); } }, l);
        return b;
      }));
      const score = (p) => [...wished].reduce((s, k) => s + (p.ipf[k] || 0), 0);
      const list = wished.size ? [...PRESETS].sort((a, b) => score(b) - score(a)) : PRESETS;
      panel.append(
        h('div', { class: 'card stack' },
          h('h3', {}, 'What do you most wish you had been met with?'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'Pick one or two. The figures that fit best move to the front, and your choice shapes how they talk to you.'),
          ipfRow),
        h('div', { class: 'grid' }, list.map(presetCard)),
      );
    }
    if (tab === 'face' && !draft.abstract) {
      panel.append(h('div', { class: 'card stack' },
        chips('Face shape', f.shape, [['round', 'Round'], ['oval', 'Oval'], ['long', 'Long'], ['square', 'Square'], ['heart', 'Heart']], (v) => update((d) => (d.face.shape = v))),
        swatches('Skin', f.skin, SKINS, (v) => update((d) => (d.face.skin = v))),
        slider('Age', f.age, (v) => update((d) => (d.face.age = v)), { min: 30, max: 85, step: 1 }),
        slider('Rosy cheeks', f.blush ?? .3, (v) => update((d) => (d.face.blush = v))),
        chips('Hair', f.hair.style, [['bun', 'Bun'], ['short', 'Short'], ['crop', 'Cropped'], ['curly', 'Curly'], ['wavy', 'Wavy'], ['long', 'Long'], ['locs', 'Locs'], ['bald', 'Bald']], (v) => update((d) => (d.face.hair.style = v))),
        swatches('Hair colour', f.hair.color, HAIRC, (v) => update((d) => { d.face.hair.color = v; d.face.brows.color = v; })),
        slider('Brow thickness', f.brows.thick ?? .5, (v) => update((d) => (d.face.brows.thick = v)), { hint: 'Thicker brows get stronger brow motion so feelings still read' }),
        slider('Brow arch', f.brows.arch ?? .5, (v) => update((d) => (d.face.brows.arch = v))),
        slider('Eye size', f.eyes.size ?? .5, (v) => update((d) => (d.face.eyes.size = v))),
        slider('Eye spacing', f.eyes.gap ?? .5, (v) => update((d) => (d.face.eyes.gap = v))),
        slider('Hooded lids', f.eyes.lid ?? .3, (v) => update((d) => (d.face.eyes.lid = v)), { hint: 'Hooded eyes carry warmth through the cheeks instead' }),
        swatches('Eye colour', f.eyes.iris, IRIS, (v) => update((d) => (d.face.eyes.iris = v))),
        slider('Nose width', f.nose.width ?? .5, (v) => update((d) => (d.face.nose.width = v))),
        slider('Mouth width', f.mouth.width ?? .5, (v) => update((d) => (d.face.mouth.width = v))),
        slider('Fuller lips', f.mouth.lips ?? .5, (v) => update((d) => (d.face.mouth.lips = v))),
        chips('Glasses', f.glasses || 'none', [['none', 'None'], ['round', 'Round'], ['square', 'Square'], ['half', 'Reading']], (v) => update((d) => (d.face.glasses = v))),
        chips('Beard', f.beard || 'none', [['none', 'None'], ['stubble', 'Stubble'], ['short', 'Short'], ['full', 'Full']], (v) => update((d) => (d.face.beard = v))),
        toggle('Mustache', f.mustache, (v) => update((d) => (d.face.mustache = v))),
        toggle('Earrings', f.earrings, (v) => update((d) => (d.face.earrings = v))),
        swatches('Sweater', draft.clothes || '#7d8f86', CLOTHES, (v) => update((d) => (d.clothes = v))),
      ));
    }
    if (tab === 'face' && draft.abstract) panel.append(h('div', { class: 'card' }, h('p', {}, 'This figure has no face on purpose. Feelings show as a tint inside the light while the glow around it stays steady.'), swatches('Light colour', draft.light, ['#f2c48d', '#f5d6a8', '#e9b7a0', '#c9d8c0', '#b9cde0', '#e6c8e0'], (v) => update((d) => (d.light = v)))));
    if (tab === 'voice') {
      const vbox = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading voices…'));
      panel.append(h('div', { class: 'card stack' },
        chips('Voice', draft.voice.gender, [['f', 'Feminine'], ['m', 'Masculine'], ['n', 'In between']], (v) => update((d) => (d.voice.gender = v))),
        slider('Pace', draft.voice.rate, (v) => update((d) => (d.voice.rate = v)), { min: .6, max: 1.15, step: .01 }),
        slider('Pitch', draft.voice.pitch, (v) => update((d) => (d.voice.pitch = v)), { min: .6, max: 1.3, step: .01 }),
        vbox,
        h('button', { class: 'btn', onclick: hear }, 'Hear them'),
        h('p', { class: 'muted', style: { fontSize: '.88rem', margin: 0 } }, 'Voices come from your device, so no service is paid for and nothing is sent anywhere. For a richer voice, choose the Kokoro voice in Settings (a one-time download that runs on this device).')));
      const tts = getTTSProvider(store.settings.tts.provider) || getTTSProvider('webspeech');
      tts?.listVoices(store.settings.tts[tts.id] || {}).then((vs) => {
        clear(vbox);
        const opts = [['', 'Automatic (best match)'], ...vs.map((v) => [v.id, v.label + (v.lang ? ` · ${v.lang}` : '')])];
        const cur = tts.id === 'kokoro' ? draft.voice.kokoro : (draft.voice.voiceName || '');
        vbox.append(select(`Specific voice (${tts.label})`, cur, opts, (v) => update((d) => { if (tts.id === 'kokoro') d.voice.kokoro = v || d.voice.kokoro; else { d.voice.voiceName = v; d.voice.hints = v ? [v, ...d.voice.hints.filter((x) => x !== v)] : d.voice.hints; } })));
      }).catch(() => { clear(vbox); vbox.append(h('p', { class: 'muted' }, 'This browser has no voices available.')); });
    }
    if (tab === 'manner') {
      const endear = h('input', { type: 'text', value: draft.lexicon.endearments.join(', '), placeholder: 'e.g. love, kiddo (leave empty for none)', oninput: (e) => (draft.lexicon.endearments = e.target.value.split(',').map((x) => x.trim()).filter(Boolean)) });
      panel.append(h('div', { class: 'card stack' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Their name'), h('input', { type: 'text', value: draft.name, maxlength: 40, oninput: (e) => { draft.name = e.target.value || 'Your parent'; nameEl.textContent = draft.name; } })),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'What they call you', h('small', {}, 'Pet names. Some people find these lovely, some find them too much.')), endear),
        slider('Warmth', draft.stance.warmth, (v) => update((d) => (d.stance.warmth = v)), { hint: 'Low is plain and steady. Big warmth can feel unsafe at first; you can turn it up later.' }),
        slider('Unhurried ↔ brisk', draft.stance.pace, (v) => update((d) => (d.stance.pace = v))),
        slider('How marked the mirroring is', draft.mirror.markedness, (v) => update((d) => (d.mirror.markedness = v)), { hint: 'How clearly their face shows your feeling back while staying steady themselves' }),
        slider('Expressiveness', draft.expressive.gain, (v) => update((d) => (d.expressive.gain = v)), { min: .6, max: 1.4, step: .01 }),
        slider('Response beat (ms)', draft.mirror.delayMs, (v) => update((d) => (d.mirror.delayMs = v)), { min: 250, max: 900, step: 10, hint: 'A human pause before they respond. Not instant on purpose.' }),
      ));
    }
    if (tab === 'check') {
      const out = h('div', { class: 'stack' });
      panel.append(h('div', { class: 'card stack' },
        h('h3', {}, `Does anything about ${draft.name} remind you of someone?`),
        h('p', { class: 'muted', style: { margin: 0 } }, 'A face, a voice, a way of talking. If it does, change it. You can change anything later without losing what they remember.'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: () => { clear(out); out.append(h('p', {}, 'Good. That matters.')); } }, 'No'),
          h('button', { class: 'btn', onclick: () => { clear(out); out.append(h('p', {}, 'Which part?'), h('div', { class: 'chips' }, [['face', 'The face'], ['voice', 'The voice'], ['manner', 'The name or manner']].map(([t, l]) => h('button', { class: 'chip', onclick: () => { tab = t; renderTabs(); renderTab(); } }, l)))); } }, 'Yes, a bit')),
        out));
    }
    panel.append(h('div', { class: 'row wrap', style: { justifyContent: 'flex-end' } },
      firstRun ? null : h('button', { class: 'btn ghost', onclick: () => nav('home') }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: save }, firstRun ? `Choose ${draft.name}` : 'Save')));
  }

  function save() {
    draft = normalizeArchetype(draft);
    if (wished.size) for (const k of wished) draft.ipf[k] = Math.max(draft.ipf[k], .95);
    const saved = store.data.saved.filter((x) => x.id !== draft.id);
    store.setData({ archetype: draft, saved: [...saved, draft].slice(-12) });
    toast(`${draft.name} is here.`);
    nav('home');
  }

  root.append(h('main', { class: 'screen' },
    h('div', { class: 'topbar' }, h('span', { class: 'title' }, firstRun ? 'Choose who holds you' : 'Your parent figure'), firstRun ? h('span') : h('button', { class: 'icon-btn', onclick: () => nav('home') }, 'Done')),
    firstRun ? h('p', { class: 'muted' }, 'Pick a figure, or make someone new. They will be the same every time you come back: same face, same voice, same name.') : null,
    h('div', { class: 'builder' }, preview, h('section', { class: 'stack' }, tabsEl, panel))));
  remount(); renderTabs(); renderTab();
  return () => { presence?.destroy(); panel.querySelectorAll('.preset').forEach((b) => b._p?.destroy()); };
}
