import './ui/styles.css';
import './ai/scripted.js';
import './ai/webllm.js';
import './ai/openai-local.js';
import './ai/holding-rag.js';
import './voice/webspeech.js';
import './voice/kokoro.js';
import './voice/chatterbox.js';
import './voice/chatterbox-turbo.js';
import './voice/openai-speech.js';
import { unlockSpeech } from './voice/webspeech.js';
import { unlockAudio } from './voice/kokoro.js';
import { store } from './store.js';
import { PRESETS } from './data/archetypes.js';
import { normalizeArchetype } from './data/schema.js';
import { clear } from './ui/dom.js';
import { renderHome } from './ui/home.js';
import { renderBuilder } from './ui/builder.js';
import { renderSession } from './ui/session.js';
import { renderMemory } from './ui/memory.js';
import { renderSettings } from './ui/settings.js';
import { renderWidget, isWidget, toNative, sizeFor } from './ui/widget.js';
import { connectHoldingLocal } from './ai/brain.js';
import { warmUp } from './ai/webllm.js';

// Optional mobile layer (PWA, install, pairing, prerecorded voice). Present when built from the full repo.
const mobile = import.meta.glob('./mobile/register.js');
for (const load of Object.values(mobile)) load().catch((e) => console.info('[holding] mobile layer not loaded', e));
// Optional extra providers dropped in by other modules (e.g. prerecorded voice).
const extras = import.meta.glob(['./voice/extra/*.js', './ai/extra/*.js']);
for (const load of Object.values(extras)) load().catch(() => {});

const app = document.getElementById('app');
let teardown = null;
const SCREENS = { home: renderHome, builder: renderBuilder, session: renderSession, memory: renderMemory, settings: renderSettings, widget: renderWidget };
if (isWidget) document.documentElement.dataset.widget = '1';

function nav(name, params = {}) {
  teardown?.();
  teardown = null;
  clear(app);
  // In the widget, "home" is the small resting face; elsewhere the widget screen is never used.
  if (name === 'home' && isWidget) name = 'widget';
  if (name === 'widget' && !isWidget) name = 'home';
  if (!store.data.archetype && name !== 'builder' && name !== 'settings') name = 'builder';
  if (isWidget) toNative({ type: 'size', size: sizeFor(name) });
  document.body.dataset.screen = name;
  if (name === 'session') document.body.setAttribute('data-session-active', 'true');
  else document.body.removeAttribute('data-session-active');
  teardown = SCREENS[name](app, nav, params) || null;
  window.scrollTo(0, 0);
  if (name !== 'session') history.replaceState(null, '', location.pathname + (isWidget ? '?widget=1' : '') + location.hash);
}

// iOS and most mobile browsers only allow audio after a user gesture.
let unlocked = false;
document.addEventListener('pointerdown', () => { if (unlocked && window.HoldingMobile?.isUnlocked?.() !== false) return; unlocked = true; try { window.HoldingMobile?.unlockAudio?.(); unlockSpeech(); unlockAudio(); } catch {} }, { capture: true });

// keep a saved archetype fresh with any new schema defaults
if (store.data.archetype) store.setData({ archetype: normalizeArchetype(store.data.archetype) });

const q = new URLSearchParams(location.search);
// Opened from the Holding Local Mac app (?local=1): use this computer's AI, voice and
// listening right away instead of the scripted lines, so nobody has to find Settings.
if (q.get('local') === '1' && store.settings.ai?.provider !== 'openai-local') {
  connectHoldingLocal(`${location.origin}/v1`).catch(() => {});
}
const wanted = q.get('mode');
if (wanted === 'hold' || wanted === 'talk' || wanted === 'makesense') {
  // Home-screen "Hold me" shortcut: go straight in. If no figure was chosen yet, use the first preset.
  if (!store.data.archetype) store.setData({ archetype: PRESETS[0] });
  nav('session', { mode: wanted });
} else nav(store.data.archetype ? 'home' : 'builder');

// Load the in-browser AI in the background as soon as the app opens, so it is
// ready by the time someone taps Hold me. It then stays in memory for every
// session until the page closes (only a GPU crash or deleting the model unloads
// it). Never starts a first-time download by itself.
function warmAI() {
  const ai = store.settings.ai || {};
  if (ai.provider !== 'webllm' || ai.webllm?.warm === false) return;
  warmUp(ai.webllm || {}).then((r) => console.info('[holding] AI warm-up:', r));
}
(window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(warmAI, { timeout: 3000 });

window.Holding = { nav, store, isWidget };
