import pw from 'playwright'; const { chromium } = pw;
import { measureF0, rms } from '../../frontend/tests/helpers.mjs';
const S = process.argv[2];
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${S}/mic.wav`, '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|Failed to load resource|ws:\/\//.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto('http://127.0.0.1:5173/');
await page.waitForTimeout(800);

async function take(label, setup) {
  if (setup) await setup();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /^(Start \+ )?Record$/ }).first().click();
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: /Stop/ }).filter({ hasNotText: '●' }).first().click().catch(async () => {
    await page.locator('button:has-text("Stop")').last().click();
  });
  await page.waitForTimeout(400);
  const data = await page.evaluate(async () => {
    const a = document.querySelector('audio');
    if (!a) return null;
    const buf = await (await fetch(a.src)).arrayBuffer();
    const dv = new DataView(buf);
    const sr = dv.getUint32(24, true);
    const n = (buf.byteLength - 44) / 2;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(44 + i * 2, true) / 32768;
    return { sr, samples: out };
  });
  if (!data) { console.log(label, 'NO RECORDING'); return; }
  const x = Float32Array.from(data.samples);
  const f0 = measureF0(x, data.sr, Math.round(data.sr * 0.5), x.length - 2000, 45, 900);
  console.log(label.padEnd(14), 'sr', data.sr, 'len', (x.length / data.sr).toFixed(2) + 's', 'rms', rms(x).toFixed(3), 'f0', f0.toFixed(1));
}

await page.getByRole('button', { name: /Start voice/ }).click();
await page.waitForTimeout(3500);
const status = await page.evaluate(() => document.body.innerText);
console.log('pitch readout:', (status.match(/Your pitch\s*\n?\s*(\S+ Hz|—)/) || [])[1], '| host:', (status.match(/(\d+ Hz)\s*(measured|assumed[^\n]*)/) || []).slice(1).join(' '), '| latency:', (status.match(/Latency\s*\n?\s*(\d+ ?ms|—)/) || [])[1]);
const meters = await page.evaluate(() => Array.from(document.querySelectorAll('.level-fill')).map((e) => e.style.width));
console.log('meters (hear myself OFF):', meters.join(' '));
await page.screenshot({ path: `${S}/live.png` });

await take('default');
const pick = (name) => async () => { await page.locator('aside button.voice-chip', { hasText: new RegExp('^' + name) }).first().click(); };
const group = (g) => page.getByRole('button', { name: g, exact: true }).click();
await take('Female', pick('Female'));
await take('Deeper', pick('Deeper'));
await group('Fun');
await take('Chipmunk', pick('Chipmunk'));
await take('Robot', pick('Robot'));
await take('Whisper', pick('Whisper'));
await take('Cave', pick('Cave'));
await take('Monster', pick('Monster'));
await page.screenshot({ path: `${S}/live2.png`, fullPage: true });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
