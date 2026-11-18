#!/usr/bin/env node
/**
 * Pre-render every scripted line to audio, once, on a computer, with Kokoro-82M (Apache-2.0).
 * Phones then play the parent's opening lines instantly and offline, in the exact same voice,
 * with no model download and nothing sent anywhere.
 *
 * Usage:
 *   npm i -D kokoro-js
 *   node scripts/prerender-voice.mjs [--lines src/content/scripted-lines.json] [--out public/audio] [--force]
 *
 * Input (JSON, or a JS module whose default export is the same shape):
 *   [
 *     { "archetype": "steady-father", "voice": "am_michael", "speed": 0.9,
 *       "lines": [ { "id": "open-1", "text": "I'm here. You don't have to say anything.", "speed": 0.85 } ] }
 *   ]
 * Lines containing {placeholders} are skipped (they need the live voice).
 *
 * Output:
 *   public/audio/<archetype>/<id>.mp3   (or .m4a / .wav, depending on encoders available)
 *   public/audio/index.json            { "<archetype>": { "<id>": { "src", "hash", "voice", "seconds" } } }
 * Only changed lines are re-rendered (hash of text + voice + speed).
 */
import { readFile, writeFile, mkdir, rm, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const linesPath = resolve(opt('lines', 'src/content/scripted-lines.json'));
const outDir = resolve(opt('out', 'public/audio'));
const force = args.includes('--force');
const MODEL = opt('model', 'onnx-community/Kokoro-82M-v1.0-ONNX');
const DTYPE = opt('dtype', 'fp32'); // best quality; this runs once, offline

function has(cmd, probeArgs = ['-version']) {
  try { execFileSync(cmd, probeArgs, { stdio: 'ignore' }); return true; } catch (_) { return false; }
}
const encoder = has('ffmpeg') ? 'ffmpeg' : (process.platform === 'darwin' && has('afconvert', ['-h']) ? 'afconvert' : 'wav');
const EXT = encoder === 'ffmpeg' ? '.mp3' : encoder === 'afconvert' ? '.m4a' : '.wav';

async function loadLines(p) {
  if (!existsSync(p)) {
    console.error(`No scripted lines at ${p}. Pass --lines <file>.`);
    process.exit(1);
  }
  if (extname(p) === '.json') return JSON.parse(await readFile(p, 'utf8'));
  const mod = await import(pathToFileURL(p).href);
  return mod.default || mod.SCRIPTED_LINES || mod.lines;
}

function hashOf(...parts) { return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16); }

async function encode(wavPath, outPath) {
  if (encoder === 'ffmpeg') {
    // Mono 64 kbps MP3 with a 120 ms fade-in so nothing clicks; plays everywhere, including iOS.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-af', 'afade=t=in:d=0.12,apad=pad_dur=0.25', '-ac', '1', '-ar', '24000', '-b:a', '64k', outPath]);
  } else if (encoder === 'afconvert') {
    execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', '-c', '1', wavPath, outPath]);
  } else {
    await copyFile(wavPath, outPath);
  }
}

const groups = await loadLines(linesPath);
if (!Array.isArray(groups)) { console.error('Expected an array of { archetype, voice, lines: [...] }'); process.exit(1); }

const indexPath = join(outDir, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, 'utf8')) : {};

let KokoroTTS;
try {
  // Resolve from the project you run it in (cwd), not from where this script file lives.
  const { createRequire } = await import('node:module');
  const resolved = createRequire(join(process.cwd(), 'noop.js')).resolve('kokoro-js');
  ({ KokoroTTS } = await import(pathToFileURL(resolved).href));
} catch (_) {
  console.error('kokoro-js is not installed. Run: npm i -D kokoro-js');
  process.exit(1);
}
console.log(`[voice] loading ${MODEL} (${DTYPE}) on CPU; encoder: ${encoder}`);
const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: DTYPE, device: 'cpu' });

let made = 0, kept = 0, skipped = 0;
for (const g of groups) {
  const voice = g.voice || 'af_heart';
  const dir = join(outDir, g.archetype);
  await mkdir(dir, { recursive: true });
  index[g.archetype] = index[g.archetype] || {};
  for (const line of g.lines || []) {
    if (!line.text || /\{[^}]+\}/.test(line.text)) { skipped++; continue; }
    const speed = line.speed ?? g.speed ?? 1;
    const h = hashOf(line.text, voice, String(speed), MODEL, DTYPE, EXT); // EXT: a new encoder re-renders
    const out = join(dir, `${line.id}${EXT}`);
    const rel = `audio/${g.archetype}/${line.id}${EXT}`; // path relative to the web root
    const prev = index[g.archetype][line.id];
    if (!force && prev && prev.hash === h && existsSync(out)) { kept++; continue; }
    const audio = await tts.generate(line.text, { voice: line.voice || voice, speed });
    const tmp = join(tmpdir(), `holding-${process.pid}-${h}.wav`);
    await audio.save(tmp);
    await encode(tmp, out);
    await rm(tmp, { force: true });
    // Drop the same line in another format (e.g. a .wav left over from a run without ffmpeg).
    if (prev && prev.src && prev.src !== rel) await rm(join(outDir, '..', prev.src), { force: true });
    const seconds = audio.audio && audio.sampling_rate ? +(audio.audio.length / audio.sampling_rate).toFixed(2) : null;
    index[g.archetype][line.id] = { src: rel, text: line.text, hash: h, voice: line.voice || voice, speed, seconds, bytes: (await stat(out)).size };
    made++;
    process.stdout.write(`\r[voice] ${made} rendered, ${kept} unchanged`);
  }
}
await writeFile(indexPath, JSON.stringify(index, null, 2));
console.log(`\n[voice] done: ${made} rendered, ${kept} unchanged, ${skipped} skipped (placeholders). Index: ${indexPath}`);
