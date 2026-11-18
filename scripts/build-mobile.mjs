#!/usr/bin/env node
// Run after `vite build`: writes dist/precache.json and stamps dist/sw.js with a build id.
// Usage: node scripts/build-mobile.mjs [distDir]
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const dist = process.argv[2] || 'dist';
const MAX_SHELL_BYTES = 8 * 1024 * 1024; // keep huge assets out of the install step
const AUDIO_RE = /\.(mp3|m4a|ogg|opus|wav|aac)$/i;
const SKIP = new Set(['sw.js', 'precache.json']);

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// The prerecorded-voice index is optional; ship an empty one so clients never see a 404.
import { existsSync, mkdirSync } from 'node:fs';
if (!existsSync(join(dist, 'audio', 'index.json'))) {
  mkdirSync(join(dist, 'audio'), { recursive: true });
  await writeFile(join(dist, 'audio', 'index.json'), '{}');
}
const files = await walk(dist);
const hash = createHash('sha256');
const shell = [];
const audio = [];
for (const f of files.sort()) {
  const rel = relative(dist, f).split(sep).join('/');
  if (SKIP.has(rel) || rel.endsWith('.map') || rel.startsWith('.')) continue;
  const s = await stat(f);
  hash.update(rel + ':' + s.size + ':' + (await readFile(f)).subarray(0, 4096).toString('base64'));
  if (AUDIO_RE.test(rel)) audio.push('./' + rel);
  else if (s.size <= MAX_SHELL_BYTES) shell.push('./' + rel);
}
const buildId = hash.digest('hex').slice(0, 12);
await writeFile(join(dist, 'precache.json'), JSON.stringify({ buildId, shell, audio }, null, 0));
const swPath = join(dist, 'sw.js');
const sw = await readFile(swPath, 'utf8');
await writeFile(swPath, sw.replaceAll('__BUILD_ID__', buildId));
// iOS reads these tags when the user taps Add to Home Screen, so put them in the static HTML too.
const HEAD_TAGS = [
  ['rel="manifest"', '<link rel="manifest" href="manifest.webmanifest">'],
  ['rel="apple-touch-icon"', '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">'],
  ['name="theme-color"', '<meta name="theme-color" content="#f6efe6">'],
  ['name="apple-mobile-web-app-capable"', '<meta name="apple-mobile-web-app-capable" content="yes">'],
  ['name="mobile-web-app-capable"', '<meta name="mobile-web-app-capable" content="yes">'],
  ['name="apple-mobile-web-app-status-bar-style"', '<meta name="apple-mobile-web-app-status-bar-style" content="default">'],
  ['name="apple-mobile-web-app-title"', '<meta name="apple-mobile-web-app-title" content="Holding">'],
  ['rel="icon"', '<link rel="icon" type="image/png" href="icons/favicon-32.png">'],
];
for (const page of files.filter((f) => f.endsWith('.html'))) {
  let html = await readFile(page, 'utf8');
  const missing = HEAD_TAGS.filter(([needle]) => !html.includes(needle)).map(([, tag]) => tag);
  html = html.replace(/<meta name="viewport" content="([^"]*)"/, (m, c) => (c.includes('viewport-fit') ? m : `<meta name="viewport" content="${c}, viewport-fit=cover"`));
  if (missing.length) html = html.replace('</head>', '  ' + missing.join('\n  ') + '\n</head>');
  await writeFile(page, html);
}
console.log(`[build-mobile] ${shell.length} shell files, ${audio.length} audio files, build ${buildId}`);
