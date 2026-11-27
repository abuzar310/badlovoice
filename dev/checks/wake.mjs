import pw from 'playwright'; const { chromium } = pw;
const S = process.argv[2];
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${S}/mic.wav`] });
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  window.__locks = { req: 0, rel: 0 };
  Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => { window.__locks.req++; return { release: async () => { window.__locks.rel++; } }; } } });
});
await page.goto('http://127.0.0.1:5173/');
await page.waitForTimeout(800);
await page.getByRole('button', { name: /Start voice/ }).click();
await page.waitForTimeout(1200);
console.log('after start', JSON.stringify(await page.evaluate(() => window.__locks)));
await page.locator('button:has-text("Stop")').last().click();
await page.waitForTimeout(400);
console.log('after stop', JSON.stringify(await page.evaluate(() => window.__locks)), 'errors:', errors.length ? errors : 'none');
await browser.close();
