// AudioWorklet wrapper around the local voice engine (see voiceEngineCore.js).
// Used live (mic → speakers/recorder) and in OfflineAudioContext file renders.
import { VoiceEngine } from './voiceEngineCore.js';

class VoiceEngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new VoiceEngine(sampleRate);
    // Initial settings arrive with the node so the very first block is right
    // (port messages can land after an offline render has already started).
    this.engine.setParams(options?.processorOptions?.params);
    this.silence = new Float32Array(128);
    this.sinceReport = 0;
    this.reportEvery = Math.round(sampleRate * 0.05);
    this.port.onmessage = (event) => {
      this.engine.setParams(event.data);
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const out = output && output[0];
    if (!out) return true;
    let input = inputs[0] && inputs[0][0];
    if (!input || input.length !== out.length) {
      // No mic frames (e.g. source ended): keep echo/reverb tails ringing.
      if (this.silence.length !== out.length) this.silence = new Float32Array(out.length);
      input = this.silence;
    }

    this.engine.process(input, out);
    for (let ch = 1; ch < output.length; ch++) output[ch].set(out);

    this.sinceReport += out.length;
    if (this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0;
      this.port.postMessage({
        type: 'pitch',
        hz: this.engine.pitchHz,
        latency: this.engine.latencySamples / sampleRate,
      });
    }
    return true;
  }
}

registerProcessor('voice-engine-processor', VoiceEngineProcessor);
