// Back / Forward through pages and chats — drives an isolated beast-dash copy in headless Chromium (desktop + phone).
// Not part of `node --test` (the repo has no dependencies): Playwright comes from outside the repo.
//   1. boot an isolated copy (BD_TEST=1, own state, loopback) on a free port — NEVER the live dashboard's port
//   2. PW=/path/to/node_modules/playwright node docs/back-forward/browser-check.js <port> [name filter]
//      NO_NAV_API=1 hides window.navigation (Safari / Firefox without the Navigation API)
// Terminal iframes (ttyd) are stubbed and every POST /api/* is answered locally, so real sessions are never touched.
const { chromium } = require(process.env.PW || 'playwright');
const PORT = process.argv[2], FILTER = process.argv[3] || '';
const BASE = `http://127.0.0.1:${PORT}/`;
let pass = 0, fail = 0;
const results = [];

async function setup(browser, phone) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1440, height: 900 } });
  if (process.env.NO_NAV_API) await ctx.addInitScript(() => { try { Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  // never touch real terminals (ttyd attaches resize real tmux panes) and never write anything
  await ctx.route('**/*', route => {
    const r = route.request(), u = new URL(r.url());
    if (u.port === '7681' || u.pathname.startsWith('/term/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>term stub</body></html>' });
    if (r.method() === 'POST' && u.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    return route.continue();
  });
  await page.goto('about:blank');
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof S !== 'undefined' && S.runtime && S.runtime.sessions && S.runtime.sessions.length > 0, null, { timeout: 15000 });
  await page.evaluate(() => { try { localStorage.setItem('bd.view', 'home'); } catch {} });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

const where = page => page.evaluate(() => location.href.startsWith('about:') ? { left: true } : ({
  view: UI.view, term: TERM.open ? (TERM.showList && IS_PHONE ? 'LIST' : TERM.active) : null,
  drawer: UI.drawer || null, modal: !document.getElementById('modal').classList.contains('hidden'), pal: !!PAL.open,
  depth: LAYERS.depth, hlen: history.length, st: history.state,
}));
const settle = page => page.waitForTimeout(450);
async function back(page) { await page.goBack({ waitUntil: 'commit', timeout: 3000 }).catch(() => {}); await settle(page); }
async function fwd(page) { await page.goForward({ waitUntil: 'commit', timeout: 3000 }).catch(() => {}); await settle(page); }

function check(name, got, want) {
  const ok = Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));
  if (ok) pass++; else fail++;
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}: want ${JSON.stringify(want)} got ${JSON.stringify(Object.fromEntries(Object.entries(got).filter(([k]) => k !== 'st')))}`);
}

const T = {};
// ---------------- desktop ----------------
T['desktop views'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  await page.click('#nav .navb[data-view="projects"]'); await settle(page);
  await page.click('#nav .navb[data-view="tasks"]'); await settle(page);
  check('on tasks', await where(page), { view: 'tasks' });
  await back(page); check('back -> projects', await where(page), { view: 'projects', term: null });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  await fwd(page); check('fwd -> projects', await where(page), { view: 'projects' });
  await fwd(page); check('fwd -> tasks', await where(page), { view: 'tasks' });
  await back(page); await back(page); await back(page); check('back x3 leaves', await where(page), { left: true });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop chats'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  const rows = await page.$$eval('#rail .rrow', els => els.map(e => e.title.split(' ')[0]));
  const [A, B, C] = rows;
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  check('chat A open', await where(page), { term: A });
  await page.click(`#rail .rrow >> nth=1`); await settle(page);
  check('chat B open', await where(page), { term: B });
  await page.click(`#rail .rrow >> nth=2`); await settle(page);
  await back(page); check('back -> B', await where(page), { term: B });
  await back(page); check('back -> A', await where(page), { term: A });
  await back(page); check('back -> home, panel closed', await where(page), { view: 'home', term: null });
  await fwd(page); check('fwd -> A', await where(page), { term: A });
  await fwd(page); check('fwd -> B', await where(page), { term: B });
  await fwd(page); check('fwd -> C', await where(page), { term: C });
  // a page from the nav while a chat is open; Back returns to the chat
  await page.click('#nav .navb[data-view="tasks"]'); await settle(page);
  check('tasks, panel closed', await where(page), { view: 'tasks', term: null });
  await back(page); check('back -> C again', await where(page), { term: C });
  await fwd(page); check('fwd -> tasks', await where(page), { view: 'tasks', term: null });
  // same chat twice adds nothing
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  await back(page); check('same chat twice = one entry', await where(page), { view: 'tasks', term: null });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop close chat'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  await page.click('#nav .navb[data-view="projects"]'); await settle(page);
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  await page.click(`#rail .rrow >> nth=1`); await settle(page);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Escape'); await settle(page);
  check('Esc closes the chats', await where(page), { view: 'projects', term: null });
  await back(page); check('back after close -> home', await where(page), { view: 'home', term: null });
  await fwd(page); check('fwd -> projects', await where(page), { view: 'projects', term: null });
  await fwd(page); check('fwd -> first chat', await where(page), { view: 'projects' });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop overlays'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  await page.click('#nav .navb[data-view="tasks"]'); await settle(page);
  await page.click('#btn-settings'); await settle(page);
  check('settings open', await where(page), { modal: true });
  await back(page); check('back closes settings, stays on tasks', await where(page), { modal: false, view: 'tasks' });
  await fwd(page); check('fwd over a closed dialog: still tasks', await where(page), { modal: false, view: 'tasks' });
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  const A = (await where(page)).term;
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+k'); await settle(page);
  const pal = (await where(page)).pal;
  if (pal) { await back(page); check('back closes palette, chat stays', await where(page), { pal: false, term: A }); }
  await page.evaluate(() => settingsModal()); await settle(page);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Escape'); await settle(page);
  check('Esc closes the dialog, chat stays', await where(page), { modal: false, term: A });
  await back(page); check('back -> tasks', await where(page), { view: 'tasks', term: null });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop drawer'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  await page.click('#nav .navb[data-view="projects"]'); await settle(page);
  const card = await page.$('#view-projects .card .nm, #view-projects .card h3, #view-projects .card');
  if (!card) { results.push('skip drawer: no project card'); await ctx.close(); return; }
  await page.evaluate(() => openDrawer(S.projects[0].id)); await settle(page);
  check('drawer open', await where(page), { view: 'projects' });
  await back(page); check('back closes drawer', await where(page), { drawer: null, view: 'projects' });
  await back(page); check('back -> home', await where(page), { view: 'home' });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
// ---------------- phone ----------------
T['phone tabs'] = async b => {
  const { page, ctx, errors } = await setup(b, true);
  await page.tap('#tabbar .tb[data-view="tasks"]'); await settle(page);
  await page.tap('#tabbar .tb[data-view="code"]'); await settle(page);
  check('on code', await where(page), { view: 'code' });
  await back(page); check('back -> tasks', await where(page), { view: 'tasks' });
  await back(page); check('back -> home', await where(page), { view: 'home' });
  await fwd(page); check('fwd -> tasks', await where(page), { view: 'tasks' });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['phone chats'] = async b => {
  const { page, ctx, errors } = await setup(b, true);
  await page.tap('#tabbar .tb[data-act="sessions"]'); await settle(page);
  check('session list', await where(page), { term: 'LIST' });
  const items = await page.$$('#term-list .titem');
  await items[0].tap(); await settle(page);
  const A = (await where(page)).term;
  check('chat A from the list', await where(page), { term: A });
  await page.tap('#term-bar .msess'); await settle(page);
  check('picker shows the list', await where(page), { term: 'LIST' });
  await (await page.$$('#term-list .titem'))[1].tap(); await settle(page);
  const B = (await where(page)).term;
  await back(page); check('back -> A', await where(page), { term: A });
  await back(page); check('back -> list', await where(page), { term: 'LIST' });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  await fwd(page); check('fwd -> list', await where(page), { term: 'LIST' });
  await fwd(page); check('fwd -> A', await where(page), { term: A });
  await fwd(page); check('fwd -> B', await where(page), { term: B });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['phone code steps'] = async b => {
  const { page, ctx, errors } = await setup(b, true);
  await page.tap('#tabbar .tb[data-view="code"]'); await settle(page);
  const scope = await page.$('#view-code .cvi');
  const step0 = await page.evaluate(() => FEAT.code.state.step);
  results.push(`  code step at start: ${step0}`);
  if (scope) {
    await scope.tap(); await settle(page);
    const s1 = await page.evaluate(() => FEAT.code.state.step);
    results.push(`  after tapping a scope: ${s1}`);
    await back(page); check('back -> scope step, still code', await where(page), { view: 'code' });
    results.push(`  step now: ${await page.evaluate(() => FEAT.code.state.step)}`);
  }
  await back(page); check('back -> home', await where(page), { view: 'home' });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};

T['desktop code from a chat'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  const A = (await where(page)).term;
  await page.evaluate(() => FEAT.code.open({ overview: true })); await settle(page);
  check('code open, panel closed', await where(page), { view: 'code', term: null });
  await back(page); check('back -> the chat', await where(page), { view: 'home', term: A });
  await fwd(page); check('fwd -> code', await where(page), { view: 'code', term: null });
  await back(page); await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop dialog hands its entry to a chat'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  await page.click('#nav .navb[data-view="tasks"]'); await settle(page);
  const names = await page.$$eval('#rail .rrow', els => els.map(e => e.title.split(' ')[0]));
  await page.evaluate(() => settingsModal()); await settle(page);
  const d1 = (await where(page)).depth;
  await page.evaluate(n => { document.getElementById('modal').classList.add('hidden'); openTerm(n); }, names[1]); await settle(page);
  check('chat on the dialog entry', await where(page), { term: names[1], modal: false, depth: d1 });
  await back(page); check('back -> tasks', await where(page), { view: 'tasks', term: null });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop ended chat is passed over'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  const names = await page.$$eval('#rail .rrow', els => els.map(e => e.title.split(' ')[0]));
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  await page.evaluate(() => openTerm('claude-zz-gone-test')); await settle(page);
  await page.click(`#rail .rrow >> nth=1`); await settle(page);
  await back(page); check('back skips the ended chat -> A', await where(page), { term: names[0] });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  await fwd(page); check('fwd -> A', await where(page), { term: names[0] });
  await fwd(page); check('fwd skips the ended chat -> B', await where(page), { term: names[1] });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop open without a gesture after Back'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  const names = await page.$$eval('#rail .rrow', els => els.map(e => e.title.split(' ')[0]));
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  await page.click(`#rail .rrow >> nth=1`); await settle(page);
  await back(page); check('back -> A', await where(page), { term: names[0], depth: 1 });
  const hlen = (await where(page)).hlen;
  await page.evaluate(n => openTerm(n), names[2]); await settle(page);   // a notification: no user gesture
  check('C on the entry Back left (no pushState)', await where(page), { term: names[2], depth: 2, hlen });
  await back(page); check('back -> A', await where(page), { term: names[0] });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop reload keeps the chat and its history'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  const names = await page.$$eval('#rail .rrow', els => els.map(e => e.title.split(' ')[0]));
  await page.click('#nav .navb[data-view="projects"]'); await settle(page);
  await page.click(`#rail .rrow >> nth=0`); await settle(page);
  await page.click(`#rail .rrow >> nth=1`); await settle(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof S !== 'undefined' && S.runtime && S.runtime.sessions.length > 0 && firstDone);
  await page.waitForTimeout(600);
  check('after reload: B again', await where(page), { view: 'projects', term: names[1], depth: 3 });
  await back(page); check('back -> A', await where(page), { term: names[0] });
  await back(page); check('back -> projects', await where(page), { view: 'projects', term: null });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop Esc and nav'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  await page.click('#nav .navb[data-view="tasks"]'); await settle(page);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Escape'); await settle(page);
  check('Esc -> home', await where(page), { view: 'home' });
  await back(page); check('back -> tasks', await where(page), { view: 'tasks' });
  await page.click('#nav .navb[data-view="tasks"]'); await settle(page);
  check('same page again adds nothing', await where(page), { view: 'tasks', depth: 1 });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['phone close chat with the back arrow'] = async b => {
  const { page, ctx, errors } = await setup(b, true);
  await page.tap('#tabbar .tb[data-view="tasks"]'); await settle(page);
  await page.tap('#tabbar .tb[data-act="sessions"]'); await settle(page);
  await (await page.$$('#term-list .titem'))[0].tap(); await settle(page);
  const A = (await where(page)).term;
  await page.tap('#term-bar .msess'); await settle(page);
  await (await page.$$('#term-list .titem'))[1].tap(); await settle(page);
  await page.evaluate(() => closeTermPanel()); await settle(page);   // the bar's back arrow
  check('closed -> tasks, the page before the chats', await where(page), { view: 'tasks', term: null, depth: 1 });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  await fwd(page); await fwd(page); check('fwd fwd -> the list', await where(page), { term: 'LIST' });
  await fwd(page); check('fwd -> A', await where(page), { term: A });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['phone code from a chat'] = async b => {
  const { page, ctx, errors } = await setup(b, true);
  await page.tap('#tabbar .tb[data-act="sessions"]'); await settle(page);
  await (await page.$$('#term-list .titem'))[0].tap(); await settle(page);
  const A = (await where(page)).term;
  await page.evaluate(() => FEAT.code.open({ overview: true })); await settle(page);
  check('code list', await where(page), { view: 'code', term: null });
  results.push(`  step: ${await page.evaluate(() => FEAT.code.state.step + ' layers ' + FEAT.code.state.layers)}`);
  await back(page); check('back -> the chat', await where(page), { term: A });
  await back(page); check('back -> list', await where(page), { term: 'LIST' });
  await back(page); check('back -> home', await where(page), { view: 'home', term: null });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['phone dialog Back'] = async b => {
  const { page, ctx, errors } = await setup(b, true);
  await page.tap('#tabbar .tb[data-view="tasks"]'); await settle(page);
  await page.evaluate(() => settingsModal()); await settle(page);
  await back(page); check('back closes the dialog', await where(page), { view: 'tasks', modal: false });
  await back(page); check('back -> home', await where(page), { view: 'home' });
  await back(page); check('then leaves', await where(page), { left: true });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};

T['desktop palette picks'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  await page.click('#nav .navb[data-view="projects"]'); await settle(page);
  await page.keyboard.press('Control+k'); await settle(page);
  await page.keyboard.type('tasks'); await page.waitForTimeout(150);
  const first = await page.evaluate(() => document.querySelector('#palette .pi.on')?.textContent || '');
  await page.keyboard.press('Enter'); await settle(page);
  check(`palette -> tasks (picked: ${first.slice(0, 30)})`, await where(page), { view: 'tasks', pal: false, depth: 2 });
  await page.keyboard.press('Control+k'); await settle(page);
  await page.evaluate(() => { const it = paletteItems().find(x => x.kind === 'claude'); PAL.__pick = it.label; closePalette(); it.run(); });
  await settle(page);
  const w = await where(page);
  check('palette -> a chat', w, { pal: false, depth: 3 });
  await back(page); check('back -> tasks', await where(page), { view: 'tasks', term: null });
  await back(page); check('back -> projects', await where(page), { view: 'projects', term: null });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['desktop notification while the palette is open'] = async b => {
  const { page, ctx, errors } = await setup(b, false);
  const names = await page.$$eval('#rail .rrow', els => els.map(e => e.title.split(' ')[0]));
  await page.click('#nav .navb[data-view="tasks"]'); await settle(page);
  await page.keyboard.press('Control+k'); await settle(page);
  await page.evaluate(n => openFromUrl('/?term=' + n), names[0]); await settle(page);
  check('chat open, palette gone, on the palette entry', await where(page), { term: names[0], pal: false, depth: 2 });
  await back(page); check('back -> tasks', await where(page), { view: 'tasks', term: null });
  await back(page); check('back -> home', await where(page), { view: 'home' });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};
T['phone tab from a Code step'] = async b => {
  const { page, ctx, errors } = await setup(b, true);
  await page.tap('#tabbar .tb[data-view="code"]'); await settle(page);
  await (await page.$('#view-code .cvi')).tap(); await settle(page);
  check('code list step', await where(page), { view: 'code', depth: 2 });
  await page.tap('#tabbar .tb[data-view="tasks"]'); await settle(page);
  check('tasks: the Code step entry was popped', await where(page), { view: 'tasks', depth: 2 });
  await back(page); check('back -> code', await where(page), { view: 'code' });
  results.push(`  step: ${await page.evaluate(() => FEAT.code.state.step)}`);
  await back(page); check('back -> home', await where(page), { view: 'home' });
  if (errors.length) results.push('  errors: ' + errors.join(' | '));
  await ctx.close();
};

(async () => {
  const browser = await chromium.launch();
  for (const [name, fn] of Object.entries(T)) {
    if (FILTER && !name.includes(FILTER)) continue;
    results.push(`== ${name}`);
    try { await fn(browser); } catch (e) { fail++; results.push('FAIL threw: ' + e.message.split('\n').slice(0, 14).join('\n')); }
  }
  await browser.close();
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
