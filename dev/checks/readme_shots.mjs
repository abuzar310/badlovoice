// Regenerates the README screenshots from the running dev server.
import pw from 'playwright'; const { chromium, devices } = pw;
const S = process.argv[2]; const out = process.argv[3]; const port = process.argv[4] || '5173';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${S}/mic.wav`] });
const errors = [];
async function shoot(ctxOptions, file, setup) {
  const ctx = await browser.newContext({ ...ctxOptions, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('badlovoice_hear_myself', '1'); localStorage.setItem('badlovoice_host_pitch', JSON.stringify({ hz: 126 })); } catch {} });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForTimeout(900);
  await setup(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${file}` });
  await ctx.close();
}
await shoot({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }, 'studio-desktop.png', async (page) => {
  await page.locator('div.panel:has-text("Quick voices") button', { hasText: /^Female$/ }).click();
  await page.getByRole('button', { name: /Start voice/ }).click();
});
await shoot({ ...devices['Pixel 7'] }, 'studio-phone.png', async (page) => {
  await page.locator('div.panel:has-text("Quick voices") button', { hasText: /^Robot$/ }).click();
});
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
