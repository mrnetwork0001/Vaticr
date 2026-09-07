// Records the app footage with a scripted browser. 1920x1080, one webm per clip.
//
//   landing.webm  usevaticr.xyz - hero, how it works, mint-a-pair, evidence
//   audit.webm    the dashboard's settlement audit and calibration, no wallet needed
//
// The wallet flow is recorded by hand instead: it needs a real signer and a
// real approval prompt, and a scripted browser cannot produce either.
//
// Every scroll and click is logged with its time so the composition can place
// sounds where they actually happened rather than where it guesses.
const { chromium } = require('/Users/mrnetwork/.npm/_npx/db89d7302a373f10/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const OUT = path.resolve(__dirname, '..', 'public', 'footage');
const SITE = process.env.VATICR_SITE || 'https://usevaticr.xyz';
const VP = { width: 1920, height: 1080 };

async function clip(name, fn) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: VP, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: VP } });
  const p = await ctx.newPage();
  const t0 = Date.now(); const events = [];
  const mark = (kind, note = '') => events.push({ t: (Date.now() - t0) / 1000, kind, note });
  const wait = (ms) => p.waitForTimeout(ms);
  // Eased scroll: a linear one reads as a machine, and the eye follows an ease.
  const smoothScroll = async (to, ms) => {
    const from = await p.evaluate(() => window.scrollY);
    const steps = Math.max(8, Math.round(ms / 40));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k;
      await p.evaluate((y) => window.scrollTo(0, y), from + (to - from) * e);
      await wait(ms / steps);
    }
  };
  await fn({ p, mark, wait, smoothScroll });
  await wait(700);
  const video = p.video(); await ctx.close(); await b.close();
  const tmp = await video.path(); const dst = path.join(OUT, `${name}.webm`);
  fs.renameSync(tmp, dst);
  fs.writeFileSync(path.join(OUT, `${name}.events.json`),
    JSON.stringify({ name, seconds: (Date.now() - t0) / 1000, events }, null, 1));
  console.log(name, 'recorded', ((Date.now() - t0) / 1000).toFixed(1) + 's', events.length, 'events');
}

const ONLY = process.argv[2] || null;
const run = (name, fn) => (!ONLY || ONLY === name) ? clip(name, fn) : Promise.resolve();

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // The landing page, top to bottom, pausing where the argument is made.
  await run('landing', async ({ p, mark, wait, smoothScroll }) => {
    await p.goto(SITE, { waitUntil: 'networkidle' });
    await wait(5200); mark('scroll', 'hero');          // the claim beat lives here
    await smoothScroll(950, 1700); await wait(3000); mark('scroll', 'how');
    await smoothScroll(2100, 1700); await wait(3000); mark('scroll', 'mint');
    await smoothScroll(3300, 1700); await wait(2800); mark('scroll', 'evidence');
    await smoothScroll(4400, 1600); await wait(2600);
  });

  // The dashboard's read-only half: live windows, then the audit. No wallet.
  await run('audit', async ({ p, mark, wait, smoothScroll }) => {
    await p.goto(`${SITE}/dashboard`, { waitUntil: 'networkidle' });
    await wait(3500);                                   // let the windows populate
    mark('scroll', 'markets');
    await smoothScroll(500, 1200); await wait(2200);

    // Audit is the one nobody else will have: every settlement recomputed.
    const audit = p.locator('#app-rail button', { hasText: 'Audit' });
    if (await audit.count()) { await audit.first().click(); mark('click', 'audit'); }
    else {
      const tab = p.locator('button', { hasText: 'Audit' });
      if (await tab.count()) { await tab.first().click(); mark('click', 'audit'); }
    }
    await wait(3500); mark('result', 'audit');
    await smoothScroll(600, 1200); await wait(2400);

    const cal = p.locator('#app-rail button', { hasText: 'Calibration' });
    if (await cal.count()) { await cal.first().click(); mark('click', 'calibration'); }
    await wait(3200); mark('result', 'calibration');
    await smoothScroll(400, 1000); await wait(2000);
  });
})();
