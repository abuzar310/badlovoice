import pw from 'playwright'; const { chromium } = pw;
const S = process.argv[2];
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${S}/mic.wav`] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|Failed to load resource|ws:\/\/|ECONNREFUSED|proxy/.test(m.text())) errors.push('console: ' + m.text()); });
await page.addInitScript(() => {
  window.__gum = [];
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => { window.__gum.push(JSON.parse(JSON.stringify(c))); return orig(c); };
  window.__sink = [];
  const AC = window.AudioContext;
  const origSink = AC.prototype.setSinkId;
  if (origSink) AC.prototype.setSinkId = function (id) { window.__sink.push(id); return origSink.call(this, id); };
});
await page.goto('http://127.0.0.1:5173/');
await page.waitForTimeout(1200);
const hearText = async () => (await page.locator('label:has-text("Hear myself")').innerText()).replace(/\n/g, ' | ');
// 1. start once so device labels exist, then stop
await page.getByRole('button', { name: /Start voice/ }).click();
await page.waitForTimeout(1500);
console.log('1 default, hear off :', await hearText());
await page.locator('button:has-text("Stop")').last().click();
await page.waitForTimeout(400);
// 2. mic clean-up toggles
for (const name of ['Noise suppression', 'Echo cancellation', 'Auto mic level']) await page.getByLabel(name, { exact: false }).first().check();
// 3. choose a specific output
const outs = await page.locator('select').nth(1).locator('option').allTextContents();
console.log('outputs:', outs);
const sel = page.locator('select').nth(1);
const values = await sel.locator('option').evaluateAll((o) => o.map((x) => x.value));
const pick = values.find((v) => v && v !== 'default');
if (pick) await sel.selectOption(pick);
await page.getByRole('button', { name: /Start voice/ }).click();
await page.waitForTimeout(1800);
console.log('2 device, hear off  :', await hearText());
await page.getByLabel('Hear myself', { exact: false }).check();
await page.waitForTimeout(500);
console.log('3 device, hear on   :', await hearText());
console.log('getUserMedia constraints:', JSON.stringify(await page.evaluate(() => window.__gum.map((c) => c.audio))));
console.log('setSinkId calls:', await page.evaluate(() => window.__sink.length), '| fieldset disabled while live:', await page.locator('fieldset').first().isDisabled());
const meters = await page.evaluate(() => Array.from(document.querySelectorAll('.level-fill')).map((e) => e.style.width));
console.log('meters:', meters.join(' '));
await page.screenshot({ path: `${S}/route.png`, fullPage: true });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
