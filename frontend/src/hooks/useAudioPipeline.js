import { useCallback, useRef, useState } from 'react';
import { SAMPLE_RATE, CHUNK_SIZE } from '../lib/constants';
import { encodeWav } from '../lib/wav';
import {
  assetUrl,
  medianPitch,
  ENGINE_WORKLET,
  GATE_WORKLET,
  IO_WORKLET,
} from '../lib/voiceEngine';

const PITCH_HISTORY = 160; // ≈ 8 s of voiced speech at 20 readings/s

export default function useAudioPipeline(wsHook) {
  const wsRef = useRef(wsHook);
  wsRef.current = wsHook;
  const [isRunning, setIsRunning] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [lastRecording, setLastRecording] = useState(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [gateLevelDb, setGateLevelDb] = useState(-80);

  const audioContextRef = useRef(null);
  const captureSinkRef = useRef(null);
  const streamRef = useRef(null);
  const sourceRef = useRef(null);
  const gateNodeRef = useRef(null);
  const captureNodeRef = useRef(null);
  const playbackNodeRef = useRef(null);
  const playbackGainRef = useRef(null);
  const engineNodeRef = useRef(null);
  const engineGainRef = useRef(null);
  const speakerGainRef = useRef(null);
  const monitorGainRef = useRef(null);
  const monitorElRef = useRef(null);
  // True while the changed voice is routed to a device the user picked
  // (e.g. a virtual cable feeding Discord) rather than the default speakers.
  const sinkAppliedRef = useRef(false);
  const [sendingToDevice, setSendingToDevice] = useState(false);
  const captureOptionsRef = useRef({
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
  });
  const inputAnalyserRef = useRef(null);
  const outputAnalyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const seqNumRef = useRef(0);
  const recordingRef = useRef(false);
  const recordChunksRef = useRef([]);
  const recordSamplesRef = useRef(0);
  const sampleRateRef = useRef(SAMPLE_RATE);
  const engineParamsRef = useRef({ pitch: 0, formant: 0, effects: {} });
  const pitchHistoryRef = useRef([]);
  const pitchTickRef = useRef(0);
  const [voicePitchHz, setVoicePitchHz] = useState(0);
  const [engineLatencyMs, setEngineLatencyMs] = useState(0);
  const gateParamsRef = useRef({ enabled: false, thresholdDb: -56, holdMs: 280 });
  const recordProcessorRef = useRef(null);
  const listenModeRef = useRef('local'); // local | rvc
  // Speakers + mic = feedback. Default off; user opts in (headphones).
  const hearMyselfRef = useRef(false);
  const [hearMyself, setHearMyselfState] = useState(false);

  // Routing rules:
  //   local — the in-browser engine is the voice (no server needed).
  //   rvc   — the server model is the voice; the engine only tracks pitch.
  // Exactly one source is audible, so the two are never doubled up.
  // Output rules:
  //   default device  — "Hear myself" switches the speakers on and off.
  //   a chosen device — the voice always goes there (that is why it was
  //                     chosen); "Hear myself" adds a copy on the default
  //                     speakers so you can monitor what the cable receives.
  // Meters and the recorder tap the bus before either switch.
  const applyOutputGains = useCallback(() => {
    const ctx = audioContextRef.current;
    const now = ctx?.currentTime ?? 0;
    const rvc = listenModeRef.current === 'rvc';
    const ramp = (node, value) => {
      if (!node) return;
      node.gain.cancelScheduledValues(now);
      node.gain.setTargetAtTime(value, now, 0.015);
    };
    ramp(engineGainRef.current, rvc ? 0 : 1);
    ramp(playbackGainRef.current, rvc ? 1.4 : 0);
    const hear = hearMyselfRef.current;
    const toDevice = sinkAppliedRef.current;
    ramp(speakerGainRef.current, toDevice || hear ? 1 : 0);
    ramp(monitorGainRef.current, toDevice && hear ? 1 : 0);
    const monitorEl = monitorElRef.current;
    if (monitorEl) {
      if (toDevice && hear) monitorEl.play().catch(() => {});
      else monitorEl.pause();
    }
    engineNodeRef.current?.port.postMessage({ ...engineParamsRef.current, enabled: !rvc });
  }, []);

  const rmsToMeter = (rms) => {
    // Map ~-50 dB..0 dB → 0..100 so meters actually move when you talk.
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    return Math.max(0, Math.min(100, ((db + 50) / 50) * 100));
  };

  const updateLevels = useCallback(() => {
    if (inputAnalyserRef.current) {
      const data = new Float32Array(inputAnalyserRef.current.fftSize);
      inputAnalyserRef.current.getFloatTimeDomainData(data);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      setInputLevel(rmsToMeter(Math.max(Math.sqrt(sum / data.length), peak * 0.5)));
    }

    if (outputAnalyserRef.current) {
      const data = new Float32Array(outputAnalyserRef.current.fftSize);
      outputAnalyserRef.current.getFloatTimeDomainData(data);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      setOutputLevel(rmsToMeter(Math.max(Math.sqrt(sum / data.length), peak * 0.5)));
    }

    if (recordingRef.current) {
      setRecordSeconds(recordSamplesRef.current / sampleRateRef.current);
    }

    animFrameRef.current = requestAnimationFrame(updateLevels);
  }, []);

  /** Push pitch / formant / effects to the local engine. */
  const setEngineParams = useCallback((partial) => {
    engineParamsRef.current = { ...engineParamsRef.current, ...partial };
    engineNodeRef.current?.port.postMessage({
      ...engineParamsRef.current,
      enabled: listenModeRef.current !== 'rvc',
    });
  }, []);

  /** Median speaking pitch (Hz) over the last few seconds, 0 if not enough speech yet. */
  const getMedianPitch = useCallback(() => medianPitch(pitchHistoryRef.current), []);

  const setGateParams = useCallback((partial) => {
    gateParamsRef.current = { ...gateParamsRef.current, ...partial };
    gateNodeRef.current?.port.postMessage(gateParamsRef.current);
  }, []);

  // local = in-browser engine. rvc = server model return.
  const setListenMode = useCallback(
    (mode) => {
      const next = mode === 'rvc' || mode === 'server' ? 'rvc' : 'local';
      const changed = next !== listenModeRef.current;
      listenModeRef.current = next;
      if (changed && next === 'rvc' && audioContextRef.current) {
        // The server may have connected after Start — tell it our real rate.
        wsRef.current.sendSettings?.({
          sample_rate: sampleRateRef.current,
          chunk_size: CHUNK_SIZE,
        });
      }
      applyOutputGains();
    },
    [applyOutputGains]
  );

  /**
   * Browser mic processing used on the next Start: noise suppression, echo
   * cancellation and automatic gain. All off by default (raw mic).
   */
  const setCaptureOptions = useCallback((partial) => {
    captureOptionsRef.current = { ...captureOptionsRef.current, ...partial };
  }, []);

  /** Speakers on/off (or monitor on/off when sending to a chosen device). */
  const setHearMyself = useCallback(
    (on) => {
      const next = Boolean(on);
      hearMyselfRef.current = next;
      setHearMyselfState(next);
      applyOutputGains();
    },
    [applyOutputGains]
  );

  const start = useCallback(
    async (inputDeviceId, outputDeviceId) => {
      try {
        // A server model needs its configured rate. With no server we stay on
        // the device's native rate — no resampling, and fewer WebView quirks.
        const serverReady = wsHook.status === 'connected';
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        let audioContext;
        try {
          audioContext = new AudioCtx(
            serverReady
              ? { sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }
              : { latencyHint: 'interactive' }
          );
        } catch {
          audioContext = new AudioCtx();
        }
        audioContextRef.current = audioContext;
        const actualRate = audioContext.sampleRate || SAMPLE_RATE;
        sampleRateRef.current = actualRate;
        wsHook.sendSettings?.({
          sample_rate: actualRate,
          chunk_size: CHUNK_SIZE,
        });

        sinkAppliedRef.current = false;
        if (outputDeviceId && outputDeviceId !== 'default' && audioContext.setSinkId) {
          try {
            await audioContext.setSinkId(outputDeviceId);
            sinkAppliedRef.current = true;
          } catch {
            // Device vanished or the browser refused — fall back to the default.
          }
        }
        setSendingToDevice(sinkAppliedRef.current);

        const audioConstraints = {
          echoCancellation: Boolean(captureOptionsRef.current.echoCancellation),
          noiseSuppression: Boolean(captureOptionsRef.current.noiseSuppression),
          autoGainControl: Boolean(captureOptionsRef.current.autoGainControl),
          channelCount: 1,
        };
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              ...audioConstraints,
              ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
            },
          });
        } catch (err) {
          // A saved mic that was unplugged should not block Start.
          if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        }
        streamRef.current = stream;

        const source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;

        await Promise.all([
          audioContext.audioWorklet.addModule(assetUrl(IO_WORKLET)),
          audioContext.audioWorklet.addModule(assetUrl(ENGINE_WORKLET)),
          audioContext.audioWorklet.addModule(assetUrl(GATE_WORKLET)),
        ]);

        const mono = { channelCount: 1, channelCountMode: 'explicit' };

        const gateNode = new AudioWorkletNode(audioContext, 'noise-gate-processor', {
          ...mono,
          outputChannelCount: [1],
        });
        gateNodeRef.current = gateNode;
        gateNode.port.postMessage(gateParamsRef.current);
        gateNode.port.onmessage = (event) => {
          const msg = event.data;
          if (msg?.type === 'gate') {
            setGateOpen(Boolean(msg.open));
            setGateLevelDb(Number(msg.levelDb) || -80);
          }
        };

        const captureNode = new AudioWorkletNode(audioContext, 'capture-processor', {
          ...mono,
          processorOptions: { chunkSize: CHUNK_SIZE },
        });
        captureNodeRef.current = captureNode;

        const playbackNode = new AudioWorkletNode(audioContext, 'playback-processor', {
          processorOptions: { chunkSize: CHUNK_SIZE },
          outputChannelCount: [1],
        });
        playbackNodeRef.current = playbackNode;

        const engineNode = new AudioWorkletNode(audioContext, 'voice-engine-processor', {
          ...mono,
          outputChannelCount: [1],
          processorOptions: {
            params: { ...engineParamsRef.current, enabled: listenModeRef.current !== 'rvc' },
          },
        });
        engineNodeRef.current = engineNode;
        pitchHistoryRef.current = [];
        const outputLatency =
          (audioContext.baseLatency || 0) + (audioContext.outputLatency || 0);
        engineNode.port.onmessage = (event) => {
          const msg = event.data;
          if (msg?.type !== 'pitch') return;
          const hz = Number(msg.hz) || 0;
          if (hz > 0) {
            const history = pitchHistoryRef.current;
            history.push(hz);
            if (history.length > PITCH_HISTORY) history.shift();
          }
          // 20 messages/s arrive; repaint at ~7/s.
          if (++pitchTickRef.current % 3 === 0) {
            setVoicePitchHz(hz > 0 ? Math.round(hz) : 0);
            setEngineLatencyMs(Math.round(((Number(msg.latency) || 0) + outputLatency) * 1000));
          }
        };
        engineNode.onprocessorerror = (event) => {
          console.error('Voice engine crashed', event);
        };

        const captureSink = audioContext.createGain();
        captureSink.gain.value = 0;
        captureSinkRef.current = captureSink;

        const playbackGain = audioContext.createGain();
        playbackGain.gain.value = 0;
        playbackGainRef.current = playbackGain;

        const engineGain = audioContext.createGain();
        engineGainRef.current = engineGain;

        const speakerGain = audioContext.createGain();
        speakerGain.gain.value = 0;
        speakerGainRef.current = speakerGain;

        const mixGain = audioContext.createGain();
        mixGain.gain.value = 1;

        // Safety limiter before speakers + recorder.
        const limiter = audioContext.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.knee.value = 6;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.12;

        const inputAnalyser = audioContext.createAnalyser();
        inputAnalyser.fftSize = 2048;
        inputAnalyser.smoothingTimeConstant = 0.82;
        inputAnalyserRef.current = inputAnalyser;

        const outputAnalyser = audioContext.createAnalyser();
        outputAnalyser.fftSize = 2048;
        outputAnalyser.smoothingTimeConstant = 0.82;
        outputAnalyserRef.current = outputAnalyser;

        // Mic → gate → { meter, server capture, local engine }
        source.connect(gateNode);
        gateNode.connect(inputAnalyser);
        inputAnalyser.connect(captureNode);
        captureNode.connect(captureSink);
        captureSink.connect(audioContext.destination);

        gateNode.connect(engineNode);
        engineNode.connect(engineGain);
        engineGain.connect(mixGain);

        playbackNode.connect(playbackGain);
        playbackGain.connect(mixGain);

        // Voice bus → limiter → meter → speaker switch. The recorder taps the
        // bus before the speaker switch, so takes are never silent.
        mixGain.connect(limiter);
        limiter.connect(outputAnalyser);
        outputAnalyser.connect(speakerGain);
        speakerGain.connect(audioContext.destination);

        if (sinkAppliedRef.current) {
          // Second output on the default device for monitoring.
          const monitorGain = audioContext.createGain();
          monitorGain.gain.value = 0;
          monitorGainRef.current = monitorGain;
          const monitorDest = audioContext.createMediaStreamDestination();
          outputAnalyser.connect(monitorGain);
          monitorGain.connect(monitorDest);
          const monitorEl = new Audio();
          monitorEl.srcObject = monitorDest.stream;
          monitorElRef.current = monitorEl;
        }

        applyOutputGains();

        // Recorder tap. Chunks are cut on the audio thread, so a busy UI
        // thread can delay them but never drops samples from a take.
        const recProc = new AudioWorkletNode(audioContext, 'capture-processor', {
          ...mono,
          processorOptions: { chunkSize: 4096 },
        });
        recordProcessorRef.current = recProc;
        const recSink = audioContext.createGain();
        recSink.gain.value = 0;
        limiter.connect(recProc);
        recProc.connect(recSink);
        recSink.connect(audioContext.destination);
        recProc.port.onmessage = (event) => {
          if (!recordingRef.current || !(event.data instanceof Float32Array)) return;
          recordChunksRef.current.push(event.data);
          recordSamplesRef.current += event.data.length;
        };

        seqNumRef.current = 0;
        captureNode.port.onmessage = (event) => {
          const buffer = event.data;
          // Only stream to the server while its model is the active voice.
          if (buffer instanceof Float32Array && listenModeRef.current === 'rvc') {
            wsHook.sendAudio(buffer, seqNumRef.current++);
          }
        };

        wsHook.setOnAudioReceived((pcmData) => {
          if (playbackNodeRef.current) {
            playbackNodeRef.current.port.postMessage(pcmData);
          }
        });

        await audioContext.resume();
        animFrameRef.current = requestAnimationFrame(updateLevels);
        setIsRunning(true);
      } catch (err) {
        console.error('Failed to start audio pipeline:', err);
        stop();
        if (err.name === 'NotAllowedError') {
          throw new Error('Microphone permission denied. Allow mic access and try again.');
        }
        if (err.name === 'NotFoundError') {
          throw new Error('No microphone found.');
        }
        if (err.name === 'NotReadableError') {
          throw new Error('Microphone is in use by another app.');
        }
        throw err;
      }
    },
    [wsHook, updateLevels, applyOutputGains]
  );

  const finalizeRecording = useCallback(() => {
    recordingRef.current = false;
    setIsRecording(false);

    const chunks = recordChunksRef.current;
    const samples = recordSamplesRef.current;
    recordChunksRef.current = [];
    recordSamplesRef.current = 0;
    setRecordSeconds(0);

    if (!chunks.length || samples < 800) {
      setLastRecording((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return null;
      });
      return null;
    }

    const blob = encodeWav(chunks, sampleRateRef.current);
    const recording = {
      url: URL.createObjectURL(blob),
      seconds: samples / sampleRateRef.current,
      size: blob.size,
      mime: 'audio/wav',
      ext: 'wav',
    };
    setLastRecording((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return recording;
    });
    return recording;
  }, []);

  const startRecording = useCallback(() => {
    if (!isRunning && !audioContextRef.current) {
      throw new Error('Start the voice changer first, then press Record.');
    }
    if (recordingRef.current) return;
    recordChunksRef.current = [];
    recordSamplesRef.current = 0;
    recordingRef.current = true;
    setRecordSeconds(0);
    setIsRecording(true);
  }, [isRunning]);

  const stopRecording = useCallback(() => finalizeRecording(), [finalizeRecording]);

  const discardRecording = useCallback(() => {
    setLastRecording((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const stop = useCallback(() => {
    if (recordingRef.current) {
      finalizeRecording();
    }

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    const nodes = [
      sourceRef,
      gateNodeRef,
      captureNodeRef,
      captureSinkRef,
      playbackNodeRef,
      playbackGainRef,
      engineNodeRef,
      engineGainRef,
      speakerGainRef,
      monitorGainRef,
      inputAnalyserRef,
      outputAnalyserRef,
      recordProcessorRef,
    ];
    for (const ref of nodes) {
      try {
        ref.current?.disconnect();
      } catch { /* already disconnected */ }
    }

    if (monitorElRef.current) {
      monitorElRef.current.pause();
      monitorElRef.current.srcObject = null;
      monitorElRef.current = null;
    }
    monitorGainRef.current = null;
    sinkAppliedRef.current = false;
    setSendingToDevice(false);

    streamRef.current?.getTracks().forEach((track) => track.stop());
    audioContextRef.current?.close().catch(() => {});

    audioContextRef.current = null;
    captureSinkRef.current = null;
    streamRef.current = null;
    sourceRef.current = null;
    gateNodeRef.current = null;
    captureNodeRef.current = null;
    playbackNodeRef.current = null;
    playbackGainRef.current = null;
    engineNodeRef.current = null;
    engineGainRef.current = null;
    speakerGainRef.current = null;
    inputAnalyserRef.current = null;
    outputAnalyserRef.current = null;
    recordProcessorRef.current = null;
    setVoicePitchHz(0);
    setEngineLatencyMs(0);

    wsHook.setOnAudioReceived(null);
    setInputLevel(0);
    setOutputLevel(0);
    setGateOpen(false);
    setGateLevelDb(-80);
    setIsRunning(false);
  }, [wsHook, finalizeRecording]);

  const getAnalysers = useCallback(
    () => ({
      input: inputAnalyserRef.current,
      output: outputAnalyserRef.current,
    }),
    []
  );

  return {
    start,
    stop,
    isRunning,
    inputLevel,
    outputLevel,
    getAnalysers,
    isRecording,
    recordSeconds,
    lastRecording,
    startRecording,
    stopRecording,
    discardRecording,
    setEngineParams,
    getMedianPitch,
    voicePitchHz,
    engineLatencyMs,
    setGateParams,
    setListenMode,
    hearMyself,
    sendingToDevice,
    setCaptureOptions,
    setHearMyself,
    gateOpen,
    gateLevelDb,
  };
}
