/**
 * BadloVoice local voice engine — pure JS, no dependencies, no allocation
 * while processing. Runs inside an AudioWorklet (live + offline render) and
 * under Node for tests.
 *
 *   mic → pitch/formant shifter (pitch-synchronous overlap-add)
 *       → robot → whisper → distortion → bitcrush → telephone
 *       → chorus → echo → reverb → EQ → compressor → gain → soft limiter
 *
 * The effect order and parameter names mirror the Python rack in
 * backend/services/dsp_effects.py so a preset sounds the same in both places.
 */

const TWO_PI = Math.PI * 2;

function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/* -------------------------------------------------------------------------- */
/* Biquad (transposed direct form II, RBJ cookbook coefficients)              */
/* -------------------------------------------------------------------------- */

class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }

  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  _set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  lowpass(sr, freq, q) {
    const w0 = TWO_PI * Math.min(freq / sr, 0.49);
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    this._set((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
    return this;
  }

  highpass(sr, freq, q) {
    const w0 = TWO_PI * Math.min(freq / sr, 0.49);
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    this._set((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
    return this;
  }

  /** Band-pass with 0 dB peak gain. */
  bandpass(sr, freq, q) {
    const w0 = TWO_PI * Math.min(freq / sr, 0.49);
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    this._set(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha);
    return this;
  }

  shelf(sr, freq, gainDb, high) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = TWO_PI * Math.min(freq / sr, 0.45);
    const cos = Math.cos(w0);
    const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
    const k = 2 * Math.sqrt(A) * alpha;
    if (high) {
      this._set(
        A * (A + 1 + (A - 1) * cos + k),
        -2 * A * (A - 1 + (A + 1) * cos),
        A * (A + 1 + (A - 1) * cos - k),
        A + 1 - (A - 1) * cos + k,
        2 * (A - 1 - (A + 1) * cos),
        A + 1 - (A - 1) * cos - k
      );
    } else {
      this._set(
        A * (A + 1 - (A - 1) * cos + k),
        2 * A * (A - 1 - (A + 1) * cos),
        A * (A + 1 - (A - 1) * cos - k),
        A + 1 + (A - 1) * cos + k,
        -2 * (A - 1 + (A + 1) * cos),
        A + 1 + (A - 1) * cos - k
      );
    }
    return this;
  }
}

/* -------------------------------------------------------------------------- */
/* Pitch + formant shifter                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pitch-synchronous overlap-add shifter.
 *
 * A pitch tracker follows the speaker's period T. The output is rebuilt from
 * two-period Hann grains cut from the input:
 *   - grain spacing T / pitchRatio sets the new pitch,
 *   - resampling each grain by formantRatio moves the vocal-tract resonances.
 * Because the two are independent, raising pitch no longer forces a chipmunk
 * timbre, and formants can be moved without touching pitch.
 */
class PitchFormantShifter {
  constructor(sampleRate) {
    const sr = sampleRate;
    this.sr = sr;
    this.size = nextPow2(Math.ceil(sr * 0.5));
    this.mask = this.size - 1;
    this.inBuf = new Float32Array(this.size);
    this.outBuf = new Float32Array(this.size);
    this.w = 0; // absolute input write index
    this.r = 0; // absolute output read index
    this.delay = Math.round(0.022 * sr);
    this.tS = 0; // absolute output position of the next grain centre
    this.cPrev = 0;
    this.cPrevValid = false;

    this.minT = sr / 520;
    this.maxT = sr / 62;
    this.T = sr / 150;
    this.voiced = false;
    this.clarity = 0;

    // Pitch tracker works on a low-passed, decimated copy (~8 kHz).
    this.dec = Math.max(1, Math.round(sr / 8000));
    const fsd = sr / this.dec;
    this.lpA = 1 - Math.exp((-TWO_PI * 1000) / sr);
    this.lp = 0;
    this.dc = 0;
    this.decAcc = 0;
    this.decCount = 0;
    this.W = Math.round(0.03 * fsd);
    this.tauMin = Math.max(2, Math.floor(fsd / 520));
    this.tauMax = Math.ceil(fsd / 62);
    this.frameLen = this.W + this.tauMax + 2;
    this.dSize = nextPow2(this.frameLen + 8);
    this.dMask = this.dSize - 1;
    this.dRing = new Float32Array(this.dSize);
    this.dW = 0;
    this.frame = new Float32Array(this.frameLen);
    this.nsdf = new Float32Array(this.tauMax + 3);
    this.detHop = Math.max(1, Math.round(0.008 * fsd));
    this.detCount = 0;
    this.jumpCount = 0;
    this.unvoicedCount = 0;

    this.hann = new Float32Array(1025);
    for (let i = 0; i <= 1024; i++) {
      this.hann[i] = 0.5 * (1 + Math.cos((Math.PI * i) / 1024));
    }

    this.pitchRatio = 1;
    this.formantRatio = 1;
    this.monotoneHz = 0;
    this.vibRate = 0;
    this.vibDepth = 0;
    this.vibPhase = 0;

    this.active = false;
    this.mix = 0; // 0 = dry (bypass), 1 = shifted
    this.mixStep = 1 / (0.02 * sr);
  }

  get latency() {
    return this.active ? this.delay : 0;
  }

  /** Detected speaking pitch in Hz, or 0 when unvoiced. */
  get pitchHz() {
    return this.voiced ? this.sr / this.T : 0;
  }

  setShift(pitchSemis, formantSemis) {
    this.pitchRatio = Math.pow(2, clamp(pitchSemis, -24, 24, 0) / 12);
    this.formantRatio = Math.pow(2, clamp(formantSemis, -12, 12, 0) / 12);
  }

  setMonotone(hz) {
    this.monotoneHz = hz > 0 ? clamp(hz, 40, 600, 0) : 0;
  }

  setVibrato(rateHz, depthSemis) {
    this.vibRate = clamp(rateHz, 0, 20, 0);
    this.vibDepth = clamp(depthSemis, 0, 4, 0);
  }

  _wanted() {
    return (
      Math.abs(this.pitchRatio - 1) > 0.003 ||
      Math.abs(this.formantRatio - 1) > 0.003 ||
      this.monotoneHz > 0 ||
      (this.vibRate > 0 && this.vibDepth > 0.01)
    );
  }

  _analyse() {
    const { frame, frameLen, dRing, dMask, W, tauMin, tauMax, nsdf } = this;
    let pos = this.dW - frameLen;
    let energy = 0;
    for (let i = 0; i < frameLen; i++, pos++) {
      const v = dRing[pos & dMask];
      frame[i] = v;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / frameLen);

    let found = false;
    let tauF = 0;
    let clarity = 0;
    if (rms > 0.0012) {
      let maxVal = 0;
      for (let tau = tauMin - 1; tau <= tauMax + 1; tau++) {
        let acf = 0;
        let m = 0;
        for (let j = 0; j < W; j++) {
          const a = frame[j];
          const b = frame[j + tau];
          acf += a * b;
          m += a * a + b * b;
        }
        const v = m > 1e-12 ? (2 * acf) / m : 0;
        nsdf[tau] = v;
      }
      for (let tau = tauMin; tau <= tauMax; tau++) {
        const v = nsdf[tau];
        if (v > nsdf[tau - 1] && v >= nsdf[tau + 1] && v > maxVal) maxVal = v;
      }
      if (maxVal > 0) {
        const need = maxVal * 0.88;
        for (let tau = tauMin; tau <= tauMax; tau++) {
          const v = nsdf[tau];
          if (v >= need && v > nsdf[tau - 1] && v >= nsdf[tau + 1]) {
            const a = nsdf[tau - 1];
            const c = nsdf[tau + 1];
            const den = a - 2 * v + c;
            const shift = Math.abs(den) > 1e-9 ? (0.5 * (a - c)) / den : 0;
            tauF = tau + Math.max(-0.5, Math.min(0.5, shift));
            clarity = v;
            found = true;
            break;
          }
        }
      }
    }

    this.clarity = clarity;
    const need = this.voiced ? 0.4 : 0.6;
    if (found && clarity >= need) {
      const newT = Math.max(this.minT, Math.min(this.maxT, tauF * this.dec));
      const jump = Math.abs(newT / this.T - 1) > 0.3;
      if (this.voiced && jump && this.jumpCount < 2) {
        this.jumpCount++; // ignore a lone octave slip
      } else {
        this.T = this.voiced && !jump ? 0.3 * this.T + 0.7 * newT : newT;
        this.jumpCount = 0;
        this.voiced = true;
      }
      this.unvoicedCount = 0;
    } else if (++this.unvoicedCount >= 2) {
      this.voiced = false;
      this.jumpCount = 0;
    }
  }

  /** Nudge a grain centre so it lines up with the previous grain's waveform. */
  _align(c, cMax) {
    const { inBuf, mask, cPrev } = this;
    const T = this.T;
    const range = Math.max(2, Math.round(T * 0.07));
    const L = Math.min(Math.round(T * 0.75), 360);
    const base = Math.round(c);
    const ref = Math.round(cPrev);
    const oldest = this.w - this.size + L + 4;
    if (ref - L < oldest) return c;
    let best = 0;
    let bestScore = -Infinity;
    for (let d = -range; d <= range; d++) {
      const cand = base + d;
      if (cand + L >= this.w || cand > cMax || cand - L < oldest) continue;
      let corr = 0;
      let en = 1e-9;
      for (let j = -L; j <= L; j += 2) {
        const a = inBuf[(cand + j) & mask];
        corr += a * inBuf[(ref + j) & mask];
        en += a * a;
      }
      const score = corr / Math.sqrt(en);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return base + best;
  }

  _grain(limit) {
    const { inBuf, outBuf, mask, hann } = this;
    const rF = this.formantRatio;
    const T = this.T;
    const tS = this.tS;

    let H = T / rF;
    const hMax = 0.03 * this.sr;
    if (H > hMax) H = hMax;
    if (H < 12) H = 12;
    const srcHalf = H * rF;
    const cMax = this.w - srcHalf - 4;

    let c;
    if (this.voiced && this.cPrevValid) {
      const m = Math.round((tS - this.cPrev) / T);
      c = this.cPrev + m * T;
      if (c > cMax) c -= T * Math.ceil((c - cMax) / T);
      if (c !== this.cPrev) c = this._align(c, cMax);
    } else {
      c = Math.min(tS, cMax);
    }
    const cMin = this.w - this.size + srcHalf + 4;
    if (c < cMin) c = cMin;

    let spacing;
    if (this.voiced) {
      let ratio = this.pitchRatio;
      if (this.vibRate > 0 && this.vibDepth > 0.01) {
        ratio *= Math.pow(2, (this.vibDepth * Math.sin(this.vibPhase)) / 12);
      }
      spacing = this.monotoneHz > 0 ? this.sr / this.monotoneHz : T / ratio;
      const lo = this.sr / 1100;
      if (spacing < lo) spacing = lo;
      this.vibPhase += (TWO_PI * this.vibRate * spacing) / this.sr;
      if (this.vibPhase > TWO_PI) this.vibPhase -= TWO_PI;
    } else {
      spacing = H; // 50 % Hann overlap → noise passes through unpitched
    }

    let gain = 1;
    if (this.voiced) {
      gain = Math.sqrt(spacing / H);
      if (gain > 1.4) gain = 1.4;
      else if (gain < 0.55) gain = 0.55;
    }

    let start = Math.ceil(tS - H);
    if (start < limit) start = limit;
    const end = Math.floor(tS + H);
    const invH = 1024 / H;
    for (let o = start; o <= end; o++) {
      const u = o - tS;
      const p = (u < 0 ? -u : u) * invH;
      if (p >= 1024) continue;
      const pos = c + u * rF;
      const i0 = Math.floor(pos);
      const f = pos - i0;
      const xm = inBuf[(i0 - 1) & mask];
      const x0 = inBuf[i0 & mask];
      const x1 = inBuf[(i0 + 1) & mask];
      const x2 = inBuf[(i0 + 2) & mask];
      // 4-point Hermite interpolation
      const c1 = 0.5 * (x1 - xm);
      const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
      const s = ((c3 * f + c2) * f + c1) * f + x0;
      outBuf[o & mask] += s * hann[p | 0] * gain;
    }

    this.cPrev = c;
    this.cPrevValid = true;
    this.tS = tS + spacing;
  }

  /** In-place processing of `n` samples. */
  process(buf, n) {
    const { inBuf, mask } = this;

    // 1. Buffer input and feed the pitch tracker.
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      inBuf[(this.w + i) & mask] = x;
      this.dc += 0.002 * (x - this.dc);
      this.lp += this.lpA * (x - this.dc - this.lp);
      this.decAcc += this.lp;
      if (++this.decCount >= this.dec) {
        this.dRing[this.dW & this.dMask] = this.decAcc / this.dec;
        this.dW++;
        this.decAcc = 0;
        this.decCount = 0;
        if (++this.detCount >= this.detHop) {
          this.detCount = 0;
          this._analyse();
        }
      }
    }
    this.w += n;

    const wanted = this._wanted();
    if (wanted && !this.active) {
      // Restart cleanly: no stale grains, output clock locked to the input.
      this.outBuf.fill(0);
      this.r = this.w - n - this.delay;
      this.tS = this.r;
      this.cPrevValid = false;
      this.active = true;
    }
    if (!this.active) return;

    // 2. Lay down every grain that can touch this block.
    const blockEnd = this.r + n;
    let guard = 0;
    while (guard++ < 4096) {
      let H = this.T / this.formantRatio;
      const hMax = 0.03 * this.sr;
      if (H > hMax) H = hMax;
      if (this.tS - H >= blockEnd) break;
      this._grain(this.r);
    }

    // 3. Read the block out, cross-fading with the dry signal on bypass changes.
    const outBuf = this.outBuf;
    const target = wanted ? 1 : 0;
    let mix = this.mix;
    const step = this.mixStep;
    for (let i = 0; i < n; i++) {
      const idx = (this.r + i) & mask;
      const wet = outBuf[idx];
      outBuf[idx] = 0;
      if (mix !== target) {
        mix += mix < target ? step : -step;
        if (mix > 1) mix = 1;
        else if (mix < 0) mix = 0;
      }
      buf[i] = mix >= 1 ? wet : buf[i] * (1 - mix) + wet * mix;
    }
    this.mix = mix;
    this.r += n;
    if (!wanted && mix <= 0) this.active = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Effects                                                                    */
/* -------------------------------------------------------------------------- */

class Robot {
  constructor(sr) {
    this.sr = sr;
    this.phase = 0;
  }

  process(buf, n, p) {
    const inc = (TWO_PI * clamp(p.freq, 10, 400, 90)) / this.sr;
    const mix = clamp(p.mix, 0, 1, 0.75);
    let phase = this.phase;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      buf[i] = x * (1 - mix) + x * Math.sin(phase) * mix * 1.3;
      phase += inc;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    this.phase = phase;
  }
}

/**
 * Whisper: a channel vocoder driven by noise. The voice's band envelopes are
 * kept (so words stay intelligible) while the pitched excitation is replaced
 * by breath noise.
 */
class Whisper {
  constructor(sr) {
    const bands = 16;
    const lo = 180;
    const hi = Math.min(7600, sr * 0.45);
    const ratio = Math.pow(hi / lo, 1 / (bands - 1));
    const q = 1 / (Math.sqrt(ratio) - 1 / Math.sqrt(ratio));
    this.bands = bands;
    this.ana = [];
    this.syn = [];
    this.env = new Float32Array(bands);
    this.gain = new Float32Array(bands);
    for (let b = 0; b < bands; b++) {
      const fc = lo * Math.pow(ratio, b);
      this.ana.push(new Biquad().bandpass(sr, fc, q));
      this.syn.push(new Biquad().bandpass(sr, fc, q));
      // Undo the level lost by band-limiting white noise, plus a gentle
      // high-frequency lift — real whispers are brighter than voiced speech.
      const noiseRms = Math.sqrt((Math.PI * fc) / (q * sr));
      const tilt = Math.pow(fc / 1000, 0.25);
      this.gain[b] = (0.6 / noiseRms) * tilt;
    }
    this.att = 1 - Math.exp(-1 / (0.004 * sr));
    this.rel = 1 - Math.exp(-1 / (0.02 * sr));
    this.seed = 0x2545f491;
  }

  process(buf, n, p) {
    const mix = clamp(p.mix, 0, 1, 1);
    const { bands, ana, syn, env, gain, att, rel } = this;
    let seed = this.seed;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      // xorshift32 → uniform noise with unit variance
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = (seed / 2147483648) * 1.7320508;
      let wet = 0;
      for (let b = 0; b < bands; b++) {
        let a = ana[b].tick(x);
        if (a < 0) a = -a;
        const e = env[b];
        const ne = e + (a > e ? att : rel) * (a - e);
        env[b] = ne;
        wet += syn[b].tick(noise) * ne * gain[b];
      }
      buf[i] = x * (1 - mix) + wet * mix;
    }
    this.seed = seed;
  }
}

class Telephone {
  constructor(sr) {
    this.stages = [
      new Biquad().highpass(sr, 300, 0.5412),
      new Biquad().highpass(sr, 300, 1.3066),
      new Biquad().lowpass(sr, 3400, 0.5412),
      new Biquad().lowpass(sr, 3400, 1.3066),
    ];
  }

  process(buf, n) {
    const [a, b, c, d] = this.stages;
    for (let i = 0; i < n; i++) {
      buf[i] = Math.tanh(d.tick(c.tick(b.tick(a.tick(buf[i])))) * 1.6) * 0.92;
    }
  }
}

class Distortion {
  constructor(sr) {
    this.lpA = 1 - Math.exp((-TWO_PI * 6500) / sr);
    this.lp = 0;
  }

  process(buf, n, p) {
    const drive = clamp(p.drive, 0, 1, 0.4);
    const gain = 1 + drive * 24;
    const out = (0.9 / Math.max(Math.tanh(gain * 0.25), 1e-3)) * 0.35 + 0.45;
    let lp = this.lp;
    for (let i = 0; i < n; i++) {
      const y = Math.tanh(buf[i] * gain) * out;
      lp += this.lpA * (y - lp); // take the fizz off the top
      buf[i] = lp;
    }
    this.lp = lp;
  }
}

class Bitcrush {
  constructor() {
    this.hold = 0;
    this.count = 0;
  }

  process(buf, n, p) {
    const bits = Math.round(clamp(p.bits, 2, 16, 8));
    const down = Math.round(clamp(p.down, 1, 32, 4));
    const q = Math.pow(2, bits - 1);
    let { hold, count } = this;
    for (let i = 0; i < n; i++) {
      if (count === 0) hold = Math.round(buf[i] * q) / q;
      if (++count >= down) count = 0;
      buf[i] = hold;
    }
    this.hold = hold;
    this.count = count;
  }
}

class Chorus {
  constructor(sr) {
    this.sr = sr;
    this.size = nextPow2(Math.ceil(sr * 0.05) + 4);
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.phase = 0;
  }

  process(buf, n, p) {
    const rate = clamp(p.rate, 0.05, 5, 0.8);
    const depth = clamp(p.depth, 0, 1, 0.5);
    const mix = clamp(p.mix, 0, 1, 0.5);
    const base = 0.02 * this.sr;
    const span = 0.012 * this.sr * depth;
    const inc = (TWO_PI * rate) / this.sr;
    const { mask } = this;
    const line = this.buf;
    let { w, phase } = this;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      line[w & mask] = x;
      // Two voices a third of a cycle apart for a wider ensemble.
      let wet = 0;
      for (let v = 0; v < 2; v++) {
        const pos = w - (base + span * Math.sin(phase + v * 2.0944));
        const i0 = Math.floor(pos);
        const f = pos - i0;
        const a = line[i0 & mask];
        wet += a + (line[(i0 + 1) & mask] - a) * f;
      }
      buf[i] = x * (1 - mix) + wet * 0.5 * mix;
      w++;
      phase += inc;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    this.w = w;
    this.phase = phase;
  }
}

class Echo {
  constructor(sr) {
    this.sr = sr;
    this.size = nextPow2(Math.ceil(sr * 1.6));
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
  }

  process(buf, n, p) {
    const delay = Math.max(1, Math.round(clamp(p.time, 0.03, 1.5, 0.25) * this.sr));
    const fb = clamp(p.feedback, 0, 0.9, 0.35);
    const mix = clamp(p.mix, 0, 1, 0.35);
    const { mask } = this;
    const line = this.buf;
    let w = this.w;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const d = line[(w - delay) & mask];
      line[w & mask] = x + d * fb + 1e-20;
      buf[i] = x * (1 - mix) + d * mix;
      w++;
    }
    this.w = w;
  }
}

/** Freeverb-style room: 8 damped feedback combs into 4 all-passes. */
class Reverb {
  constructor(sr) {
    const scale = sr / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const allpasses = [556, 441, 341, 225];
    this.combBuf = combs.map((d) => new Float32Array(Math.max(8, Math.round(d * scale))));
    this.combPos = new Int32Array(combs.length);
    this.combLp = new Float32Array(combs.length);
    this.apBuf = allpasses.map((d) => new Float32Array(Math.max(4, Math.round(d * scale))));
    this.apPos = new Int32Array(allpasses.length);
  }

  process(buf, n, p) {
    const size = clamp(p.size, 0, 1, 0.5);
    const mix = clamp(p.mix, 0, 1, 0.35);
    const fb = 0.7 + 0.28 * size;
    const damp = 0.3;
    const WET = 1.1;
    const { combBuf, combPos, combLp, apBuf, apPos } = this;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const input = x * 0.03;
      let wet = 0;
      for (let k = 0; k < combBuf.length; k++) {
        const line = combBuf[k];
        const pos = combPos[k];
        const y = line[pos];
        const lp = y * (1 - damp) + combLp[k] * damp;
        combLp[k] = lp;
        line[pos] = input + lp * fb + 1e-20;
        combPos[k] = pos + 1 >= line.length ? 0 : pos + 1;
        wet += y;
      }
      for (let k = 0; k < apBuf.length; k++) {
        const line = apBuf[k];
        const pos = apPos[k];
        const delayed = line[pos];
        const y = delayed - wet;
        line[pos] = wet + delayed * 0.5;
        apPos[k] = pos + 1 >= line.length ? 0 : pos + 1;
        wet = y;
      }
      buf[i] = x * (1 - mix) + wet * WET * mix;
    }
  }
}

class Eq {
  constructor(sr) {
    this.sr = sr;
    this.low = new Biquad();
    this.high = new Biquad();
    this.lowDb = null;
    this.highDb = null;
  }

  process(buf, n, p) {
    const low = clamp(p.low, -15, 15, 0);
    const high = clamp(p.high, -15, 15, 0);
    if (low !== this.lowDb) {
      this.low.shelf(this.sr, 250, low, false);
      this.lowDb = low;
    }
    if (high !== this.highDb) {
      this.high.shelf(this.sr, 4000, high, true);
      this.highDb = high;
    }
    const lo = this.low;
    const hi = this.high;
    for (let i = 0; i < n; i++) buf[i] = hi.tick(lo.tick(buf[i]));
  }
}

class Compressor {
  constructor(sr) {
    this.att = 1 - Math.exp(-1 / (0.005 * sr));
    this.rel = 1 - Math.exp(-1 / (0.09 * sr));
    this.env = 0;
  }

  process(buf, n, p) {
    const threshold = clamp(p.threshold, -60, 0, -20);
    const ratio = clamp(p.ratio, 1, 20, 3);
    const slope = 1 - 1 / ratio;
    const makeup = Math.pow(10, (-threshold * slope * 0.4) / 20);
    const { att, rel } = this;
    let env = this.env;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const a = x < 0 ? -x : x;
      env += (a > env ? att : rel) * (a - env);
      const over = 20 * Math.log10(env + 1e-9) - threshold;
      // 6 dB soft knee
      let reduce = 0;
      if (over > 3) reduce = over * slope;
      else if (over > -3) reduce = ((over + 3) * (over + 3) * slope) / 12;
      buf[i] = x * makeup * Math.pow(10, -reduce / 20);
    }
    this.env = env;
  }
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

export const POST_CHAIN_ORDER = [
  'robot',
  'whisper',
  'distortion',
  'bitcrush',
  'telephone',
  'chorus',
  'echo',
  'reverb',
  'eq',
  'compressor',
  'gain',
];

export class VoiceEngine {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.shifter = new PitchFormantShifter(sampleRate);
    this.fx = {
      robot: new Robot(sampleRate),
      whisper: new Whisper(sampleRate),
      distortion: new Distortion(sampleRate),
      bitcrush: new Bitcrush(),
      telephone: new Telephone(sampleRate),
      chorus: new Chorus(sampleRate),
      echo: new Echo(sampleRate),
      reverb: new Reverb(sampleRate),
      eq: new Eq(sampleRate),
      compressor: new Compressor(sampleRate),
    };
    this.effects = {};
    this.enabled = true;
    this.pitch = 0;
    this.formant = 0;
  }

  /** Pitch tracker reading in Hz (0 = unvoiced / silence). */
  get pitchHz() {
    return this.shifter.pitchHz;
  }

  get latencySamples() {
    return this.shifter.latency;
  }

  /**
   * @param {object} params
   * @param {number} [params.pitch] semitones
   * @param {number} [params.formant] semitones
   * @param {object} [params.effects] rack state keyed like the backend
   * @param {boolean} [params.enabled] false = dry passthrough
   */
  setParams(params) {
    if (!params || typeof params !== 'object') return;
    if (typeof params.enabled === 'boolean') this.enabled = params.enabled;
    if (typeof params.pitch === 'number') this.pitch = params.pitch;
    if (typeof params.formant === 'number') this.formant = params.formant;
    if (params.effects && typeof params.effects === 'object') this.effects = params.effects;

    const fx = this.effects;
    const on = (key) => (fx[key] && fx[key].enabled ? fx[key] : null);
    this.shifter.setShift(this.pitch, this.formant);
    const mono = on('monotone');
    this.shifter.setMonotone(mono ? clamp(mono.freq, 40, 600, 110) : 0);
    const vib = on('vibrato');
    this.shifter.setVibrato(vib ? clamp(vib.rate, 0.5, 12, 5.5) : 0, vib ? clamp(vib.depth, 0, 4, 0.6) : 0);
  }

  /** Process `input` into `output` (same length; may be the same array). */
  process(input, output) {
    const n = input.length;
    if (output !== input) output.set(input);
    if (!this.enabled) {
      // Keep the pitch tracker alive so the UI can still read the speaker's F0.
      const s = this.shifter;
      const wantedBefore = s.pitchRatio;
      const formantBefore = s.formantRatio;
      const mono = s.monotoneHz;
      const depth = s.vibDepth;
      s.pitchRatio = 1;
      s.formantRatio = 1;
      s.monotoneHz = 0;
      s.vibDepth = 0;
      s.process(output, n);
      s.pitchRatio = wantedBefore;
      s.formantRatio = formantBefore;
      s.monotoneHz = mono;
      s.vibDepth = depth;
      return;
    }

    this.shifter.process(output, n);

    const fx = this.effects;
    for (let k = 0; k < POST_CHAIN_ORDER.length; k++) {
      const key = POST_CHAIN_ORDER[k];
      const p = fx[key];
      if (!p || !p.enabled) continue;
      if (key === 'gain') {
        const g = Math.pow(10, clamp(p.db, -24, 24, 0) / 20);
        for (let i = 0; i < n; i++) output[i] *= g;
      } else {
        this.fx[key].process(output, n, p);
      }
    }

    // Soft limiter: transparent below 0.8, never exceeds ±1.
    for (let i = 0; i < n; i++) {
      const y = output[i];
      if (y > 0.8) output[i] = 0.8 + 0.2 * Math.tanh((y - 0.8) * 5);
      else if (y < -0.8) output[i] = -0.8 - 0.2 * Math.tanh((-y - 0.8) * 5);
      else if (y !== y) output[i] = 0; // NaN guard
    }
  }
}
