// Mobile bootstrap. Imported once by src/main.js. Safe to import anywhere: does nothing harmful
// on desktop, inside the Android APK, or on the Vite dev server.
import './mobile.css';
import { probeDevice, requestPersistentStorage, describeProbe, platformInfo } from './device.js';
import { initInstallListeners, showInstallSheet, showInstallChip, shouldOfferInstall, APK_URL } from './install.js';
import { consumePairingFromUrl, renderPairingPanel, detectSameOriginServer, getHomeServer, saveHomeServer, testHomeServer } from './pairing.js';
import * as webllmMobile from './webllm-mobile.js';
import { prerecorded, unlockAudio, createPrerecordedTTS } from './prerecorded-tts.js';

const isDev = (() => { try { return !!import.meta.env && import.meta.env.DEV; } catch (_) { return false; } })();

function ensureHeadTags() {
  const head = document.head;
  const add = (tag, attrs) => {
    const sel = Object.entries(attrs).filter(([k]) => k === 'rel' || k === 'name').map(([k, v]) => `${tag}[${k}="${v}"]`).join('');
    if (sel && head.querySelector(sel)) return;
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    head.appendChild(el);
  };
  add('link', { rel: 'manifest', href: 'manifest.webmanifest' });
  add('link', { rel: 'apple-touch-icon', href: 'icons/apple-touch-icon.png' });
  add('meta', { name: 'theme-color', content: '#f6efe6' });
  add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'default' });
  add('meta', { name: 'apple-mobile-web-app-title', content: 'Holding' });
  const vp = head.querySelector('meta[name="viewport"]');
  if (vp && !/viewport-fit/.test(vp.content)) vp.content += ', viewport-fit=cover';
}

function toast(text, ms = 4000) {
  const el = document.createElement('div');
  el.className = 'hm-toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function registerServiceWorker() {
  const p = platformInfo();
  if (!('serviceWorker' in navigator) || !window.isSecureContext || p.isCapacitor || isDev) return null;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    // A new version waits quietly; it takes over the next time the app is closed and reopened.
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else if (window.__hmUpdated && Date.now() - hiddenAt > 10 * 60 * 1000 && HoldingMobile.isIdle()) {
        location.reload();
      }
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { window.__hmUpdated = true; });
    return reg;
  } catch (err) {
    console.warn('[holding] service worker registration failed', err);
    return null;
  }
}

/** Ask the service worker to keep these audio files (e.g. an archetype's scripted lines) offline. */
async function cacheAudio(urls) {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg || !reg.active) return false;
  reg.active.postMessage({ type: 'CACHE_AUDIO', urls });
  return true;
}

export const HoldingMobile = {
  probeDevice,
  describeProbe,
  platformInfo,
  showInstallSheet,
  showInstallChip,
  shouldOfferInstall,
  renderPairingPanel,
  getHomeServer,
  saveHomeServer,
  testHomeServer,
  cacheAudio,
  requestPersistentStorage,
  webllm: webllmMobile,
  prerecorded,
  unlockAudio,
  createPrerecordedTTS,
  APK_URL,
  /** The core app can replace this so updates never reload mid-session. */
  isIdle: () => !document.querySelector('[data-session-active="true"]'),
};

let started = false;
export async function initMobile() {
  if (started) return HoldingMobile;
  started = true;
  ensureHeadTags();
  initInstallListeners();
  window.HoldingMobile = HoldingMobile;

  const onPair = () => {
    if (consumePairingFromUrl()) toast('Paired with your computer. It will be used for replies.');
  };
  onPair();
  window.addEventListener('hashchange', onPair);

  registerServiceWorker();

  // Storage: ask once the user has interacted (Chrome needs engagement; Safari favours Home Screen apps).
  const askPersist = () => { requestPersistentStorage(); window.removeEventListener('pointerdown', askPersist); };
  if (platformInfo().isStandalone) requestPersistentStorage();
  else window.addEventListener('pointerdown', askPersist, { once: true });

  // Served by the home computer itself (Tailscale address)? Use it automatically.
  if (!getHomeServer() && /\.ts\.net$/i.test(location.hostname)) {
    detectSameOriginServer().then((r) => {
      if (r && r.ok) saveHomeServer({ baseUrl: r.baseUrl });
      else if (r && r.needsPairing) window.dispatchEvent(new CustomEvent('holding:needs-pairing', { detail: r }));
    });
  }

  // Probe in the background so the settings screen and the webllm provider have it ready.
  probeDevice().then((probe) => {
    window.dispatchEvent(new CustomEvent('holding:device', { detail: probe }));
  });

  // Keep the chosen parent's recorded lines offline, and follow changes of archetype.
  const cacheChosen = () => {
    const id = window.Holding && window.Holding.store && window.Holding.store.data.archetype && window.Holding.store.data.archetype.id;
    if (id && id !== cacheChosen.last) { cacheChosen.last = id; prerecorded.cacheArchetype(id).catch(() => {}); }
  };
  setTimeout(() => {
    cacheChosen();
    if (window.Holding && window.Holding.store && window.Holding.store.on) window.Holding.store.on((k) => { if (k === 'data') cacheChosen(); });
  }, 0);

  // ?install opens the sheet directly (used by links in docs and the README).
  if (new URLSearchParams(location.search).has('install')) showInstallSheet();
  return HoldingMobile;
}

initMobile();
