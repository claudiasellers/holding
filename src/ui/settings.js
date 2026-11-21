// Settings. Order: what's on right now and everything downloaded, then how the parent
// is with you, your person, comfort, then the once-on-a-calm-day setup (words, voice,
// your computer, listening), your data, about. Holding Local is set up in one place.
import { h, clear, slider, select, toggle, toast } from './dom.js';
import { store } from '../store.js';
import { listLLMProviders, getLLMProvider } from '../ai/providers.js';
import { getTTSProvider } from '../voice/providers.js';
import { WEBLLM_MODELS, DEFAULT_WEBLLM_MODEL } from '../ai/webllm.js';
import { canUseDeviceAI, useDeviceAI, connectHoldingLocal } from '../ai/brain.js';
import { voiceFor, chosenVoice, withVoice } from '../voice/resolve.js';
import { PRESETS } from '../data/archetypes.js';
import { voiceModelsPanel } from './voice-models.js';
import { chatModelsPanel } from './chat-models.js';
import { getLocalPanel, platform } from './get-local.js';
import { feelingFor } from '../voice/feeling.js';
import { friendlyError } from './errors.js';
import { nowCard, isHoldingLocal, serverUp } from './now.js';
import { downloadsCard } from './downloads.js';
import { validateLibrary } from '../engine/scripts.js';

