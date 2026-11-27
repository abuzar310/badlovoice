import pw from 'playwright'; const { chromium, devices } = pw;
const S = process.argv[2]; const tag = process.argv[3] || 'x';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${S}/mic.wav`] });
const errors = [];
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((t) => { try { localStorage.setItem('badlovoice_theme', t); } catch {} }, theme);
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /Start voice/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Robot', exact: true }).first().click();
  await page.getByRole('button', { name: /Advanced effects/ }).click().catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${S}/studio-${theme}-${tag}.png`, fullPage: true });
  // settings dialog backdrop
  await page.getByRole('button', { name: /settings/i }).first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${S}/settings-${theme}-${tag}.png` });
  await ctx.close();
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
