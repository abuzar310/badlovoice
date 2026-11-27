// Signal generators + measurements shared by the engine tests.
export function vowel(sr, seconds, f0Fn, formants = [[700, 90], [1200, 110], [2600, 160]]) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  // Glottal pulse train (band-limited-ish: decaying impulse) through resonators.
  let phase = 0;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f0 = typeof f0Fn === 'function' ? f0Fn(i / sr) : f0Fn;
    phase += f0 / sr;
    if (phase >= 1) {
      phase -= 1;
      src[i] = 1;
    }
  }
  // glottal shaping: one-pole lowpass twice
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    a += 0.12 * (src[i] - a);
    b += 0.12 * (a - b);
    src[i] = b;
  }
  for (const [fc, bw] of formants) {
    const r = Math.exp((-Math.PI * bw) / sr);
    const c1 = 2 * r * Math.cos((2 * Math.PI * fc) / sr);
    const c2 = -r * r;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = src[i] * (1 - r) + c1 * y1 + c2 * y2;
      y2 = y1; y1 = y;
      out[i] += y;
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] *= 0.4 / peak;
  return out;
}

export function noise(n, amp = 0.1, seed = 1234) {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 2147483648 - 1) * amp;
  }
  return out;
}

export function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Median F0 (Hz) by normalised autocorrelation over frames. */
export function measureF0(x, sr, from, to, lo = 50, hi = 900) {
  const W = Math.round(sr * 0.04);
  const tMin = Math.floor(sr / hi), tMax = Math.ceil(sr / lo);
  const res = [];
  for (let s = from; s + W + tMax < to; s += Math.round(sr * 0.02)) {
    let best = 0, bestTau = 0, maxv = 0;
    const vals = new Float64Array(tMax + 2);
    for (let tau = tMin; tau <= tMax; tau++) {
      let acf = 0, m = 0;
      for (let j = 0; j < W; j++) {
        const p = x[s + j], q = x[s + j + tau];
        acf += p * q; m += p * p + q * q;
      }
      vals[tau] = m > 1e-12 ? (2 * acf) / m : 0;
      if (vals[tau] > maxv) maxv = vals[tau];
    }
    for (let tau = tMin + 1; tau < tMax; tau++) {
      if (vals[tau] >= 0.9 * maxv && vals[tau] > vals[tau - 1] && vals[tau] >= vals[tau + 1]) {
        best = vals[tau]; bestTau = tau; break;
      }
    }
    if (best > 0.5) {
      const a = vals[bestTau - 1], c = vals[bestTau + 1], v = vals[bestTau];
      const d = a - 2 * v + c;
      res.push(sr / (bestTau + (Math.abs(d) > 1e-12 ? (0.5 * (a - c)) / d : 0)));
    }
  }
  res.sort((p, q) => p - q);
  return res.length ? res[res.length >> 1] : 0;
}

/** Frequency (Hz) of the strongest spectral-envelope peak in [lo, hi]. */
export function envelopePeak(x, sr, from, to, lo, hi) {
  let best = -Infinity, bestF = 0;
  const n = to - from;
  // Smoothed periodogram: average power in a ±80 Hz band (wider than harmonic spacing/2 for our tests).
  const power = (f) => {
    let re = 0, im = 0;
    const w = (2 * Math.PI * f) / sr;
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      re += x[from + i] * win * Math.cos(w * i);
      im -= x[from + i] * win * Math.sin(w * i);
    }
    return re * re + im * im;
  };
  const step = 10;
  const raw = [];
  for (let f = lo - 150; f <= hi + 150; f += step) raw.push(power(f));
  const half = 15; // ±150 Hz
  for (let k = half; k < raw.length - half; k++) {
    let s = 0;
    for (let j = -half; j <= half; j++) s += raw[k + j];
    if (s > best) { best = s; bestF = lo - 150 + k * step; }
  }
  return bestF;
}

export function run(engine, input, block = 128) {
  const out = new Float32Array(input.length);
  for (let i = 0; i + block <= input.length; i += block) {
    engine.process(input.subarray(i, i + block), out.subarray(i, i + block));
  }
  return out;
}
