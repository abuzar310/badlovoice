import pw from 'playwright'; const { chromium } = pw;
import { measureF0, rms } from '../../frontend/tests/helpers.mjs';
const S = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5173/');
await page.waitForTimeout(500);
// choose Deeper profile first (uses assumed 120 Hz host), then convert
await page.locator('aside button.voice-chip', { hasText: /^Deeper/ }).first().click();
await page.getByRole('button', { name: 'Converter', exact: true }).click();
await page.setInputFiles('input[type=file]', `${S}/mic.wav`);
const t0 = Date.now();
await page.getByRole('button', { name: 'Convert file', exact: true }).click();
await page.waitForSelector('audio', { timeout: 30000 });
const ms = Date.now() - t0;
const data = await page.evaluate(async () => {
  const buf = await (await fetch(document.querySelector('audio').src)).arrayBuffer();
  const dv = new DataView(buf); const sr = dv.getUint32(24, true); const n = (buf.byteLength - 44) / 2;
  const out = new Array(n); for (let i = 0; i < n; i++) out[i] = dv.getInt16(44 + i * 2, true) / 32768;
  return { sr, samples: out };
});
const x = Float32Array.from(data.samples);
console.log('converted 6s file in', ms, 'ms → sr', data.sr, 'len', (x.length / data.sr).toFixed(2), 'rms', rms(x).toFixed(3), 'f0', measureF0(x, data.sr, data.sr, data.sr * 5, 45, 900).toFixed(1), '(input 125, Deeper targets 90)');
console.log('errors:', errors.length ? errors : 'none');
await page.screenshot({ path: `${S}/conv.png` });
await browser.close();
