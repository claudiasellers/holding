// Three suggested replies floating above the input. Rules show instantly; when
// the user has typed their own words and a local model is ready and idle, a
// model pass replaces them with replies that follow the conversation.
// Nothing here is stored: the context is read from the live session and
// dropped when the session ends.
import { h, clear } from './dom.js';
import { store } from '../store.js';
import { getLLMProvider } from '../ai/providers.js';
import { gist, ruleSuggestions, buildSuggestPrompt, parseModelSuggestions, mergeSuggestions, isStarter } from '../engine/suggest.js';

const MODEL_DELAY_MS = 700;           // after the parent finishes speaking
const MODEL_TIMEOUT_MS = { webllm: 6000, default: 9000 };

const isPhone = () => typeof navigator !== 'undefined'
  && (navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * Which model, if any, may write suggestions. 'auto' keeps the in-browser model
 * off on phones: on one GPU the extra call delays the parent's reply and throws
 * away its reusable prompt cache (docs/SUGGESTIONS.md).
 */
export function suggestionModel(settings = store.settings, phone = isPhone()) {
  const mode = settings.suggestionsAI || 'auto';
  const id = settings.ai?.provider || 'scripted';
  if (mode === 'off' || id === 'scripted') return null;
  if (mode === 'auto' && (id === 'holding-rag' || (id === 'webllm' && phone))) return null;
  return id;
}

/**
 * @param {{ session: object, input: HTMLTextAreaElement, onSend: (text:string)=>void, parentName: string }} o
 * @returns {{ el: HTMLElement, attach(ui:object): void, refresh(): void, cancel(): void, destroy(): void }}
 */
export function createSuggestions({ session, input, onSend, parentName }) {
  const el = h('div', { class: 'suggests', role: 'group', 'aria-label': 'Things you could say' });
  let shown = [];
  let ac = null, timer = null, lastKey = '', dead = false;

  function render(list) {
    if (dead) return;
    const g = gist(session.state);
    const hide = !store.settings.suggestions || g.safety || g.ended || !list.length;
    el.classList.toggle('hidden', hide);
    if (hide || same(list, shown)) return;
    shown = list;
    clear(el).append(...list.map((t) => h('button', {
      class: 'suggest' + (isStarter(t) ? ' starter' : ''), type: 'button',
      'aria-label': isStarter(t) ? `Start with: ${t}` : `Say: ${t}`,
      onclick: () => pick(t),
    }, t)));
  }

  function pick(t) {
    cancel();
    if (isStarter(t)) {
      input.value = t.replace(/(…|\.\.\.)$/, '').trimEnd() + ' ';
      input.dispatchEvent(new Event('input'));
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
      return;
    }
    onSend(t);
  }

  /** Rules now; model later if it's allowed and has something new to read. */
  function refresh() {
    if (dead) return;
    const g = gist(session.state);
    render(ruleSuggestions(g));
  }

  function scheduleModel() {
    clearTimeout(timer);
    if (dead || !store.settings.suggestions) return;
    timer = setTimeout(runModel, MODEL_DELAY_MS);
  }

  async function runModel() {
    const id = suggestionModel();
    const provider = id && getLLMProvider(id);
    const g = gist(session.state);
    // Only once the user is running their own conversation; before that the
    // rules already know everything there is to know.
    if (!provider || !session.modelReady || !g.userTurns || g.safety || g.ended) return;
    if (g.lastKind === 'repair') return;                 // the repair's check has fixed answers
    if (input.value.trim()) return;                       // don't move chips under someone typing
    if (g.recent.at(-1)?.role !== 'assistant') return;   // a reply is still coming; don't hold up the model
    const key = g.recent.map((m) => m.text).join('|');
    if (key === lastKey) return;
    lastKey = key;
    cancel();
    const mine = ac = new AbortController();
    const to = setTimeout(() => mine.abort(), MODEL_TIMEOUT_MS[id] || MODEL_TIMEOUT_MS.default);
    try {
      const req = buildSuggestPrompt(g, { parentName });
      const text = await provider.generate({ ...req, archetype: store.data.archetype, signal: mine.signal }, store.settings.ai?.[id]);
      if (mine.signal.aborted || dead) return;
      const model = parseModelSuggestions(text, g);
      if (!model.length || input.value.trim()) return;
      const now = gist(session.state);
      if (now.recent.map((m) => m.text).join('|') !== key) return;   // the talk moved on
      render(mergeSuggestions(model, ruleSuggestions(now)));
    } catch (e) {
      if (!mine.signal.aborted) console.info('[holding] suggestions fell back to rules:', e?.message);
      lastKey = '';
    } finally {
      clearTimeout(to);
      if (ac === mine) ac = null;
    }
  }

  /** Stop any model pass (the user is sending, or the parent is about to answer). */
  function cancel() { clearTimeout(timer); if (ac) { ac.abort(); ac = null; } }

  /**
   * Hook into the session's UI callbacks without the session knowing about
   * suggestions: refresh on every parent line, try the model once it's quiet.
   */
  function attach(ui) {
    const wrap = (name, after) => {
      const orig = ui[name];
      ui[name] = function (...args) { const r = orig?.apply(this, args); try { after(...args); } catch (e) { console.info('[holding] suggestions:', e?.message); } return r; };
    };
    wrap('onSay', () => { cancel(); refresh(); });
    wrap('onSpeakEnd', () => scheduleModel());
    wrap('onMirror', () => refresh());
    wrap('onSafety', () => refresh());
    wrap('onEnd', () => { cancel(); render([]); });
  }

  input.addEventListener('input', () => { if (input.value.trim()) clearTimeout(timer); });
  const unsub = store.on((k) => { if (k === 'settings') refresh(); });

  return {
    el, attach, refresh, cancel,
    destroy() { dead = true; cancel(); unsub(); },
  };
}

function same(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
