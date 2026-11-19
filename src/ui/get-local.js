// "Get Holding Local": offers the Mac app (or the folder for Windows and Linux) when
// Holding Local isn't running on this computer, right where the app asks to connect.
// The .dmg is rebuilt on every push to main and attached to the "latest" release, so
// this link always gets the newest build (see .github/workflows/mac-app.yml).
import { h } from './dom.js';

const REPO = 'https://github.com/claudiasellers/holding';
export const MAC_DMG_URL = `${REPO}/releases/latest/download/Holding-Local-mac.dmg`;
export const FOLDER_ZIP_URL = `${REPO}/archive/refs/heads/main.zip`;
export const LOCAL_README_URL = `${REPO}/tree/main/local#readme`;

export function platform() {
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac; touch gives it away.
  if (/iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'phone';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux|X11|CrOS/.test(ua)) return 'linux';
  return 'other';
}

/** Is Holding Local answering on this computer? (Safari blocks this from https pages, so "no" can mean "can't tell".) */
export async function localRunning(base = 'http://127.0.0.1:8787') {
  if (typeof location !== 'undefined' && location.port === '8787') return true;
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

/**
 * The download block. Renders nothing when Holding Local is already running here.
 * @param {{ always?: boolean }} opts  always: show it even if Holding Local answers (e.g. after a failed connect)
 */
export function getLocalPanel({ always = false } = {}) {
  const box = h('div', { class: 'get-local', hidden: true });
  const p = platform();
  const draw = () => {
    box.hidden = false;
    if (p === 'mac') {
      box.append(
        h('b', {}, 'Don\'t have Holding Local yet?'),
        h('p', { class: 'muted' }, 'It\'s a free Mac app that runs the parent\'s AI, voice and listening on your computer, privately. Open it, press Set up, and it does the rest. The first setup downloads about 8 to 11 GB.'),
        h('div', { class: 'row wrap' },
          h('a', { class: 'btn primary', href: MAC_DMG_URL, download: '' }, 'Download Holding Local for Mac')),
        h('p', { class: 'muted small' }, 'Then drag it to Applications and open it. A heart appears in the menu bar. Already installed? Open Holding Local from Applications, then connect here.'),
        // Until the app is notarized with an Apple Developer ID, macOS stops the first open.
        h('p', { class: 'muted small' }, 'If your Mac says it can\'t check the app, open System Settings → Privacy & Security, scroll down and choose Open Anyway.'));
    } else if (p === 'windows' || p === 'linux') {
      box.append(
        h('b', {}, 'Don\'t have Holding Local yet?'),
        h('p', { class: 'muted' }, p === 'windows'
          ? 'Download the folder, unzip it, open "local" and double-click "Install Holding Local.bat". It sets everything up and opens the app. The first setup downloads about 8 to 11 GB. A one-click Windows app is coming.'
          : 'Download the folder, unzip it, and run ./install.sh in its "local" folder. The first setup downloads about 8 to 11 GB.'),
        h('div', { class: 'row wrap' },
          h('a', { class: 'btn primary', href: FOLDER_ZIP_URL }, 'Download Holding Local'),
          h('a', { class: 'btn ghost', href: LOCAL_README_URL, target: '_blank', rel: 'noopener' }, 'Instructions')));
    } else if (p === 'phone') {
      box.append(
        h('b', {}, 'Holding Local runs on a computer'),
        h('p', { class: 'muted' }, 'Install it on your Mac (open this page there and tap Download), then use "Pair a phone" in its menu and scan the code with this phone.'),
        h('p', { class: 'muted small' }, h('a', { href: MAC_DMG_URL }, 'Mac download link'), ' · ', h('a', { href: LOCAL_README_URL, target: '_blank', rel: 'noopener' }, 'Windows and Linux')));
    } else {
      box.append(h('p', { class: 'muted' }, 'Get Holding Local: ', h('a', { href: LOCAL_README_URL, target: '_blank', rel: 'noopener' }, 'instructions')));
    }
  };
  if (always || p === 'phone') draw();
  else localRunning().then((up) => { if (!up) draw(); });
  return box;
}
