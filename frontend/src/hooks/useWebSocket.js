import { useEffect, useRef, useState } from 'react';
import { WS_URL, SAMPLE_RATE, CHUNK_SIZE } from '../lib/constants';
import { checkServer, getServerState, subscribeServerState } from '../lib/api';

// Frame layout, both directions (see backend/services/audio_processor.py):
//   bytes 0-3  uint32 sequence number, little-endian
//   bytes 4-7  uint32, little-endian: 0 from the client; the server's
//              processing time in hundredths of a millisecond on the way back
//   bytes 8-   float32 PCM samples, little-endian
const HEADER_BYTES = 8;

// Several frames may be on their way at once; the rest wait in a short queue
// whose oldest entries are dropped, so a slow server costs audio, not memory.
const MAX_IN_FLIGHT = 6;
const MAX_PENDING = 12;
// A frame unanswered for this long no longer holds a place in the window.
const ANSWER_TIMEOUT_MS = 20000;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REPORT_EVERY_MS = 250;

const NO_STATS = { modelMs: 0, dspMs: 0, mode: 'dsp', activeModel: null, effectsActive: 0 };

/**
 * The connection itself, outside React. `report` carries its state back in.
 *
 * A socket is only opened while the API layer says a server is there. On a
 * static host or in the phone app there is none, and a failed WebSocket puts
 * an error in the console that cannot be silenced, so it is never tried.
 */
