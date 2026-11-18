/* Holding service worker.
 *
 * Goals, in order:
 *  1. The app opens instantly and offline, including the scripted "Hold me"
 *     lines and their prerecorded audio, because the worst moment to wait on a
 *     network is the moment the app exists for.
 *  2. Never double-cache multi-GB model weights: WebLLM and transformers.js keep
 *     their own Cache Storage, so Hugging Face / model hosts pass straight through.
 *  3. Never cache anything private: the home-server API (/v1/...) is never stored.
 *
 * BUILD_ID is replaced by scripts/build-mobile.mjs after `vite build`.
 * precache.json (also written by that script) lists every built file.
 */
const BUILD_ID = '__BUILD_ID__';
const SHELL = `holding-shell-${BUILD_ID}`;
const AUDIO = 'holding-audio-v1'; // survives app updates; audio files are content-addressed by path
const CDN = 'holding-cdn-v1';     // MediaPipe wasm + face model, small fonts, etc.
const KEEP = new Set([SHELL, AUDIO, CDN]);

const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'storage.googleapis.com', // MediaPipe .task models
  'fonts.gstatic.com',
  'fonts.googleapis.com',
];
// Model weight hosts: let the libraries manage these caches themselves.
const PASS_HOSTS = ['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co', 'hf.co', 'raw.githubusercontent.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    let urls = ['./', './index.html', './manifest.webmanifest'];
    try {
      const res = await fetch('./precache.json', { cache: 'no-store' });
      if (res.ok) {
        const list = await res.json();
        urls = Array.from(new Set([...urls, ...list.shell]));
        // Audio is NOT fetched here: all archetypes together are ~15 MB. The app asks for the chosen
        // archetype's lines (CACHE_AUDIO), and any line played once is kept (see audio()).
      }
    } catch (_) { /* dev server or first deploy without manifest: runtime caching only */ }
    await addAllTolerant(cache, urls);
    // First install takes control at once; updates wait (see 'message').
    const existing = await self.registration.active;
    if (!existing) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('holding-') && !KEEP.has(n)).map((n) => caches.delete(n)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'CACHE_AUDIO' && Array.isArray(msg.urls)) {
    event.waitUntil(caches.open(AUDIO).then((c) => addAllTolerant(c, msg.urls)));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Private API on the paired home computer: never cache.
    if (url.pathname.includes('/v1/') || url.pathname.includes('/api/')) return;

    if (req.mode === 'navigate') {
      event.respondWith(navigation(event));
      return;
    }
    if (/\.(mp3|m4a|ogg|opus|wav|aac)$/i.test(url.pathname)) {
      event.respondWith(audio(req));
      return;
    }
    event.respondWith(cacheFirst(req, SHELL));
    return;
  }

  if (PASS_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) return;
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, CDN));
  }
});

// Stale-while-revalidate for the page itself: open instantly from cache,
// refresh in the background so the next launch has the newest shell.
async function navigation(event) {
  const cache = await caches.open(SHELL);
  const cached = (await cache.match(event.request, { ignoreSearch: true })) ||
                 (await cache.match('./index.html')) || (await cache.match('./'));
  const network = (async () => {
    try {
      const preload = await event.preloadResponse;
      const res = preload || (await fetch(event.request));
      if (res && res.ok) await cache.put('./index.html', res.clone());
      return res;
    } catch (_) { return null; }
  })();
  if (cached) { event.waitUntil(network); return cached; }
  return (await network) || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const fallback = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (fallback) return fallback;
    throw err;
  }
}

// iOS Safari plays <audio> with Range requests and refuses a 200 reply to one.
// Serve 206 slices from the cached full file.
async function audio(req) {
  const cache = await caches.open(AUDIO);
  const key = new URL(req.url); key.search = '';
  let full = await cache.match(key.href);
  if (!full) {
    try {
      const res = await fetch(key.href); // full file, no Range
      if (res.ok) { await cache.put(key.href, res.clone()); full = res; }
      else return res;
    } catch (err) {
      return new Response('', { status: 504 });
    }
  }
  const range = req.headers.get('range');
  if (!range) return full;
  const buf = await full.clone().arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const size = buf.byteLength;
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  end = Math.min(end, size - 1);
  if (start >= size || start > end) {
    return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function addAllTolerant(cache, urls) {
  // cache.addAll fails the whole batch on one 404; add individually, a few at a time.
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        const res = await fetch(u, { cache: 'no-cache' });
        if (res.ok) await cache.put(u, res);
      } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Holding</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6efe6;color:#2d2622;font:18px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px">
<div><div style="width:120px;height:120px;margin:0 auto 24px;border-radius:50%;background:radial-gradient(circle,#fff4e8 0,#f6ba96 35%,rgba(214,140,120,.0) 70%);animation:b 6s ease-in-out infinite"></div>
<p>I'm still here.<br>Breathe with the light for a moment.</p><p style="opacity:.7;font-size:15px">The app will open fully once it's been loaded online one time.</p></div>
<style>@keyframes b{0%,100%{transform:scale(.85);opacity:.8}50%{transform:scale(1.1);opacity:1}}</style></body>`;
