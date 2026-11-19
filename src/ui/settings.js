import { h, clear, slider, select, toggle, toast } from './dom.js';
import { store } from '../store.js';
import { listLLMProviders, getLLMProvider } from '../ai/providers.js';
import { listTTSProviders, getTTSProvider } from '../voice/providers.js';
import { WEBLLM_MODELS, DEFAULT_WEBLLM_MODEL } from '../ai/webllm.js';
import { listModels } from '../ai/openai-local.js';
import { brainLabel, canUseDeviceAI, useDeviceAI, connectHoldingLocal } from '../ai/brain.js';
import { voiceFor, chosenVoice, withVoice } from '../voice/resolve.js';
import { PRESETS } from '../data/archetypes.js';
import { voiceModelsPanel } from './voice-models.js';
import { chatModelsPanel } from './chat-models.js';
import { browserModelsPanel } from './browser-models.js';
import { getLocalPanel } from './get-local.js';
import { feelingFor } from '../voice/feeling.js';
import { validateLibrary } from '../engine/scripts.js';

const AI_HELP = {
  scripted: 'No AI model. The face reacts to feeling words, but replies are hand-written lines picked by feeling, so the parent does not follow what you actually type. Works offline, instantly, on every device. Turn on an AI below for real replies.',
  webllm: 'Runs a small language model inside this browser on your graphics chip (WebGPU). One-time download, then fully offline. Nothing leaves this device.',
  'openai-local': 'Uses a model running on your own computer with Ollama, LM Studio, llama.cpp, or the Holding local server. Works from your phone too, over your home Wi-Fi.',
  'holding-rag': 'The Holding companion server (local-private-tuning): your own notes as private memory (RAG) and your fine-tuned parent model, all on your computer.',
};

