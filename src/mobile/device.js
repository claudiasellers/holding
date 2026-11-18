// Device capability probe for phones (and everything else).
// Answers: what platform is this, is it installed, can it run a model on its own GPU,
// and which brain should Holding use by default here.

const MB = 1024 * 1024;

export function platformInfo() {
  const ua = navigator.userAgent || '';
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || isIPadOS;
  const isAndroid = /Android/i.test(ua);
  const iosMatch = /OS (\d+)[_.](\d+)/.exec(ua);
  // Safari reports "Version/26.x" on iOS 26+ (the OS token is frozen at 18_x in some builds).
  const safariVer = /Version\/(\d+)(?:\.(\d+))?/.exec(ua);
  const iosVersion = isIOS
    ? Math.max(iosMatch ? Number(iosMatch[1]) : 0, safariVer ? Number(safariVer[1]) : 0)
    : null;
  const isStandalone =
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true;
  const isCapacitor = !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
  // In-app browsers (Instagram, Facebook, Gmail...) can't install and often block mic/camera.
  const isInAppBrowser = /FBAN|FBAV|Instagram|Line\/|GSA\/|Snapchat|TikTok/i.test(ua);
  const isIOSNonSafari = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const isMobile = isIOS || isAndroid || /Mobi/i.test(ua);
  return { isIOS, isAndroid, isMobile, iosVersion, isStandalone, isCapacitor, isInAppBrowser, isIOSNonSafari };
}

let cachedProbe = null;

/**
 * Full probe. Cheap (no model download); requests a WebGPU adapter but not a device.
 * @returns {Promise<DeviceProbe>}
 */
export async function probeDevice({ force = false } = {}) {
  if (cachedProbe && !force) return cachedProbe;
  const p = platformInfo();
  const gpu = { available: false, f16: false, maxStorageBufferBindingSize: 0, maxBufferSize: 0, vendor: '', architecture: '' };
  if ('gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        gpu.available = true;
        gpu.f16 = adapter.features.has('shader-f16');
        gpu.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize || 0;
        gpu.maxBufferSize = adapter.limits.maxBufferSize || 0;
        const info = adapter.info || {};
        gpu.vendor = info.vendor || '';
        gpu.architecture = info.architecture || '';
      }
    } catch (_) { /* no adapter */ }
  }
  let storage = { quotaMB: null, usageMB: null, persisted: null };
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      storage.quotaMB = e.quota ? Math.round(e.quota / MB) : null;
      storage.usageMB = e.usage ? Math.round(e.usage / MB) : null;
    }
    if (navigator.storage && navigator.storage.persisted) storage.persisted = await navigator.storage.persisted();
  } catch (_) {}
  const deviceMemoryGB = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null; // Chrome only, capped at 8

  const secure = window.isSecureContext === true;
  const media = {
    camera: secure && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    speechSynthesis: 'speechSynthesis' in window,
  };

  // WebLLM asks for a 1 GB storage-buffer binding and falls back to 128 MB.
  // Under 1 GB only models marked low_resource_required can load (all iPhones today).
  const bigBuffers = gpu.maxStorageBufferBindingSize >= 1024 * MB;
  const canRunLocalModel = gpu.available && gpu.maxStorageBufferBindingSize >= 128 * MB && secure;

  cachedProbe = { ...p, gpu, storage, deviceMemoryGB, secure, media, bigBuffers, canRunLocalModel };
  return cachedProbe;
}

/**
 * Asks the browser not to evict our storage (models, keepsakes, audio).
 * Safari grants this mostly to Home Screen apps; Chrome to installed or engaged sites.
 */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (_) {}
  return false;
}

/** Plain-language summary for the settings screen. */
export function describeProbe(probe) {
  const lines = [];
  if (!probe.secure) lines.push('This page is not on HTTPS, so install, camera and mic are blocked. Open the https:// address instead.');
  if (probe.isInAppBrowser) lines.push('You are inside another app’s browser. Open this link in Safari or Chrome to install it.');
  if (probe.isIOSNonSafari && !probe.isStandalone) lines.push('On iPhone, Safari gives the most reliable install. Chrome works on iOS 16.4+ via Share → Add to Home Screen.');
  if (probe.canRunLocalModel) {
    lines.push(probe.bigBuffers
      ? 'This device can run the larger on-device models.'
      : 'This device can run the compact on-device models.');
  } else if (probe.gpu.available) {
    lines.push('This device has WebGPU but too little GPU buffer room for a model. Use your home computer or the scripted lines.');
  } else {
    lines.push('No WebGPU here, so no on-device model. Your home computer or the scripted lines will be used.');
  }
  return lines;
}
