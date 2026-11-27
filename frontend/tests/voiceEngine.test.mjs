// Run with: npm test   (node --test tests/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceEngine, POST_CHAIN_ORDER } from '../public/voiceEngineCore.js';
import { vowel, noise, rms, measureF0, envelopePeak, run } from './helpers.mjs';

const SR = 48000;
const semis = (a, b) => 12 * Math.log2(a / b);

function engine(params, sr = SR) {
  const e = new VoiceEngine(sr);
  e.setParams({ pitch: 0, formant: 0, effects: {}, ...params });
  return e;
}

function allFinite(x) {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

function peak(x, from = 0, to = x.length) {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

test('no shift and no effects is a bit-exact passthrough', () => {
  const x = vowel(SR, 0.5, 140);
  const y = run(engine({}), x);
  for (let i = 0; i < 48000 * 0.4; i++) assert.equal(y[i], x[i]);
});

test('pitch shift lands within 0.15 semitones across voices, rates and shifts', () => {
  for (const sr of [40000, 44100, 48000]) {
    for (const f0 of [90, 125, 180, 240]) {
      const x = vowel(sr, 1.2, f0);
      for (const pitch of [-12, -7, -3, 4, 7, 12]) {
        const want = f0 * 2 ** (pitch / 12);
        if (want < 55) continue;
        const y = run(engine({ pitch }, sr), x);
        const got = measureF0(y, sr, sr * 0.4, sr * 1.1, 45, 1000);
        assert.ok(
          Math.abs(semis(got, want)) < 0.15,
          `sr ${sr} f0 ${f0} shift ${pitch}: got ${got.toFixed(1)} Hz, want ${want.toFixed(1)}`
        );
      }
    }
  }
});

test('pitch tracker follows a gliding, noisy voice', () => {
  const x = vowel(SR, 2, (t) => 110 + 50 * t);
  const n = noise(x.length, 0.01);
  for (let i = 0; i < x.length; i++) x[i] += n[i];
  const y = run(engine({ pitch: 7 }), x);
  for (const t of [0.5, 1.0, 1.5]) {
    const a = Math.round(SR * (t - 0.1)), b = Math.round(SR * (t + 0.15));
    const src = measureF0(x, SR, a, b);
    const got = measureF0(y, SR, a + 1056, b + 1056, 60, 900);
    assert.ok(Math.abs(semis(got, src) - 7) < 0.4, `t=${t}: ${src.toFixed(1)} → ${got.toFixed(1)}`);
  }
});

test('engine reports the speaking pitch and reports 0 for silence / noise', () => {
  const e = engine({});
  run(e, vowel(SR, 0.6, 172));
  assert.ok(Math.abs(e.pitchHz - 172) < 2, `tracked ${e.pitchHz}`);
  run(e, new Float32Array(SR * 0.3));
  assert.equal(e.pitchHz, 0);
  run(e, noise(SR * 0.4, 0.2));
  assert.equal(e.pitchHz, 0);
});

test('formant shift moves resonances without touching pitch', () => {
  // A single high resonator gives a clean envelope peak to measure.
  const f0 = 100;
  const x = vowel(SR, 1.5, f0, [[2400, 80]]);
  const a = SR * 0.5, b = a + 16384;
  const base = envelopePeak(x, SR, a, b, 1500, 3500);
  for (const formant of [-5, -3, 3, 5]) {
    const y = run(engine({ formant }), x);
    const got = envelopePeak(y, SR, a, b, 1100, 4800);
    const moved = semis(got, base);
    assert.ok(Math.abs(moved - formant) < 1, `formant ${formant}: moved ${moved.toFixed(2)} st`);
    const p = measureF0(y, SR, a, SR * 1.4);
    assert.ok(Math.abs(semis(p, f0)) < 0.1, `pitch drifted to ${p}`);
  }
});

test('pitch shift alone keeps formants (no chipmunk)', () => {
  const x = vowel(SR, 1.5, 100, [[2400, 80]]);
  const a = SR * 0.5, b = a + 16384;
  const base = envelopePeak(x, SR, a, b, 1500, 3500);
  for (const pitch of [-7, 7, 12]) {
    const y = run(engine({ pitch }), x);
    const got = envelopePeak(y, SR, a, b, 1100, 4800);
    assert.ok(Math.abs(semis(got, base)) < 1, `pitch ${pitch}: formant moved ${semis(got, base).toFixed(2)} st`);
  }
});

test('unvoiced noise and silence survive shifting', () => {
  const x = new Float32Array(SR * 1.2);
  x.set(noise(SR * 0.5, 0.2), SR * 0.1);
  const y = run(engine({ pitch: 9, formant: 2 }), x);
  const inR = rms(x, SR * 0.2, SR * 0.5);
  const outR = rms(y, SR * 0.25, SR * 0.55);
  assert.ok(outR / inR > 0.6 && outR / inR < 1.4, `noise gain ${(outR / inR).toFixed(2)}`);
  assert.ok(rms(y, SR * 0.8, SR * 1.1) < 1e-4, 'silence stays silent');
  // Shifted noise must not turn into a buzz: no strong periodicity.
  assert.equal(measureF0(y, SR, SR * 0.25, SR * 0.55), 0);
});

test('loudness stays close to the input for every shift', () => {
  const x = vowel(SR, 1.2, 130);
  for (const [pitch, formant] of [[12, 0], [-12, 0], [7, 4], [-7, -4], [0, 6], [0, -6], [16, 8], [-16, -8]]) {
    const y = run(engine({ pitch, formant }), x);
    const g = rms(y, SR * 0.4, SR * 1.1) / rms(x, SR * 0.4, SR * 1.1);
    assert.ok(g > 0.45 && g < 1.8, `p${pitch} f${formant}: gain ${g.toFixed(2)}`);
    assert.ok(allFinite(y) && peak(y) <= 1);
  }
});

test('switching shift on and off mid-stream does not click', () => {
  const x = vowel(SR, 2, 150);
  const e = engine({});
  const y = new Float32Array(x.length);
  for (let i = 0, k = 0; i + 128 <= x.length; i += 128, k++) {
    if (k % 60 === 0) e.setParams({ pitch: (k / 60) % 2 ? 0 : 5 });
    e.process(x.subarray(i, i + 128), y.subarray(i, i + 128));
  }
  let maxStep = 0, inStep = 0;
  for (let i = 1; i < y.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
    inStep = Math.max(inStep, Math.abs(x[i] - x[i - 1]));
  }
  assert.ok(maxStep < inStep * 2.5, `step ${maxStep.toFixed(3)} vs input ${inStep.toFixed(3)}`);
});

test('monotone flattens pitch to the requested note', () => {
  const x = vowel(SR, 1.5, (t) => 120 + 60 * t);
  const y = run(engine({ effects: { monotone: { enabled: true, freq: 110 } } }), x);
  for (const t of [0.5, 1.2]) {
    const got = measureF0(y, SR, SR * t, SR * (t + 0.25));
    assert.ok(Math.abs(semis(got, 110)) < 0.2, `t=${t}: ${got.toFixed(1)} Hz`);
  }
});

test('vibrato wobbles pitch around the original', () => {
  const x = vowel(SR, 2, 160);
  const y = run(engine({ effects: { vibrato: { enabled: true, rate: 5, depth: 1 } } }), x);
  let lo = Infinity, hi = 0;
  for (let s = SR * 0.5; s < SR * 1.5; s += 480) {
    const f = measureF0(y, SR, s, s + SR * 0.07, 100, 300);
    if (f > 0) { lo = Math.min(lo, f); hi = Math.max(hi, f); }
  }
  assert.ok(semis(hi, lo) > 0.6 && semis(hi, lo) < 2.6, `swing ${semis(hi, lo).toFixed(2)} st`);
});

test('whisper removes the pitched buzz but keeps the speech envelope', () => {
  const x = vowel(SR, 1.2, 130);
  for (let i = SR * 0.6; i < SR * 0.8; i++) x[i] = 0; // a gap, like between words
  const y = run(engine({ effects: { whisper: { enabled: true, mix: 1 } } }), x);
  assert.equal(measureF0(y, SR, SR * 0.2, SR * 0.55), 0);
  const g = rms(y, SR * 0.2, SR * 0.55) / rms(x, SR * 0.2, SR * 0.55);
  assert.ok(g > 0.5 && g < 2, `whisper gain ${g.toFixed(2)}`);
  assert.ok(rms(y, SR * 0.7, SR * 0.78) < rms(y, SR * 0.2, SR * 0.55) * 0.1, 'gap stays quiet');
  // Formant energy (≈700 Hz + 1200 Hz) still dominates over the far highs.
  const mid = envelopePeak(y, SR, SR * 0.2, SR * 0.2 + 16384, 300, 4000);
  assert.ok(mid > 450 && mid < 1500, `envelope peak ${mid}`);
});

test('telephone band-limits', () => {
  const y = run(engine({ effects: { telephone: { enabled: true } } }), noise(SR, 0.2));
  const e = engine({ effects: { telephone: { enabled: true } } });
  const tone = (f) => {
    const x = new Float32Array(SR * 0.5);
    for (let i = 0; i < x.length; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * f * i) / SR);
    return rms(run(e, x), SR * 0.3, SR * 0.45) / 0.0707;
  };
  assert.ok(tone(1000) > 0.9, 'passband');
  assert.ok(tone(100) < 0.05, 'lows cut');
  assert.ok(tone(8000) < 0.05, 'highs cut');
  assert.ok(allFinite(y));
});

test('echo and reverb leave a decaying tail', () => {
  const x = new Float32Array(SR * 2);
  x.set(vowel(SR, 0.3, 140));
  const echo = run(engine({ effects: { echo: { enabled: true, time: 0.25, feedback: 0.4, mix: 0.4 } } }), x);
  assert.ok(rms(echo, SR * 0.32, SR * 0.5) > 0.005, 'first repeat');
  assert.ok(rms(echo, SR * 1.6, SR * 1.9) < rms(echo, SR * 0.32, SR * 0.5) * 0.3, 'decays');
  const verb = run(engine({ effects: { reverb: { enabled: true, size: 0.6, mix: 0.4 } } }), x);
  const tail = rms(verb, SR * 0.35, SR * 0.6);
  assert.ok(tail > 0.002 && tail < 0.2, `reverb tail ${tail.toFixed(4)}`);
  assert.ok(rms(verb, SR * 1.7, SR * 1.95) < tail * 0.5, 'reverb decays');
});

test('reverb and chorus keep level near unity', () => {
  const x = vowel(SR, 1.5, 140);
  const ref = rms(x, SR * 0.5, SR * 1.4);
  for (const fx of [
    { reverb: { enabled: true, size: 0.5, mix: 0.35 } },
    { reverb: { enabled: true, size: 1, mix: 1 } },
    { chorus: { enabled: true, rate: 0.8, depth: 0.5, mix: 0.5 } },
  ]) {
    const g = rms(run(engine({ effects: fx }), x), SR * 0.5, SR * 1.4) / ref;
    assert.ok(g > 0.4 && g < 1.8, `${Object.keys(fx)[0]} gain ${g.toFixed(2)}`);
  }
});

test('compressor narrows dynamic range', () => {
  const x = vowel(SR, 2, 140);
  for (let i = 0; i < SR; i++) x[i] *= 0.1; // quiet first half
  const y = run(engine({ effects: { compressor: { enabled: true, threshold: -30, ratio: 6 } } }), x);
  const inRange = rms(x, SR * 1.2, SR * 1.9) / rms(x, SR * 0.2, SR * 0.9);
  const outRange = rms(y, SR * 1.2, SR * 1.9) / rms(y, SR * 0.2, SR * 0.9);
  assert.ok(outRange < inRange * 0.6, `range ${inRange.toFixed(1)} → ${outRange.toFixed(1)}`);
});

test('bitcrush quantises and gain trims', () => {
  const x = vowel(SR, 0.3, 140);
  const y = run(engine({ effects: { bitcrush: { enabled: true, bits: 4, down: 8 } } }), x);
  const levels = new Set(Array.from(y.subarray(4800, 9600), (v) => Math.round(v * 8)));
  assert.ok(levels.size <= 17);
  const g = run(engine({ effects: { gain: { enabled: true, db: -6 } } }), x);
  assert.ok(Math.abs(rms(g) / rms(x) - 0.501) < 0.01);
});

test('every effect, alone and all together, stays finite and inside ±1', () => {
  const x = vowel(SR, 1, 120);
  for (let i = 0; i < x.length; i++) x[i] *= 2.4; // hot, clipping-level input
  const all = {};
  for (const key of [...POST_CHAIN_ORDER, 'monotone', 'vibrato']) {
    all[key] = { enabled: true };
    const y = run(engine({ pitch: 5, formant: -2, effects: { [key]: { enabled: true } } }), x);
    assert.ok(allFinite(y), `${key} finite`);
    assert.ok(peak(y) <= 1, `${key} peak ${peak(y)}`);
    assert.ok(rms(y, SR * 0.4, SR * 0.9) > 0.01, `${key} not silent`);
  }
  const y = run(engine({ pitch: -9, formant: -5, effects: all }), x);
  assert.ok(allFinite(y) && peak(y) <= 1);
});

test('garbage parameters cannot break the stream', () => {
  const e = engine({});
  e.setParams({ pitch: NaN, formant: Infinity, effects: { echo: { enabled: true, time: 'x', feedback: 99 }, eq: { enabled: true, low: null } } });
  e.setParams(null);
  e.setParams({ effects: null });
  const y = run(e, vowel(SR, 0.4, 150));
  assert.ok(allFinite(y) && peak(y) <= 1);
});

test('disabled engine passes audio through but keeps tracking pitch', () => {
  const x = vowel(SR, 0.6, 200);
  const e = engine({ pitch: 7, enabled: false });
  const y = run(e, x);
  for (let i = 0; i < SR * 0.5; i++) assert.equal(y[i], x[i]);
  assert.ok(Math.abs(e.pitchHz - 200) < 3);
});

test('runs far faster than realtime with the whole rack on', () => {
  const all = {};
  for (const key of POST_CHAIN_ORDER) all[key] = { enabled: true };
  const x = vowel(SR, 4, 110);
  const e = engine({ pitch: 12, formant: 4, effects: all });
  run(e, x.subarray(0, SR)); // warm up the JIT
  const t0 = performance.now();
  run(e, x);
  const speed = 4000 / (performance.now() - t0);
  assert.ok(speed > 8, `only ${speed.toFixed(1)}x realtime`);
});
