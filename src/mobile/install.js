// "Put Holding on your phone" sheet. Platform-aware, never shown during Hold-me mode.
import { platformInfo } from './device.js';

export const APK_URL = 'https://github.com/claudiasellers/holding/releases/latest/download/holding.apk';
const DISMISS_KEY = 'holding.install.dismissedAt';

let deferredPrompt = null;
let listenersReady = false;

export function initInstallListeners() {
  if (listenersReady) return;
  listenersReady = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own, calmer prompt
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent('holding:installable'));
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (_) {}
  });
}

export function canPromptNatively() { return !!deferredPrompt; }

/** Should we gently offer install? Not if installed, in Hold-me, recently dismissed, or in the APK. */
export function shouldOfferInstall() {
  const p = platformInfo();
  if (p.isStandalone || p.isCapacitor) return false;
  if (new URLSearchParams(location.search).get('mode') === 'hold') return false;
  let last = 0;
  try { last = Number(localStorage.getItem(DISMISS_KEY) || 0); } catch (_) {}
  if (Date.now() - last < 14 * 24 * 3600 * 1000) return false;
  return p.isMobile || !!deferredPrompt;
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" class="hm-inline-icon"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" class="hm-inline-icon"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.5v7M8.5 12h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const DOTS_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" class="hm-inline-icon"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>';

function stepsFor(p) {
  if (p.isInAppBrowser) {
    return `<p>This page is open inside another app. Open it in ${p.isIOS ? 'Safari' : 'Chrome'} first: use the app's menu and choose <b>Open in browser</b>.</p>`;
  }
  if (p.isIOS) {
    return `<ol class="hm-steps">
      <li>Tap ${SHARE_ICON} <b>Share</b> ${p.isIOSNonSafari ? '(in Chrome it’s at the top right)' : 'in the toolbar'}.</li>
      <li>Scroll down and tap ${PLUS_ICON} <b>Add to Home Screen</b>.</li>
      <li>Tap <b>Add</b>. Holding now opens full screen from its own icon.</li>
    </ol>
    <p class="hm-muted">No App Store needed. Your conversations stay on this phone.</p>`;
  }
  if (p.isAndroid) {
    return `<div class="hm-row" data-native-row ${deferredPrompt ? '' : 'hidden'}><button class="hm-btn hm-primary" data-act="native-install">Install Holding</button></div>
    <ol class="hm-steps" data-manual ${deferredPrompt ? 'hidden' : ''}>
      <li>Tap ${DOTS_ICON} in Chrome’s top bar.</li>
      <li>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</li>
    </ol>
    <details class="hm-details"><summary>Prefer an APK file?</summary>
      <p>Download <a href="${APK_URL}" rel="noopener">holding.apk</a>, open it, and allow your browser to install apps when Android asks. The Chrome install above is usually better: it updates itself and runs the on-phone model faster.</p>
    </details>`;
  }
  return `<div class="hm-row" data-native-row ${deferredPrompt ? '' : 'hidden'}><button class="hm-btn hm-primary" data-act="native-install">Install Holding</button></div>
    <p class="hm-muted" data-manual ${deferredPrompt ? 'hidden' : ''}>In Chrome or Edge, use the install icon in the address bar. On a phone, open this same address and add it to your home screen.</p>`;
}

/**
 * Show the install sheet.
 * @param {{reason?: string}} [opts]
 */
export function showInstallSheet(opts = {}) {
  const p = platformInfo();
  closeInstallSheet();
  const wrap = document.createElement('div');
  wrap.className = 'hm-sheet-backdrop';
  wrap.setAttribute('data-hm-install', '');
  wrap.innerHTML = `
    <section class="hm-sheet" role="dialog" aria-modal="true" aria-labelledby="hm-install-title">
      <div class="hm-grabber" aria-hidden="true"></div>
      <div class="hm-glow" aria-hidden="true"></div>
      <h2 id="hm-install-title" class="hm-h2">Keep Holding on your home screen</h2>
      <p class="hm-lead">${opts.reason || 'One tap away when you need it, and it works offline.'}</p>
      ${stepsFor(p)}
      <div class="hm-row hm-end"><button class="hm-btn hm-quiet" data-act="later">Not now</button></div>
    </section>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('hm-open'));

  const nativeBtn = wrap.querySelector('[data-act="native-install"]');
  if (nativeBtn) nativeBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (_) {}
    deferredPrompt = null;
    closeInstallSheet();
  });
  const onInstallable = () => {
    wrap.querySelectorAll('[data-native-row]').forEach((el) => el.removeAttribute('hidden'));
    wrap.querySelectorAll('[data-manual]').forEach((el) => el.setAttribute('hidden', ''));
  };
  window.addEventListener('holding:installable', onInstallable, { once: true });
  wrap.querySelector('[data-act="later"]').addEventListener('click', () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (_) {}
    closeInstallSheet();
  });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeInstallSheet(); });
  document.addEventListener('keydown', escClose);
}

function escClose(e) { if (e.key === 'Escape') closeInstallSheet(); }

export function closeInstallSheet() {
  document.removeEventListener('keydown', escClose);
  const el = document.querySelector('[data-hm-install]');
  if (!el) return;
  el.classList.remove('hm-open');
  setTimeout(() => el.remove(), 250);
}

/** A small, dismissible chip; tapping it opens the sheet. Use after a calm session ends, not at launch. */
export function showInstallChip(host = document.body) {
  if (!shouldOfferInstall() || document.querySelector('[data-hm-chip]')) return;
  const chip = document.createElement('button');
  chip.className = 'hm-chip';
  chip.setAttribute('data-hm-chip', '');
  chip.innerHTML = `<span class="hm-chip-dot" aria-hidden="true"></span>Add to home screen`;
  chip.addEventListener('click', () => { chip.remove(); showInstallSheet(); });
  host.appendChild(chip);
}
