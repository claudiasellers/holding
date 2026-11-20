// Pair a phone with the home computer (the desktop server built in local-ai/).
// The phone talks to it through the core app's 'openai-local' provider (OpenAI-compatible API).
//
// Ways in:
//  1. Link:  https://<host>.<tailnet>.ts.net/#pair=TOKEN      (QR code from the desktop server)
//            https://<pages-host>/holding/#pair=TOKEN&server=https://<host>.ts.net
//  2. Typed: a short code shown on the computer (needed on iPhone: the camera opens links in
//            Safari, whose storage is separate from the Home Screen app's).
//  3. Same origin: if this page is itself served by the home server, the base URL is known.

const SETTINGS_KEY = 'holding.settings.v1';
const PROVIDER_ID = 'openai-local';

// The core app keeps settings in memory (src/store.js) and writes them back whole, so go through
// window.Holding.store when it exists; raw localStorage is only the fallback before the app boots.
const appStore = () => (window.Holding && window.Holding.store) || null;

export function readSettings() {
  const st = appStore();
  if (st) return st.settings || {};
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function patchSettings(patch) {
  const st = appStore();
  if (st) st.setSettings(patch);
  else {
    // Deep-merge into the stored object so nothing else is lost.
    const merge = (a, b) => { const o = { ...(a || {}) }; for (const k in b) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge(o[k], b[k]) : b[k]; return o; };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(merge(readSettings(), patch))); } catch (_) {}
  }
  try { window.dispatchEvent(new CustomEvent('holding:settings-changed', { detail: { source: 'pairing' } })); } catch (_) {}
}

export function getHomeServer() {
  const s = readSettings();
  const c = s.ai && s.ai[PROVIDER_ID];
  return c && c.baseUrl && (c.pairedAt || c.apiKey || c.token) ? c : null;
}

/** Normalise "https://host.ts.net", "host.ts.net/", "https://host/v1" → "https://host.ts.net/v1". */
export function normaliseBaseUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const url = new URL(u);
    url.hash = '';
    url.search = '';
    let path = url.pathname.replace(/\/+$/, '');
    if (!/\/v1$/.test(path)) path += '/v1';
    url.pathname = path;
    return url.toString().replace(/\/$/, '');
  } catch (_) { return ''; }
}

/**
 * Point words, voice and listening at the paired computer, in the same shape the core app's
 * "Use my computer" card writes: ai['openai-local'], tts['openai-speech'], stt.server.
 */
export function saveHomeServer({ baseUrl, apiKey, model, makeDefault = true }) {
  const s = readSettings();
  const prev = (s.ai && s.ai[PROVIDER_ID]) || {};
  const token = apiKey || prev.apiKey || prev.token || '';
  const keepModel = prev.model && !/^llama3\.2/.test(prev.model) ? prev.model : 'gemma4:e4b';
  const cfg = { ...prev, baseUrl, apiKey: token, token, model: model || keepModel, pairedAt: Date.now() };
  const patch = { ai: { [PROVIDER_ID]: cfg } };
  if (makeDefault) {
    patch.ai.provider = PROVIDER_ID;
    patch.tts = { provider: 'openai-speech', 'openai-speech': { ...((s.tts && s.tts['openai-speech']) || {}), baseUrl, token, model: 'kokoro' } };
    patch.stt = { provider: 'server', baseUrl, token };
  }
  patchSettings(patch);
  return cfg;
}

export function forgetHomeServer() {
  const s = readSettings();
  const patch = { ai: { [PROVIDER_ID]: { baseUrl: '', apiKey: '', token: '' } } };
  if (s.ai && s.ai.provider === PROVIDER_ID) patch.ai.provider = 'scripted';
  if (s.tts && s.tts.provider === 'openai-speech') patch.tts = { provider: 'webspeech' };
  if (s.stt && s.stt.provider === 'server') patch.stt = { provider: 'browser' };
  patchSettings(patch);
}

/**
 * Read #pair=… / ?pair=… from the current URL, save it, and clean the URL.
 * @returns {{baseUrl:string, apiKey:string}|null}
 */
