/**
 * Noise / background voice gate.
 * Opens easily for close-mic speech; stays closed for quiet room noise.
 */
class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.enabled = true;
    // Lower = easier for your voice to open (was -42, blocked quiet mics).
    this.thresholdDb = -56;
    this.holdMs = 280;
    this.attack = 0.45; // open fast
    this.release = 0.04; // close slow
    this.gain = 0;
    this.open = false;
    this.holdSamples = 0;
    this.silent = false;
    this.sinceReport = 0;
    const init = options?.processorOptions || {};
    if (typeof init.enabled === 'boolean') this.enabled = init.enabled;
    if (typeof init.thresholdDb === 'number') this.thresholdDb = init.thresholdDb;
    if (typeof init.silent === 'boolean') this.silent = init.silent;
    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (typeof msg.enabled === 'boolean') this.enabled = msg.enabled;
      if (typeof msg.thresholdDb === 'number') this.thresholdDb = msg.thresholdDb;
      if (typeof msg.holdMs === 'number') this.holdMs = msg.holdMs;
      if (typeof msg.silent === 'boolean') this.silent = msg.silent;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    if (!this.enabled) {
      output.set(input);
      this.gain = 1;
      this.open = true;
      return true;
    }

    // Peak + RMS — peak catches consonants so soft speech still opens.
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < input.length; i++) {
      const a = Math.abs(input[i]);
      sum += input[i] * input[i];
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / Math.max(1, input.length));
    const level = Math.max(rms, peak * 0.65);
    const db = 20 * Math.log10(level + 1e-9);

    // Wide hysteresis: easy open, harder close (won't chop your words).
    const openThresh = this.thresholdDb;
    const closeThresh = this.thresholdDb - 14;
    const hold = Math.floor((this.holdMs / 1000) * sampleRate);

    if (this.open) {
      if (db < closeThresh) {
        this.holdSamples += input.length;
        if (this.holdSamples >= hold) this.open = false;
      } else {
        this.holdSamples = 0;
      }
    } else if (db > openThresh) {
      this.open = true;
      this.holdSamples = 0;
    }

    const target = this.open ? 1 : 0.0008;
    const coeff = this.open ? this.attack : this.release;

    for (let i = 0; i < input.length; i++) {
      this.gain = this.gain * (1 - coeff) + target * coeff;
      output[i] = input[i] * this.gain;
    }

    for (let ch = 1; ch < (outputs[0]?.length || 0); ch++) {
      outputs[0][ch].set(output);
    }

    // ~20 reports/s is plenty for the UI; one per render quantum floods React.
    this.sinceReport += input.length;
    if (!this.silent && this.sinceReport >= sampleRate * 0.05) {
      this.sinceReport = 0;
      this.port.postMessage({
        type: 'gate',
        open: this.open,
        levelDb: db,
        gain: this.gain,
      });
    }

    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
