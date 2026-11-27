// Main-thread helpers for the local voice engine worklet.
import { encodeWav } from './wav';

/** Public-folder asset URL that works on Vercel (/) and in the Capacitor APK (./). */
export function assetUrl(name) {
  return new URL(name, document.baseURI).href;
}

export const ENGINE_WORKLET = 'voiceEngineWorklet.js';
export const GATE_WORKLET = 'noiseGateWorklet.js';
export const IO_WORKLET = 'audioWorklet.js';

/** Median of the voiced pitch readings, or 0 when there is too little speech. */
export function medianPitch(readings, minCount = 40) {
  if (!readings || readings.length < minCount) return 0;
  const sorted = Array.from(readings).sort((a, b) => a - b);
  // Trim the outer 15 % — octave slips and breaths.
  const cut = Math.floor(sorted.length * 0.15);
  const core = sorted.slice(cut, sorted.length - cut);
  return core[core.length >> 1] || 0;
}

/**
 * Render an audio file through the local engine, entirely in the browser.
 * Returns a mono WAV Blob. Works with no server (hosted site, Android APK).
 */
export async function renderFileLocally(file, { pitch = 0, formant = 0, effects = {}, gate = null } = {}) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const LiveCtx = window.AudioContext || window.webkitAudioContext;
  if (!OfflineCtx || !LiveCtx) throw new Error('This browser cannot process audio offline.');

  const bytes = await file.arrayBuffer();
  const decodeCtx = new LiveCtx();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes);
  } catch {
    throw new Error('Could not read that file. Try WAV, MP3, M4A or OGG.');
  } finally {
    decodeCtx.close().catch(() => {});
  }

  const sampleRate = decoded.sampleRate;
  // Leave room for echo / reverb tails to ring out.
  const tail = effects?.echo?.enabled || effects?.reverb?.enabled ? 2.5 : 0.25;
  const length = Math.ceil(decoded.length + tail * sampleRate);
  const ctx = new OfflineCtx(1, length, sampleRate);
  if (!ctx.audioWorklet) throw new Error('This browser cannot process audio offline.');
  await ctx.audioWorklet.addModule(assetUrl(ENGINE_WORKLET));

  const source = ctx.createBufferSource();
  source.buffer = decoded;
  const engine = new AudioWorkletNode(ctx, 'voice-engine-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    outputChannelCount: [1],
    processorOptions: { params: { enabled: true, pitch, formant, effects } },
  });

  let head = source;
  if (gate?.enabled) {
    await ctx.audioWorklet.addModule(assetUrl(GATE_WORKLET));
    const gateNode = new AudioWorkletNode(ctx, 'noise-gate-processor', {
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
      processorOptions: { enabled: true, thresholdDb: gate.thresholdDb ?? -56, silent: true },
    });
    source.connect(gateNode);
    head = gateNode;
  }
  head.connect(engine);
  engine.connect(ctx.destination);
  source.start();

  const rendered = await ctx.startRendering();
  return encodeWav([rendered.getChannelData(0)], sampleRate);
}
