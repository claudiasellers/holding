// Mobile end-to-end pass: run `npm run build` first, then `node test/mobile/e2e.mjs`.
// Emulates iPhone 15, iPhone SE and Pixel 7: install sheet, offline launch, Hold-me shortcut,
// pairing links, settings, no clipped elements, no page errors. Needs Playwright (preinstalled in CI images, or npx playwright install chromium).
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { chromium, devices } = require('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
function serve(dir, port) {
  const root = path.resolve(dir);
  const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.mp3':'audio/mpeg', '.svg':'image/svg+xml' };
  return http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/holding/, '');
    if (p.endsWith('/') || p === '') p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }).listen(port);
}

const srv = serve(process.argv[2] || new URL('../../dist', import.meta.url).pathname, 4801);
const base = 'http://localhost:4801/holding/';
const browser = await chromium.launch();
const out = []; const ok = (n, c, x = '') => out.push(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
for (const [label, dev] of [['iphone15', devices['iPhone 15']], ['iphoneSE', devices['iPhone SE']], ['pixel7', devices['Pixel 7']]]) {
  const ctx = await browser.newContext({ ...dev });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('response', r => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); }); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text()) && !/adapters|ERR_INTERNET|net::/.test(m.text())) errs.push(m.text()); });
  await page.goto(base); await page.waitForTimeout(1500);
  ok(`${label} first launch screen`, await page.evaluate(() => document.body.dataset.screen), await page.evaluate(() => document.body.dataset.screen));
  ok(`${label} no h-overflow (builder)`, (await overflow(page)) <= 0, String(await overflow(page)));
  await page.screenshot({ path: `test/mobile/out/${label}-builder.png` });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForTimeout(1500);
  const cached = await page.evaluate(async () => { const o = {}; for (const k of await caches.keys()) o[k] = (await (await caches.open(k)).keys()).length; return o; });
  ok(`${label} SW precache`, Object.entries(cached).some(([k, v]) => k.startsWith('holding-shell') && v > 20), JSON.stringify(cached));
  // Hold-me shortcut
  await page.goto(base + '?mode=hold&source=shortcut'); await page.waitForTimeout(1500);
  const sess = await page.evaluate(() => [document.body.dataset.screen, document.body.getAttribute('data-session-active')]);
  ok(`${label} shortcut opens hold session`, sess[0] === 'session' && sess[1] === 'true', JSON.stringify(sess));
  ok(`${label} no h-overflow (session)`, (await overflow(page)) <= 0, String(await overflow(page)));
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.session button, .session .caption')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1) && !el.closest('.tiles'); }).map((el) => el.textContent.trim().slice(0, 20)));
  ok(`${label} nothing clipped in session (incl. Not safe)`, clipped.length === 0, JSON.stringify(clipped));
  await page.mouse.click(dev.viewport.width / 2, dev.viewport.height / 2);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `test/mobile/out/${label}-session.png` });
  // home
  await page.goto(base); await page.waitForTimeout(1200);
  ok(`${label} home after archetype`, await page.evaluate(() => document.body.dataset.screen) === 'home');
  ok(`${label} no h-overflow (home)`, (await overflow(page)) <= 0, String(await overflow(page)));
  await page.screenshot({ path: `test/mobile/out/${label}-home.png` });
  // offline launch
  await ctx.setOffline(true);
  await page.reload(); await page.waitForTimeout(1500);
  ok(`${label} offline launch shows home`, await page.evaluate(() => document.body.dataset.screen) === 'home');
  await page.goto(base + '?mode=hold'); await page.waitForTimeout(1500);
  ok(`${label} offline Hold me works`, await page.evaluate(() => document.body.dataset.screen) === 'session');
  await ctx.setOffline(false);
  // pairing link (fresh document)
  await page.goto('about:blank');
  await page.goto(base + '#pair=K7QM-2XPA&server=https://mac-mini.tail1.ts.net'); await page.waitForTimeout(1500);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('holding.settings.v1') || '{}'));
  ok(`${label} pairing link saved`, st?.ai?.['openai-local']?.apiKey === 'K7QM-2XPA', JSON.stringify(st?.ai || null));
  // settings
  await page.evaluate(() => window.Holding.nav('settings')); await page.waitForTimeout(800);
  const setTxt = await page.textContent('body');
  ok(`${label} settings has pairing + install`, /Your home computer/.test(setTxt) && /home screen/.test(setTxt));
  ok(`${label} no h-overflow (settings)`, (await overflow(page)) <= 0, String(await overflow(page)));
  await page.screenshot({ path: `test/mobile/out/${label}-settings.png`, fullPage: true });
  await page.getByText('Put Holding on my home screen').click(); await page.waitForTimeout(600);
  await page.screenshot({ path: `test/mobile/out/${label}-install.png` });
  ok(`${label} no page errors`, errs.length === 0, errs.slice(0, 5).join(' | '));
  await ctx.close();
}
await browser.close(); srv.close();
console.log(out.join('\n'));
process.exitCode = out.some((l) => l.startsWith('FAIL')) ? 1 : 0;