export function renderSettings(root, nav, params = {}) {
  const body = h('div', { class: 'stack' });
  root.append(h('main', { class: 'screen' },
    h('div', { class: 'topbar' }, h('span', { class: 'title' }, 'Settings'), h('button', { class: 'icon-btn', onclick: () => nav('home') }, 'Done')),
    body));
  const S = () => store.settings;
  const set = (patch) => store.setSettings(patch);

  function card(title, ...kids) { return h('section', { class: 'card stack' }, h('h2', {}, title), ...kids); }

  function render() {
    clear(body);
    const a = store.data.archetype;
    // --- you
    body.append(card('You',
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Your name', h('small', {}, 'Optional. Used rarely.')), h('input', { type: 'text', value: S().userName, oninput: (e) => set({ userName: e.target.value.trim() }) })),
      slider('Warmth dose', store.warmthFor(a), (v) => set({ warmth: v }), { hint: 'If kindness ever feels like too much, turn this down. Steady and plain is a fine way to be held.' }),
      toggle('Pet names', S().endearments, (v) => set({ endearments: v })),
      toggle('Suggested replies', S().suggestions !== false, (v) => set({ suggestions: v }), 'Three short things you could say, above the typing box. Tap one to say it.'),
      select('Let the AI write suggestions', S().suggestionsAI || 'auto', [['auto', 'Automatic'], ['on', 'Always, when an AI is on'], ['off', 'Never (hand-written only)']], (v) => set({ suggestionsAI: v })),
      toggle('Captions', S().captions, (v) => set({ captions: v })),
      toggle('Breathing pacer', S().breathPacer, (v) => set({ breathPacer: v }), 'A slow ring that breathes. Off by default: breath focus is not calming for everyone.'),
      toggle('Reduce motion', S().reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches, (v) => set({ reducedMotion: v })),
      select('After a conversation, ask to keep lines', S().endPrompt || 'sometimes', [['sometimes', 'Now and then'], ['always', 'Every time'], ['never', 'Never']], (v) => set({ endPrompt: v })),
      toggle('Mirror my face with the camera', S().camera, (v) => set({ camera: v }), 'Opt-in. Reads your expression on this device so the face can mirror it. No video is stored or sent. One-time model download.'),
    ));

    // --- voice
    const ttsStatus = h('p', { class: 'status' }, '');
    const ttsProg = h('div', { class: 'progress', style: { display: 'none' } }, h('i'));
    const ttsP = getTTSProvider(S().tts.provider) || getTTSProvider('webspeech');
    const ttsCfg = h('div', { class: 'stack' });
    if (ttsP.id === 'openai-speech') {
      const c = S().tts['openai-speech'] || {};
      ttsCfg.append(
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Server address'), h('input', { type: 'url', value: c.baseUrl || 'http://127.0.0.1:8787/v1', onchange: (e) => set({ tts: { 'openai-speech': { ...c, baseUrl: e.target.value.trim() } } }) })),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Pairing token (phone only)'), h('input', { type: 'password', value: c.token || '', onchange: (e) => set({ tts: { 'openai-speech': { ...c, token: e.target.value.trim() } } }) })));
    }
    // Which voice this parent uses on the current engine. Saved on the parent
    // figure, so each figure keeps its own voice. Picking one plays a preview.
    const preview = async (arch = store.data.archetype) => {
      try {
        const c = S().tts[ttsP.id] || {};
        await ttsP.init?.(c, (p) => { ttsProg.style.display = p.progress >= 1 ? 'none' : ''; ttsProg.firstChild.style.width = Math.round((p.progress || 0) * 100) + '%'; ttsStatus.className = 'status'; ttsStatus.textContent = p.progress >= 1 ? '' : (p.text || ''); });
        ttsP.stop?.();
        await ttsP.speak(`Hello. I'm ${arch.name}. I'm here.`, { voiceId: await voiceFor(ttsP.id, arch), rate: arch.voice.rate, pitch: arch.voice.pitch, archetype: arch, feeling: feelingFor(arch) });
      } catch (e) { ttsStatus.className = 'status bad'; ttsStatus.textContent = e.message || String(e); }
    };
    const voicePick = h('div', { class: 'stack' });
    ttsP.listVoices?.(S().tts[ttsP.id] || {}).then((vs) => {
      if (!vs?.length) return;
      const byGender = (g) => vs.filter((v) => (v.gender || 'n') === g);
      const groups = [['f', 'Women'], ['m', 'Men'], ['n', 'Other']].map(([g, l]) => [l, byGender(g)]).filter(([, list]) => list.length);
      const cur = chosenVoice(ttsP.id, a);
      const sel = h('select', { onchange: (e) => {
        const arch = store.data.archetype;
        const next = { ...arch, voice: withVoice(ttsP.id, arch, e.target.value) };
        const saved = (store.data.saved || []).map((x) => (x.id === next.id ? next : x));
        store.setData({ archetype: next, saved });
        preview(next);
      } },
      h('option', { value: '', selected: !cur }, 'Automatic (best match)'),
      groups.map(([label, list]) => h('optgroup', { label }, list.map((v) => h('option', { value: v.id, selected: v.id === cur }, v.label + (ttsP.id === 'webspeech' && v.lang ? ` · ${v.lang}` : ''))))));
      voicePick.append(h('label', { class: 'field' }, h('span', { class: 'lbl' }, `${a.name}'s voice`, h('small', {}, 'Pick one to hear it. Each parent figure keeps its own voice.')), sel));
    }).catch(() => {});
    body.append(card('Voice',
      toggle('Speak lines out loud', S().voiceOn, (v) => set({ voiceOn: v })),
      select('Voice engine', ttsP.id, listTTSProviders().filter((p) => p.id !== 'prerecorded').map((p) => [p.id, p.label]), (v) => { set({ tts: { provider: v } }); render(); }),
      ttsCfg,
      voiceModelsPanel({ rerender: render, preview }),
      voicePick,
      ttsProg, ttsStatus,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => preview() }, 'Test voice')),
      h('p', { class: 'muted', style: { fontSize: '.88rem', margin: 0 } }, 'Device voices are free and built in. Kokoro and Chatterbox run inside this browser after a one-time download. "Voice from my computer" uses Holding Local, which can run Chatterbox for your phone too.'),
    ));

    // --- AI
    const aiId = S().ai.provider || 'scripted';
    const ai = getLLMProvider(aiId);
    const aiStatus = h('p', { class: 'status' }, '');
    const aiProg = h('div', { class: 'progress', style: { display: 'none' } }, h('i'));
    const cfgBox = h('div', { class: 'stack' });
    const cfg = S().ai[aiId] || {};
    const setCfg = (patch) => set({ ai: { [aiId]: { ...(S().ai[aiId] || {}), ...patch } } });
    if (aiId === 'webllm') {
      cfgBox.append(select('Model', cfg.model || DEFAULT_WEBLLM_MODEL, WEBLLM_MODELS.map((m) => [m.id, `${m.label} · ~${m.sizeMB} MB`]), (v) => { setCfg({ model: v }); render(); }));
      const m = WEBLLM_MODELS.find((x) => x.id === (cfg.model || DEFAULT_WEBLLM_MODEL));
      if (m) cfgBox.append(h('p', { class: 'muted', style: { margin: 0, fontSize: '.9rem' } }, m.note));
    }
    if (aiId === 'openai-local' || aiId === 'holding-rag') {
      const defUrl = aiId === 'openai-local' ? 'http://localhost:11434/v1' : 'http://127.0.0.1:8765';
      const modelSel = h('div');
      cfgBox.append(
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Server address', h('small', {}, aiId === 'openai-local' ? 'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · Holding server: http://127.0.0.1:8787/v1. From a phone, use your computer\'s Wi-Fi address instead of localhost.' : 'From a phone, use the LAN address the server printed.')),
          h('input', { type: 'url', value: cfg.baseUrl || defUrl, onchange: (e) => setCfg({ baseUrl: e.target.value.trim().replace(/\/$/, '') }) })),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Model name', h('small', {}, `Any model tag. Suggested: gemma4:e4b (16 GB RAM), qwen3.5:4b (8 GB), gemma4:12b (32 GB), or your fine-tuned holding-${a.id}:latest`)),
          h('input', { type: 'text', value: cfg.model || (aiId === 'openai-local' ? 'gemma4:e4b' : ''), placeholder: aiId === 'holding-rag' ? 'blank = server decides' : '', onchange: (e) => setCfg({ model: e.target.value.trim() }) })),
        modelSel,
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Pairing token', h('small', {}, 'Only needed when connecting from another device on your Wi-Fi.')), h('input', { type: 'password', value: cfg.token || '', onchange: (e) => setCfg({ token: e.target.value.trim() }) })),
        aiId === 'holding-rag' ? toggle('Use my private notes (RAG)', cfg.useRag ?? true, (v) => setCfg({ useRag: v })) : null);
      // Holding Local can also list, switch and delete the chat models it keeps.
      if (aiId === 'openai-local' && /:8787(\/|$)/.test(cfg.baseUrl || '')) {
        cfgBox.append(chatModelsPanel({ cfg: () => S().ai['openai-local'] || {}, setModel: (name) => setCfg({ model: name }), rerender: render }));
      }
      if (aiId === 'openai-local') listModels({ ...cfg, baseUrl: cfg.baseUrl || defUrl }).then((ms) => { if (ms?.length) modelSel.append(select('Models found on the server', cfg.model || '', [['', 'Pick one…'], ...ms.map((m) => [m.id || m, m.id || m])], (v) => { if (v) { setCfg({ model: v }); render(); } })); }).catch(() => {});
    }
    // --- one-tap companion setup
    const comp = h('p', { class: 'status' }, '');
    const compUrl = h('input', { type: 'url', value: (S().ai['openai-local']?.baseUrl || '').includes(':8787') ? S().ai['openai-local'].baseUrl : (location.port === '8787' ? `${location.origin}/v1` : 'http://127.0.0.1:8787/v1') });
    const compTok = h('input', { type: 'password', placeholder: 'Pairing code (only from a phone)', value: S().ai['openai-local']?.token || '' });
    body.append(card('Use my computer (Holding Local)',
      h('p', { class: 'muted', style: { margin: 0 } }, 'If Holding Local is running on your computer, this points the parent\'s words, voice and listening at it in one step. Free, private, no accounts.'),
      getLocalPanel(),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Address'), compUrl),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Pairing code'), compTok),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: async () => {
        comp.className = 'status'; comp.textContent = 'Connecting…';
        try {
          await connectHoldingLocal(compUrl.value || 'http://127.0.0.1:8787/v1', compTok.value);
          comp.className = 'status ok'; comp.textContent = 'Connected. Words, voice and listening now run on your computer.';
          setTimeout(render, 1200);
        } catch (e) { comp.className = 'status bad'; comp.textContent = e.message; if (!comp.nextSibling?.classList?.contains('get-local')) comp.after(getLocalPanel({ always: true })); }
      } }, 'Connect')),
      comp,
      (() => { const panel = h('div'); try { window.HoldingMobile?.renderPairingPanel?.(panel); } catch {} return panel.childNodes.length ? h('details', { open: /iPhone|iPad|Android/i.test(navigator.userAgent) }, h('summary', {}, 'Pair this phone with a code or QR'), panel) : null; })()));

    // --- dictation
    body.append(card('Talking instead of typing',
      select('Dictation', S().stt.provider || 'browser', [['browser', 'Browser dictation'], ['server', 'Holding Local (private, on my computer)'], ['off', 'Off']], (v) => { set({ stt: { provider: v } }); render(); }),
      h('p', { class: 'muted', style: { margin: 0, fontSize: '.88rem' } }, S().stt.provider === 'browser' ? 'Heads up: in Chrome and some other browsers, dictation audio is sent to the browser maker\'s servers. Safari on Apple devices can do it on-device. For fully private listening, use Holding Local.' : S().stt.provider === 'server' ? `Audio goes only to ${S().stt.baseUrl || 'your computer'}.` : 'The microphone button is hidden.')));

    const quick = aiId === 'scripted' ? h('div', { class: 'row wrap' },
      canUseDeviceAI() ? h('button', { class: 'btn primary', onclick: () => { useDeviceAI(); render(); setTimeout(() => document.getElementById('ai-card')?.scrollIntoView({ block: 'start' }), 50); } }, 'Use the AI on this device') : null,
      h('button', { class: 'btn', onclick: async (e) => { e.target.disabled = true; try { await connectHoldingLocal(); render(); } catch (err) { aiStatus.className = 'status bad'; aiStatus.textContent = err.message; if (!aiStatus.nextSibling?.classList?.contains('get-local')) aiStatus.after(getLocalPanel({ always: true })); } finally { e.target.disabled = false; } } }, 'Use Holding Local on my computer')) : null;
    const aiCard = card('AI: what writes the parent\'s words',
      h('p', { class: 'status ' + (aiId === 'scripted' ? 'bad' : 'ok'), style: { margin: 0 } }, aiId === 'scripted' ? 'Right now: scripted lines. The parent is not reading what you type.' : `Right now: ${brainLabel(aiId)}.`),
      quick,
      select('What writes the parent\'s words', aiId, listLLMProviders().map((p) => [p.id, p.label]), (v) => { set({ ai: { provider: v } }); render(); }),
      h('p', { class: 'muted', style: { margin: 0, fontSize: '.92rem' } }, AI_HELP[aiId] || ''),
      cfgBox, aiProg, aiStatus,
      browserModelsPanel({ provider: aiId, model: S().ai.webllm?.model }),
      aiId !== 'scripted' ? h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: async () => {
          aiStatus.className = 'status'; aiStatus.textContent = 'Checking…';
          const r = await ai.isAvailable(S().ai[aiId] || {});
          aiStatus.className = 'status ' + (r.ok ? 'ok' : 'bad'); aiStatus.textContent = r.ok ? 'Available.' : r.reason;
        } }, 'Check'),
        h('button', { class: 'btn primary', onclick: async () => {
          aiProg.style.display = ''; aiStatus.className = 'status'; aiStatus.textContent = 'Loading…';
          try {
            await ai.init(S().ai[aiId] || {}, (p) => { aiProg.firstChild.style.width = Math.round((p.progress || 0) * 100) + '%'; aiStatus.textContent = p.text || ''; });
            const out = await ai.generate({ system: `You are ${a.name}, a calm, steady parent figure. Reply in one short sentence, no question.`, messages: [{ role: 'user', content: 'I had a hard day.' }], maxTokens: 50, temperature: .6, archetype: a });
            aiStatus.className = 'status ok'; aiStatus.textContent = `Working. Sample: "${out.trim()}"`;
          } catch (e) { aiStatus.className = 'status bad'; aiStatus.textContent = e.message || String(e); }
        } }, aiId === 'webllm' ? 'Download and test' : 'Test')) : null,
      h('p', { class: 'muted', style: { margin: 0, fontSize: '.88rem' } }, 'Whatever model you choose, every reply still goes through the same rules (length, no questions at peak distress, nothing hostile or helpless), and the scripted lines take over instantly if a reply breaks them or the model is slow. No Claude API or paid service is used.'),
    );
    aiCard.id = 'ai-card';
    // While nothing reads the user's words, put this first so it is hard to miss.
    if (aiId === 'scripted' || params.focus === 'ai') body.insertBefore(aiCard, body.firstChild); else body.append(aiCard);

    // --- safety
    const sc = S().safetyContact || {};
    body.append(card('My person',
      h('p', { class: 'muted', style: { margin: 0 } }, 'Someone you could call or text on a hard night. Shown on the "Not safe" screen next to 988.'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), h('input', { type: 'text', value: sc.name || '', onchange: (e) => set({ safetyContact: { ...sc, name: e.target.value.trim() } }) })),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Phone'), h('input', { type: 'tel', value: sc.phone || '', onchange: (e) => set({ safetyContact: { ...sc, phone: e.target.value.trim() } }) }))));

    // --- install / mobile
    if (window.HoldingMobile?.showInstallSheet) body.append(card('On your phone', h('button', { class: 'btn', onclick: () => window.HoldingMobile.showInstallSheet() }, 'Put Holding on my home screen')));

    // --- data
    const dl = (name, text) => { const u = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const l = h('a', { href: u, download: name }); document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
    body.append(card('Your data',
      h('p', { class: 'muted', style: { margin: 0 } }, 'Stored only in this browser on this device. No accounts, no analytics.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => dl('holding-export.json', store.exportAll()) }, 'Export everything'),
        h('button', { class: 'btn', onclick: () => dl(`${a.id}.json`, JSON.stringify(a, null, 2)) }, `Export ${a.name} for the AI tools`),
        h('button', { class: 'btn', onclick: () => { for (const p of PRESETS) dl(`${p.id}.json`, JSON.stringify(p, null, 2)); } }, 'Export all presets'),
        h('button', { class: 'btn', style: { color: 'var(--danger)' }, onclick: () => { if (confirmWipe()) { store.wipe(); toast('Everything was deleted.'); nav('builder'); } } }, 'Delete everything')),
      h('p', { class: 'muted', style: { margin: 0, fontSize: '.85rem' } }, 'Archetype files drop straight into the companion skill\'s ~/.parent-vault/archetypes/ folder for private RAG and fine-tuning.')));

    // --- about
    const bad = validateLibrary();
    body.append(card('About',
      h('p', {}, `${a.name} is an AI companion. Not a person, not a therapist, and not for emergencies. It is built to sit beside human care, and to help you need it less over time.`),
      h('details', {}, h('summary', {}, 'Line library check'), h('p', { class: 'muted' }, bad.length ? `${bad.length} lines fail the rules and are skipped: ${bad.slice(0, 3).map((b) => b.path).join(', ')}…` : 'Every scripted line passes the guard.'))));
  }
  function confirmWipe() {
    // Inline two-tap confirm instead of a blocking dialog.
    if (renderSettings._armed && Date.now() - renderSettings._armed < 4000) return true;
    renderSettings._armed = Date.now(); toast('Tap "Delete everything" again to confirm.'); return false;
  }
  render();
  return () => {};
}