export function renderSettings(root, nav, params = {}) {
  const body = h('div', { class: 'stack settings' });
  root.append(h('main', { class: 'screen' },
    h('div', { class: 'topbar' }, h('h1', { class: 'title' }, 'Settings'), h('button', { class: 'icon-btn', onclick: () => nav('home') }, 'Done')),
    body));
  const S = () => store.settings;
  const set = (patch) => store.setSettings(patch);
  const card = (title, id, ...kids) => { const c = h('section', { class: 'card stack', id }, h('h2', {}, title), ...kids); return c; };
  const go = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  function render() {
    clear(body);
    const a = store.data.archetype;
    const first = a.name;
    const aiId = S().ai.provider || 'scripted';
    const localCfg = S().ai['openai-local'] || {};
    const onLocal = aiId === 'openai-local' && isHoldingLocal(localCfg);
    const ttsId = S().tts.provider;
    const sttId = S().stt.provider || 'browser';

    // --- right now (checked, not just the saved choice) and one list of every download
    body.append(nowCard({ go }));
    body.append(downloadsCard({ rerender: render }));

    // --- how the parent is with you
    body.append(card(`How ${first} is with you`, 'you-card',
      slider('Warmth', store.warmthFor(a), (v) => set({ warmth: v }), { hint: 'If kindness ever feels like too much, turn this down. Steady and plain is a fine way to be held.' }),
      toggle('Pet names', S().endearments, (v) => set({ endearments: v }), a.lexicon?.endearments?.length ? `Like ${a.lexicon.endearments.slice(0, 2).map((e) => `"${e}"`).join(' and ')}.` : null),
      toggle('Suggested replies', S().suggestions !== false, (v) => { set({ suggestions: v }); render(); }, 'Three short things you could say, above the typing box.'),
      aiId !== 'scripted' && S().suggestions !== false ? select('Who writes the suggestions', S().suggestionsAI || 'auto', [['auto', 'Automatic'], ['on', 'The AI'], ['off', 'Hand-written only']], (v) => set({ suggestionsAI: v })) : null,
      select('After a goodbye, offer to keep lines', S().endPrompt || 'sometimes', [['sometimes', 'Now and then'], ['always', 'Every time'], ['never', 'Never']], (v) => set({ endPrompt: v })),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, `What should ${first} call you?`, h('small', {}, 'Optional. Used rarely.')), h('input', { type: 'text', value: S().userName, autocomplete: 'given-name', oninput: (e) => set({ userName: e.target.value.trim() }) }))));

    // --- my person (safety contact): high, not sixth
    const sc = S().safetyContact || {};
    body.append(card('My person', 'person-card',
      h('p', { class: 'muted lead' }, 'Someone you could call or text on a hard night. They appear on the "Not safe" screen, next to 988.'),
      h('div', { class: 'two' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), h('input', { type: 'text', value: sc.name || '', autocomplete: 'off', onchange: (e) => set({ safetyContact: { ...sc, name: e.target.value.trim() } }) })),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Phone'), h('input', { type: 'tel', value: sc.phone || '', onchange: (e) => set({ safetyContact: { ...sc, phone: e.target.value.trim() } }) })))));

    // --- comfort and access
    body.append(card('Comfort and access', 'comfort-card',
      toggle('Captions', S().captions, (v) => set({ captions: v }), `Show ${first}'s words under the face.`),
      toggle('Reduce motion', S().reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches, (v) => set({ reducedMotion: v })),
      toggle('Breathing pacer', S().breathPacer, (v) => set({ breathPacer: v }), 'A slow ring that breathes. Off by default: breath focus is not calming for everyone.'),
      toggle('Mirror my face with the camera', S().camera, (v) => set({ camera: v }), 'Reads your expression on this device so the face can mirror it. No video is stored or sent.')));

    // ---------- set up once ----------
    body.append(h('div', { class: 'group-head' }, h('h2', {}, `Make ${first} smarter`), h('p', { class: 'muted' }, 'Set these up once, on a calm day. Everything runs on your own devices.')));

    // --- words (AI): three plain choices, servers behind Advanced
    const aiStatus = h('p', { class: 'status', 'aria-live': 'polite' });
    const aiProg = h('div', { class: 'progress', hidden: true }, h('i'));
    const pickAI = async (id) => {
      if (id === aiId) return;
      if (id === 'local') {
        try { await connectHoldingLocal(); render(); } catch (e) { aiStatus.className = 'status bad'; aiStatus.textContent = friendlyError(e, 'connect'); go('local-card'); }
        return;
      }
      if (id === 'webllm') useDeviceAI(); else set({ ai: { provider: id } });
      render();
    };
    const opt = (id, label, desc, on, disabled) => h('button', { class: 'opt' + (on ? ' on' : ''), role: 'radio', 'aria-checked': String(on), disabled, onclick: () => pickAI(id) },
      h('span', { class: 'opt-dot' }), h('span', { class: 'opt-t' }, h('b', {}, label), h('small', {}, desc)));
    const advanced = aiId !== 'scripted' && aiId !== 'webllm' && !onLocal;
    const webllmCfg = S().ai.webllm || {};
    const m = WEBLLM_MODELS.find((x) => x.id === (webllmCfg.model || DEFAULT_WEBLLM_MODEL));
    body.append(card('Words', 'words-card',
      h('p', { class: 'muted lead' }, `What writes ${first}'s words. Whatever you pick, every reply follows the same rules, and the hand-written lines step in if a reply breaks them.`),
      h('div', { class: 'opts', role: 'radiogroup', 'aria-label': 'What writes the words' },
        opt('scripted', 'Hand-written lines', 'Works everywhere, instantly. Picked by feeling, so they don\'t follow what you type.', aiId === 'scripted'),
        opt('webllm', 'AI on this device', canUseDeviceAI() ? `A small model in this browser. One download${m?.sizeMB ? ` (about ${(m.sizeMB / 1000).toFixed(1)} GB)` : ''}, then it works offline.` : 'This browser can\'t run it. Try Chrome or Safari 18.', aiId === 'webllm', !canUseDeviceAI()),
        opt('local', 'AI on your computer', 'Holding Local on your Mac or PC. The warmest replies. Set it up below.', onLocal)),
      aiId === 'webllm' ? select('Model', webllmCfg.model || DEFAULT_WEBLLM_MODEL, WEBLLM_MODELS.map((x) => [x.id, x.label]), (v) => { set({ ai: { webllm: { ...webllmCfg, model: v } } }); render(); }) : null,
      onLocal ? h('p', { class: 'muted small' }, 'Holding Local writes the words. Pick its chat model under Your computer.') : null,
      aiId !== 'scripted' ? toggle('Rules off: show the AI exactly as written', !!S().rawAI, (v) => set({ rawAI: v }),
        'Skips every check on the AI\'s reply (banned phrases, length, questions, tears, the repair promise) and never swaps in a hand-written line for breaking one. The log still notes what a reply would have broken. Crisis replies stay hand-written.') : null,
      aiProg, aiStatus,
      advancedServer(advanced)));

    function advancedServer(open) {
      const id = advanced ? aiId : 'openai-local';
      const cfg = S().ai[id] || {};
      const setCfg = (patch) => set({ ai: { provider: id, [id]: { ...(S().ai[id] || {}), ...patch } } });
      return h('details', { class: 'adv', open },
        h('summary', {}, 'Advanced: use another server'),
        h('div', { class: 'stack' },
          h('p', { class: 'muted small' }, 'For Ollama, LM Studio, llama.cpp or the private-notes companion server. Holding Local doesn\'t need any of this.'),
          select('Server type', id, listLLMProviders().filter((p) => p.id === 'openai-local' || p.id === 'holding-rag').map((p) => [p.id, p.id === 'openai-local' ? 'OpenAI-compatible (Ollama, LM Studio…)' : 'Companion server (your notes)']), (v) => { set({ ai: { provider: v } }); render(); }),
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Address'), h('input', { type: 'url', placeholder: 'http://localhost:11434/v1', value: advanced ? (cfg.baseUrl || '') : '', onchange: (e) => setCfg({ baseUrl: e.target.value.trim().replace(/\/$/, '') }) })),
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Model'), h('input', { type: 'text', placeholder: 'gemma4:e4b', value: advanced ? (cfg.model || '') : '', onchange: (e) => setCfg({ model: e.target.value.trim() }) })),
          h('button', { class: 'btn', onclick: async () => {
            aiStatus.className = 'status'; aiStatus.textContent = 'Checking…';
            const r = await getLLMProvider(id).isAvailable(S().ai[id] || {});
            aiStatus.className = 'status ' + (r.ok ? 'ok' : 'bad'); aiStatus.textContent = r.ok ? 'It answered. You\'re set.' : friendlyError(r.reason, 'server');
          } }, 'Check')));
    }

    // --- voice: one list, no separate engine select
    const ttsP = getTTSProvider(ttsId) || getTTSProvider('webspeech');
    const vStatus = h('p', { class: 'status', 'aria-live': 'polite' });
    const preview = async (arch = store.data.archetype) => {
      try {
        await ttsP.init?.(S().tts[ttsP.id] || {}, () => {});
        ttsP.stop?.();
        await ttsP.speak(`Hello. I'm ${arch.name}. I'm here.`, { voiceId: await voiceFor(ttsP.id, arch), rate: arch.voice.rate, pitch: arch.voice.pitch, archetype: arch, feeling: feelingFor(arch) });
      } catch (e) { vStatus.className = 'status bad'; vStatus.textContent = friendlyError(e, 'voice'); }
    };
    const voicePick = h('div');
    ttsP.listVoices?.(S().tts[ttsP.id] || {}).then((vs) => {
      if (!vs?.length) return;
      const cur = chosenVoice(ttsP.id, a);
      const sel = h('select', { onchange: (e) => { const arch = store.data.archetype; const next = { ...arch, voice: withVoice(ttsP.id, arch, e.target.value) }; store.setData({ archetype: next, saved: (store.data.saved || []).map((x) => (x.id === next.id ? next : x)) }); preview(next); } },
        h('option', { value: '', selected: !cur }, 'Best match'),
        vs.map((v) => h('option', { value: v.id, selected: v.id === cur }, v.label)));
      voicePick.append(h('label', { class: 'field' }, h('span', { class: 'lbl' }, `${first}'s voice`), h('div', { class: 'row' }, sel, h('button', { class: 'btn', onclick: () => preview() }, 'Play'))));
    }).catch(() => {});
    body.append(card('Voice', 'voice-card',
      toggle('Speak out loud', S().voiceOn, (v) => { set({ voiceOn: v }); render(); }),
      S().voiceOn ? voicePick : null,
      S().voiceOn ? voiceModelsPanel({ rerender: render, preview, onLocal, noDelete: true }) : null,
      vStatus));

    // --- your computer (Holding Local): one place, four states
    body.append(localCard());
    function localCard() {
      const p = platform();
      const msg = h('p', { class: 'status', 'aria-live': 'polite' });
      if (onLocal) {
        const host = (() => { try { const u = new URL(localCfg.baseUrl); return /^(127\.|localhost)/.test(u.hostname) ? 'this computer' : u.hostname; } catch { return 'your computer'; } })();
        const linkTitle = h('b', {}, `Connected to ${host}`);
        const linkSub = h('small', {}, 'Words, voice and listening run there, privately.');
        const actions = h('div', { class: 'row wrap linked-actions' });
        const linked = h('div', { class: 'linked' }, h('span', { class: 'linked-dot' }), h('div', {}, linkTitle, linkSub), actions);
        actions.append(h('button', { class: 'btn ghost sm', onclick: () => {
            if (localCfg.pairedAt && window.HoldingMobile?.forgetHomeServer) window.HoldingMobile.forgetHomeServer();
            else set({ ai: { provider: 'scripted' }, tts: { provider: 'webspeech' }, stt: { provider: 'browser' } });
            render();
          } }, 'Disconnect'));
        // Say so when it isn't answering, instead of claiming "Connected".
        serverUp(localCfg.baseUrl, localCfg.token).then((up) => {
          if (up) return;
          linked.classList.add('down');
          linkTitle.textContent = `Can't reach ${host === 'this computer' ? 'Holding Local' : host}`;
          linkSub.textContent = p === 'phone' ? 'Is Holding Local open on your computer, and is this phone on the same network? Hand-written lines answer until it\'s back.' : 'Is it open? Click the heart in your menu bar and choose Open Holding. Hand-written lines answer until it\'s back.';
          actions.prepend(h('button', { class: 'btn sm', onclick: render }, 'Try again'));
        });
        return card('Your computer', 'local-card',
          linked,
          h('details', { class: 'sub', open: true }, h('summary', {}, 'Chat models'),
            chatModelsPanel({ cfg: () => S().ai['openai-local'] || {}, setModel: (name) => set({ ai: { 'openai-local': { ...S().ai['openai-local'], model: name } } }), rerender: render, bare: true, noDelete: true })),
          p !== 'phone' ? h('details', { class: 'sub' }, h('summary', {}, 'Use it from your phone'),
            h('p', { class: 'muted small' }, 'Click the heart in your menu bar, choose Pair a phone, and scan the code with your phone\'s camera.')) : null);
      }
      const connect = async (url, code) => {
        msg.className = 'status'; msg.textContent = 'Looking for Holding Local…';
        try { await connectHoldingLocal(url, code); render(); } catch (e) { msg.className = 'status bad'; msg.textContent = friendlyError(e, p === 'phone' ? 'pair' : 'connect'); }
      };
      if (p === 'phone') {
        const pairHost = h('div');
        try { window.HoldingMobile?.renderPairingPanel?.(pairHost); } catch { /* mobile layer missing */ }
        return card('Your computer', 'local-card',
          h('p', { class: 'muted lead' }, `Holding Local runs ${first} on your Mac or PC, with a bigger, warmer AI. Your phone then talks to it over your own network.`),
          h('ol', { class: 'steps' },
            h('li', {}, 'On your computer, open this page and download Holding Local.'),
            h('li', {}, 'Click the heart in its menu bar and choose ', h('b', {}, 'Pair a phone'), '.'),
            h('li', {}, 'Scan the code with this phone\'s camera. That\'s it.')),
          pairHost.childNodes.length ? h('details', { class: 'sub' }, h('summary', {}, 'Can\'t scan? Type it instead'), pairHost) : null,
          msg);
      }
      return card('Your computer', 'local-card',
        h('p', { class: 'muted lead' }, `Holding Local runs ${first}'s AI, voice and listening on your computer. Free, private, no accounts.`),
        getLocalPanel({ always: true, connect: () => connect() }),
        msg);
    }

    // --- listening
    body.append(card('Listening', 'listen-card',
      h('div', { class: 'opts', role: 'radiogroup', 'aria-label': 'Dictation' },
        ...[['browser', 'Browser dictation', 'In Chrome, audio goes to Google to be typed out. Safari can do it on the device.'],
          ['server', 'On your computer', onLocal ? 'Private. Audio goes only to Holding Local.' : 'Private. Needs Holding Local.'],
          ['off', 'Off', 'Hide the microphone button.']].map(([id, l, d]) => h('button', { class: 'opt' + (sttId === id ? ' on' : ''), role: 'radio', 'aria-checked': String(sttId === id), disabled: id === 'server' && !onLocal, onclick: () => { set({ stt: { provider: id } }); render(); } }, h('span', { class: 'opt-dot' }), h('span', { class: 'opt-t' }, h('b', {}, l), h('small', {}, d)))))));

    // --- data
    const dl = (name, text) => { const u = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const l = h('a', { href: u, download: name }); document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
    const del = h('button', { class: 'btn danger' }, 'Delete everything');
    del.onclick = () => {
      if (del.dataset.armed) { store.wipe(); toast('Everything was deleted.'); nav('builder'); return; }
      del.dataset.armed = '1'; del.textContent = 'Tap again to delete everything';
      setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete everything'; }, 4000);
    };
    body.append(card('Your data', 'data-card',
      h('p', { class: 'muted lead' }, 'Kept only in this browser, on this device. No accounts, no analytics.'),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => dl('holding-export.json', store.exportAll()) }, 'Export everything'), del),
      h('details', { class: 'sub' }, h('summary', {}, 'For developers'),
        h('div', { class: 'stack' },
          h('p', { class: 'muted small' }, 'Parent files for the private tuning tools (they go in ~/.parent-vault/archetypes/).'),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn', onclick: () => dl(`${a.id}.json`, JSON.stringify(a, null, 2)) }, `Export ${first}`),
            h('button', { class: 'btn', onclick: () => dl('holding-presets.json', JSON.stringify(PRESETS, null, 2)) }, 'Export all parents'))))));

    // --- about: ends on the reassurance
    body.append(card('About', 'about-card',
      h('p', {}, `${first} is an AI companion: not a person, not a therapist, and not for emergencies. It's built to sit beside human care, and to help you need it less over time.`),
      window.HoldingMobile?.showInstallSheet ? h('button', { class: 'btn', onclick: () => window.HoldingMobile.showInstallSheet() }, 'Put Holding on my home screen') : null,
      S().debugTuning ? (() => { const bad = validateLibrary(); return h('details', { class: 'sub' }, h('summary', {}, 'Line library check'), h('p', { class: 'muted small' }, bad.length ? `${bad.length} lines fail the rules and are skipped: ${bad.slice(0, 3).map((b) => b.path).join(', ')}…` : 'Every scripted line passes the guard.')); })() : null));

    if (params.focus === 'ai') setTimeout(() => go('words-card'), 50);
  }
  render();
  return () => {};
}
