// Export per-archetype scripted lines for voice prerendering (mobile layer) and
// the RAG/fine-tune tools. Text is filled exactly as the engine fills it, so
// prerecorded audio matches live lines.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fill } from '../src/engine/fill.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LINES = JSON.parse(fs.readFileSync(path.join(root, 'src/data/lines.json'), 'utf8'));
// archetypes.js imports schema.js only, which is plain ESM: safe in node
const { PRESETS } = await import('../src/data/archetypes.js');

const CATS = ['opening', 'stillHere', 'permission', 'selfTouch', 'safety.ask', 'safety.stay', 'close', 'metaprocess'];
const get = (p) => p.split('.').reduce((o, k) => o?.[k], LINES) || [];
const out = PRESETS.map((a) => {
  const ctx = { endearment: a.lexicon.endearments[0] || '', userName: '' };
  const lines = [];
  const seen = new Set();
  for (const c of CATS) get(c).forEach((l, i) => {
    if (/\{name\}|\{miss\}/.test(l.t)) return;           // user-specific: rendered live
    const text = fill(l.t, ctx);
    if (seen.has(text)) return; seen.add(text);
    lines.push({ id: `${c.replace('.', '-')}-${String(i + 1).padStart(2, '0')}`, text });
  });
  // the engine drops endearments when "Pet names" is off: include those variants too
  if (ctx.endearment) for (const c of CATS) get(c).forEach((l, i) => {
    if (!/\{endearment\}/.test(l.t) || /\{name\}|\{miss\}/.test(l.t)) return;
    const text = fill(l.t, { endearment: '' });
    if (!seen.has(text)) { seen.add(text); lines.push({ id: `${c.replace('.', '-')}-${String(i + 1).padStart(2, '0')}-plain`, text }); }
  });
  return { archetype: a.id, name: a.name, voice: a.voice.kokoro, speed: a.voice.rate, lines };
});
fs.mkdirSync(path.join(root, 'src/content'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/content/scripted-lines.json'), JSON.stringify(out, null, 1));
fs.mkdirSync(path.join(root, 'public/archetypes'), { recursive: true });
for (const a of PRESETS) fs.writeFileSync(path.join(root, 'public/archetypes', `${a.id}.json`), JSON.stringify(a, null, 2));
console.log(`exported ${out.reduce((n, a) => n + a.lines.length, 0)} lines for ${out.length} archetypes; archetype JSON in public/archetypes/`);