export function consumePairingFromUrl(loc = window.location) {
  const params = new URLSearchParams((loc.hash || '').replace(/^#/, ''));
  const q = new URLSearchParams(loc.search || '');
  const token = params.get('pair') || q.get('pair');
  if (!token) return null;
  const server = params.get('server') || q.get('server');
  const baseUrl = normaliseBaseUrl(server || loc.origin + loc.pathname.replace(/\/[^/]*$/, ''));
  const saved = saveHomeServer({ baseUrl, apiKey: token });
  try {
    params.delete('pair'); params.delete('server');
    q.delete('pair'); q.delete('server');
    const hash = params.toString();
    const search = q.toString();
    history.replaceState(null, '', loc.pathname + (search ? '?' + search : '') + (hash ? '#' + hash : ''));
  } catch (_) {}
  return saved;
}

/**
 * Check a server. Returns {ok, status, models, needsPairing, error}.
 * A 401/403 means the server is there but wants a pairing code.
 */
export async function testHomeServer(baseUrl, apiKey, { timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + '/models', {
      headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, needsPairing: true };
    if (res.status === 429) return { ok: false, status: 429, error: 'Too many wrong codes. Wait a minute, then try again.' };
    if (!res.ok) return { ok: false, status: res.status, error: 'Server answered ' + res.status };
    const body = await res.json().catch(() => ({}));
    const models = Array.isArray(body.data) ? body.data.map((m) => m.id) : [];
    return { ok: true, status: res.status, models };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'No answer in time. Is the computer awake and Tailscale on?' : 'Couldn’t reach it. Check the address, and that Tailscale is on for both devices.';
    return { ok: false, status: 0, error: msg };
  } finally { clearTimeout(t); }
}

/** The desktop server's pairing secret is the short code itself (XXXX-XXXX); it ignores case, dashes and spaces. */
export function pairWithCode(_baseUrl, code) {
  return String(code || '').trim().toUpperCase();
}

/** If this page is served by a home server, it's the obvious one to use. */
export async function detectSameOriginServer() {
  const base = normaliseBaseUrl(location.origin + location.pathname.replace(/\/[^/]*$/, ''));
  const r = await testHomeServer(base, getHomeServer()?.apiKey, { timeoutMs: 2500 });
  if (r.ok || r.needsPairing) return { baseUrl: base, ...r };
  return null;
}

/**
 * Settings panel: shows status, lets the user paste a link or type a code, test, and forget.
 * @param {HTMLElement} host
 */
export function renderPairingPanel(host) {
  if (!host.__hmPairBound) {
    host.__hmPairBound = true;
    window.addEventListener('holding:settings-changed', () => { if (host.isConnected) renderPairingPanel(host); });
  }
  const current = getHomeServer();
  host.classList.add('hm-pair');
  host.innerHTML = `
    <div class="hm-status" data-status>${current ? 'Paired with ' + escapeHtml(hostOf(current.baseUrl)) : 'Not paired yet.'}</div>
    <label class="hm-label" for="hm-pair-url">Link or address</label>
    <input id="hm-pair-url" class="hm-input" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
      placeholder="Like mac-mini.your-tailnet.ts.net" value="${current ? escapeHtml(current.baseUrl.replace(/\/v1$/, '')) : ''}">
    <label class="hm-label" for="hm-pair-code">Pairing code</label>
    <input id="hm-pair-code" class="hm-input hm-code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="K7QM-2XPA">
    <div class="hm-row">
      <button class="hm-btn hm-primary" data-act="pair">Connect</button>
      ${current ? '<button class="hm-btn" data-act="forget">Forget</button>' : ''}
    </div>
    <p class="hm-muted">Both are under <b>Pair a phone</b> in Holding Local's menu on your computer.</p>`;
  const status = host.querySelector('[data-status]');
  host.querySelector('[data-act="pair"]').addEventListener('click', async () => {
    const raw = host.querySelector('#hm-pair-url').value.trim();
    const code = host.querySelector('#hm-pair-code').value.trim();
    // A pasted full pairing link carries its own token.
    let token = '';
    let addr = raw;
    const m = /[#?&]pair=([^&]+)/.exec(raw);
    if (m) { token = decodeURIComponent(m[1]); addr = raw.split(/[#?]/)[0]; }
    const baseUrl = normaliseBaseUrl(addr || location.origin);
    if (!baseUrl) { status.textContent = 'That address doesn’t look right.'; return; }
    if (!/^https:/i.test(baseUrl) && !/^http:\/\/(localhost|127\.)/i.test(baseUrl)) {
      status.textContent = 'Use the https:// address from tailscale serve. Phones block plain http here.';
      return;
    }
    status.textContent = 'Checking…';
    if (!token && code) token = pairWithCode(baseUrl, code);
    const r = await testHomeServer(baseUrl, token || getHomeServer()?.apiKey);
    if (r.ok) {
      saveHomeServer({ baseUrl, apiKey: token || getHomeServer()?.apiKey });
      status.textContent = 'Connected to ' + hostOf(baseUrl) + (r.models.length ? ' · ' + r.models.length + ' models' : '');
    } else if (r.needsPairing) {
      status.textContent = token ? 'That code didn\u2019t match. Check the code on the computer (like K7QM-2XPA).' : 'Found it. It needs the code shown on the computer.';
    } else {
      status.textContent = 'Your computer didn\u2019t answer. Is Holding Local open there, and is this phone on the same network?';
    }
  });
  const forget = host.querySelector('[data-act="forget"]');
  if (forget) forget.addEventListener('click', () => { forgetHomeServer(); renderPairingPanel(host); });
}

function hostOf(u) { try { return new URL(u).host; } catch (_) { return u; } }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
