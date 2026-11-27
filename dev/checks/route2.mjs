import pw from 'playwright'; const { chromium, devices } = pw;
const S = process.argv[2];
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${S}/mic.wav`] });
// desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForTimeout(1000);
  const fs = page.locator('fieldset:has-text("Mic clean-up")');
  console.log('idle: fieldset count', await fs.count(), 'disabled', await fs.isDisabled());
  await page.getByRole('button', { name: /Start voice/ }).click();
  await page.waitForTimeout(1500);
  console.log('live: disabled', await fs.isDisabled(), '| note:', await fs.locator('p').last().innerText());
  await page.screenshot({ path: `${S}/route-desktop.png` });
  await ctx.close();
}
// phone, Simple density
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Simple', exact: true }).click();
  await page.waitForTimeout(300);
  const y = async (text) => Math.round((await page.getByText(text, { exact: true }).first().boundingBox())?.y ?? -1);
  console.log('phone/simple y-positions → Start:', Math.round((await page.getByRole('button', { name: /Start voice/ }).boundingBox()).y), 'Quick voices:', await y('Quick voices'), 'Hear myself:', await y('Hear myself'), 'viewport h:', page.viewportSize().height);
  await page.getByRole('button', { name: 'Robot', exact: true }).first().click();
  await page.waitForTimeout(200);
  console.log('quick Robot pressed:', await page.getByRole('button', { name: 'Robot', exact: true }).first().getAttribute('aria-pressed'));
  await page.screenshot({ path: `${S}/route-phone.png` });
  await ctx.close();
}
await browser.close();
