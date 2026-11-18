// Inline the single-file build's JS and CSS into one HTML body for the hosted preview.
import fs from 'node:fs';
import path from 'node:path';
const dir = 'dist-artifact';
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
let css = '', js = '';
html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/g, (m, f) => { css += fs.readFileSync(path.join(dir, f), 'utf8'); return ''; });
html = html.replace(/<script type="module"[^>]*src="\.\/([^"]+)"[^>]*><\/script>/g, (m, f) => { js += fs.readFileSync(path.join(dir, f), 'utf8'); return ''; });
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<noscript>[\s\S]*?<\/noscript>/, '');
const out = `<title>Holding</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>${css}</style>\n${body}\n<script type="module">${js.replace(/<\/script/g, '<\\/script')}</script>\n`;
fs.writeFileSync(path.join(dir, 'holding-preview.html'), out);
console.log('wrote', path.join(dir, 'holding-preview.html'), Math.round(out.length / 1024), 'KB');