function createLink(report) {
  let ws = null;
  let wanted = false; // connect() called and not undone by disconnect()
  let mounted = false;
  let retryTimer = null;
  let retryDelay = RECONNECT_MIN_MS;
  let streamConfig = {}; // the sample rate and chunk size last sent
  let onAudio = null;
  let onMessage = null;
  let onOpen = null;

  const inFlight = new Map(); // sequence number -> when its audio was captured
  let pending = []; // { seq, at, samples } waiting for a place in the window
  let latency = 0;
  let lastReport = 0;

  function resetStream() {
    inFlight.clear();
    pending = [];
    latency = 0;
    lastReport = 0;
    report.latency(0);
    report.serverMs(0);
  }

  function transmit({ seq, at, samples }) {
    const packet = new ArrayBuffer(HEADER_BYTES + samples.byteLength);
    const header = new DataView(packet);
    header.setUint32(0, seq >>> 0, true);
    header.setUint32(4, 0, true);
    new Float32Array(packet, HEADER_BYTES).set(samples);
    inFlight.set(seq >>> 0, at);
    ws.send(packet);
  }

  function flush() {
    while (pending.length && inFlight.size < MAX_IN_FLIGHT) transmit(pending.shift());
  }

  function sendAudio(samples, seq) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const at = performance.now();
    if (inFlight.size >= MAX_IN_FLIGHT) {
      for (const [key, sentAt] of inFlight) {
        if (at - sentAt > ANSWER_TIMEOUT_MS) inFlight.delete(key);
      }
    }
    // Latency is timed from here, so time spent queued counts too.
    if (inFlight.size < MAX_IN_FLIGHT) {
      transmit({ seq, at, samples });
      return;
    }
    pending.push({ seq, at, samples: samples.slice() });
    if (pending.length > MAX_PENDING) pending.shift();
  }

  function receiveAudio(data) {
    const bodyBytes = data.byteLength - HEADER_BYTES;
    if (bodyBytes < 0 || bodyBytes % 4 !== 0) return; // not a whole frame

    const header = new DataView(data);
    const seq = header.getUint32(0, true);
    const serverMs = header.getUint32(4, true) / 100;
    const now = performance.now();

    const capturedAt = inFlight.get(seq);
    if (capturedAt !== undefined) {
      inFlight.delete(seq);
      const roundTrip = now - capturedAt;
      latency = latency ? latency + (roundTrip - latency) * 0.2 : roundTrip;
    }
    if (now - lastReport > REPORT_EVERY_MS) {
      lastReport = now;
      report.latency(latency);
      report.serverMs(serverMs);
    }

    flush();
    onAudio?.(new Float32Array(data, HEADER_BYTES), seq);
  }

  function receiveText(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.type === 'status') {
      report.stats({
        modelMs: message.model_ms ?? 0,
        dspMs: message.dsp_ms ?? 0,
        mode: message.mode ?? 'dsp',
        activeModel: message.active_model ?? null,
        effectsActive: message.effects_active ?? 0,
      });
    }
    onMessage?.(message);
  }

  // An idle tab in the background does not need the server. One that is
  // streaming does: that is the voice someone is listening to.
  const mayDial = () =>
    mounted && wanted && !ws && getServerState() === 'online' && (!document.hidden || onAudio);

  function dial() {
    if (!mayDial()) return;
    clearTimeout(retryTimer);

    let socket;
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      scheduleRetry();
      return;
    }
    socket.binaryType = 'arraybuffer';
    ws = socket;
    report.status('connecting');

    // Every handler checks it still belongs to the current socket, so one
    // that was replaced or dropped cannot touch the state of its successor.
    socket.onopen = () => {
      if (ws !== socket) return;
      retryDelay = RECONNECT_MIN_MS;
      resetStream();
      socket.send(
        JSON.stringify({
          sample_rate: streamConfig.sample_rate ?? SAMPLE_RATE,
          chunk_size: streamConfig.chunk_size ?? CHUNK_SIZE,
        })
      );
      report.status('connected');
      // Let the app push its full current settings (pitch, effects, ...).
      onOpen?.();
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      if (event.data instanceof ArrayBuffer) receiveAudio(event.data);
      else if (typeof event.data === 'string') receiveText(event.data);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      resetStream();
      report.stats(NO_STATS);
      report.status('disconnected');
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!mounted || !wanted) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
    retryTimer = setTimeout(async () => {
      // Ask over HTTP first. If the server is gone this stops here, and the
      // subscription below dials again once it is back.
      if ((await checkServer()) === 'online') dial();
    }, delay);
  }

  function drop() {
    clearTimeout(retryTimer);
    const socket = ws;
    ws = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
    resetStream();
    report.stats(NO_STATS);
    report.status('disconnected');
  }

  return {
    connect() {
      wanted = true;
      retryDelay = RECONNECT_MIN_MS;
      dial();
    },
    disconnect() {
      wanted = false;
      drop();
    },
    sendAudio,
    sendSettings(settings) {
      // Remembered so that a reconnect tells the server the same thing.
      if (settings?.sample_rate) streamConfig.sample_rate = settings.sample_rate;
      if (settings?.chunk_size) streamConfig.chunk_size = settings.chunk_size;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'settings', ...settings }));
    },
    setOnAudioReceived(callback) {
      onAudio = callback;
    },
    setOnSettingsResponse(callback) {
      onMessage = callback;
    },
    setOnOpen(callback) {
      onOpen = callback;
    },
    /** Starts following the server and the tab; returns the cleanup. */
    mount() {
      mounted = true;
      const unsubscribe = subscribeServerState(dial);
      document.addEventListener('visibilitychange', dial);
      return () => {
        mounted = false;
        unsubscribe();
        document.removeEventListener('visibilitychange', dial);
        drop();
      };
    },
  };
}

/**
 * The realtime audio connection to the desktop server.
 *
 * `status` is 'disconnected' | 'connecting' | 'connected'. `connect()` means
 * "stay connected whenever a server is there"; without one, status simply
 * stays 'disconnected'. `latency` is the smoothed round trip of a chunk in ms,
 * from capture to its return; `serverMs` is the server's share of that.
 */
export default function useWebSocket() {
  const [status, setStatus] = useState('disconnected');
  const [latency, setLatency] = useState(0);
  const [serverMs, setServerMs] = useState(0);
  const [serverStats, setServerStats] = useState(NO_STATS);

  const linkRef = useRef(null);
  if (!linkRef.current) {
    linkRef.current = createLink({
      status: setStatus,
      latency: setLatency,
      serverMs: setServerMs,
      stats: setServerStats,
    });
  }
  const link = linkRef.current;

  useEffect(() => link.mount(), [link]);

  return {
    status,
    connect: link.connect,
    disconnect: link.disconnect,
    sendAudio: link.sendAudio,
    sendSettings: link.sendSettings,
    setOnAudioReceived: link.setOnAudioReceived,
    setOnSettingsResponse: link.setOnSettingsResponse,
    setOnOpen: link.setOnOpen,
    latency,
    serverMs,
    serverStats,
  };
}
