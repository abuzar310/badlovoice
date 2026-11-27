import { API_BASE } from './constants.js';

// The same build runs beside the desktop server, on a static host and inside
// the phone app. On the last two there is no API: a request comes back as the
// app's own HTML page, as a 404, or not at all. So "is there a server?" is
// worked out once, here, and every panel reads the answer instead of failing
// on its own.
//
//   checking     nothing has answered yet
//   online       the server answered, even if with an error
//   unreachable  nothing answered; it may still be starting, so keep checking
//   none         this address serves no API at all; stop asking
const RECHECK_MIN_MS = 5000;
const RECHECK_MAX_MS = 30000;

let serverState = 'checking';
let firstAnswer = null; // the request everyone waits on while 'checking'
let serverCheck = null; // a checkServer() already under way
let recheckDelay = RECHECK_MIN_MS;
let recheckAt = 0;
let recheckTimer = null;
const stateListeners = new Set();
const modelListeners = new Set();

const isHidden = () => typeof document !== 'undefined' && document.hidden;

function armRecheck() {
  clearTimeout(recheckTimer);
  if (serverState !== 'unreachable' || stateListeners.size === 0) return;
  recheckTimer = setTimeout(() => {
    // A hidden tab stays quiet; coming back to it re-arms the timer.
    if (!isHidden()) checkServer();
  }, Math.max(0, recheckAt - Date.now()));
}

function setServerState(next) {
  if (next !== 'unreachable') {
    recheckDelay = RECHECK_MIN_MS;
  } else if (serverState !== 'unreachable' || Date.now() >= recheckAt) {
    // Wait longer after each miss. Several failures in one burst count once.
    recheckAt = Date.now() + recheckDelay;
    recheckDelay = Math.min(recheckDelay * 2, RECHECK_MAX_MS);
  }
  const changed = next !== serverState;
  serverState = next;
  armRecheck();
  if (changed) stateListeners.forEach((listener) => listener());
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) armRecheck();
  });
}

export function getServerState() {
  return serverState;
}

/** Calls `listener` whenever the server state changes. Returns an unsubscribe function. */
export function subscribeServerState(listener) {
  stateListeners.add(listener);
  // Whoever is watching must get an answer, even if nothing else asked yet.
  if (serverState === 'checking' && !firstAnswer) checkServer();
  else armRecheck();
  return () => {
    stateListeners.delete(listener);
    if (stateListeners.size === 0) clearTimeout(recheckTimer);
  };
}

/** Asks the server right now, whatever the last answer was. Resolves to the new state. */
export function checkServer() {
  if (!serverCheck) {
    serverCheck = request('/config', { force: true })
      .catch(() => {})
      .then(() => {
        serverCheck = null;
        return serverState;
      });
  }
  return serverCheck;
}

/** Calls `listener` after a model file was added or deleted. Returns an unsubscribe function. */
export function onModelsChanged(listener) {
  modelListeners.add(listener);
  return () => modelListeners.delete(listener);
}

const modelsChanged = () => modelListeners.forEach((listener) => listener());

// --- Errors ----------------------------------------------------------------
// Every message here can be shown to the user as it is.

const NO_SERVER =
  "This needs the BadloVoice desktop server, and this page isn't connected to one.";
const UNREACHABLE =
  "Can't reach the BadloVoice server. Check that it's still running, then try again.";
const TOO_SLOW = 'The server took too long to answer. Try again.';
const SERVER_FAILED =
  'The server ran into a problem. Try again. If it keeps happening, the server window shows why.';

export class ApiError extends Error {
  constructor(message, { status = 0, data = null, offline = false, cancelled = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    /** True when there was no server to talk to, as opposed to the server saying no. */
    this.offline = offline;
    this.cancelled = cancelled;
  }
}

const offlineError = (state = serverState, status = 0) =>
  new ApiError(state === 'none' ? NO_SERVER : UNREACHABLE, { status, offline: true });

// The server explains itself as {detail: "..."}, or a list of {msg} for bad input.
function detailOf(data) {
  const detail = data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => item?.msg).filter(Boolean);
    if (parts.length) return parts.join('. ');
  }
  return null;
}

/**
 * Works out who answered and what they said. The server always speaks JSON,
 * so anything else came from whatever stands where the server should be.
 * Returns the parsed body, or throws an ApiError.
 */
function readAnswer(status, text) {
  const ok = status >= 200 && status < 300;
  const empty = !text || !text.trim();
  let data = null;
  let parsed = false;
  if (!empty) {
    try {
      data = JSON.parse(text);
      parsed = true;
    } catch {
      // Not JSON: an HTML page or a bare error from a proxy.
    }
  }

  // Its errors always carry `detail`; other JSON errors are someone else's.
  const ours = parsed && (ok || (data !== null && typeof data === 'object' && 'detail' in data));
  if (ours || (ok && empty)) {
    setServerState('online');
    if (ok) return data;
    throw new ApiError(detailOf(data) || SERVER_FAILED, { status, data });
  }
  // A proxy with nothing behind it: gateway errors, or the dev proxy's empty 500.
  if ((status >= 502 && status <= 504) || (status === 500 && empty)) {
    setServerState('unreachable');
    throw offlineError('unreachable', status);
  }
  // The server itself fell over and answered in plain text.
  if (status === 500) {
    setServerState('online');
    throw new ApiError(SERVER_FAILED, { status });
  }
  // The app's own page, or a "not found" from a static host.
  setServerState('none');
  throw offlineError('none', status);
}

// --- Transport -------------------------------------------------------------

const QUICK_MS = 8000; // reads
const WRITE_MS = 20000; // small writes
const MODEL_LOAD_MS = 5 * 60000; // activating a model loads it into memory

async function request(
  path,
  { method = 'GET', body, timeout = method === 'GET' ? QUICK_MS : WRITE_MS, force = false, as = 'json' } = {}
) {
  // Background reads never chase a server that is known to be missing.
  // Anything the user asked for (a write, or `force`) always goes out.
  if (method === 'GET' && !force) {
    if (serverState === 'checking' && firstAnswer) await firstAnswer;
    const waiting = serverState === 'unreachable' && (Date.now() < recheckAt || isHidden());
    if (serverState === 'none' || waiting) throw offlineError();
  }

  let answered = null;
  if (serverState === 'checking' && !firstAnswer) {
    firstAnswer = new Promise((resolve) => {
      answered = resolve;
    });
  }

  const controller = new AbortController();
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      body,
      headers: typeof body === 'string' ? { 'Content-Type': 'application/json' } : undefined,
      signal: controller.signal,
    });
    const type = response.headers.get('content-type') || '';
    if (as === 'blob' && response.ok && /^(audio\/|application\/octet-stream)/.test(type)) {
      const blob = await response.blob();
      setServerState('online');
      return blob;
    }
    return readAnswer(response.status, await response.text());
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError') {
      // A slow answer does not mean a known server is gone: loading a model
      // keeps it busy for a while. Anything else has still not answered.
      if (serverState !== 'online') setServerState('unreachable');
      throw new ApiError(TOO_SLOW);
    }
    setServerState('unreachable');
    throw offlineError('unreachable');
  } finally {
    clearTimeout(timer);
    if (answered) {
      firstAnswer = null;
      answered();
    }
  }
}

const json = (value) => JSON.stringify(value);

// --- Models ----------------------------------------------------------------

export function fetchModels() {
  return request('/models/');
}

/**
 * Uploads one model file. `onProgress` gets 0..1 as the bytes go out;
 * aborting `signal` cancels the upload.
 */
export function uploadModel(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    // XMLHttpRequest rather than fetch: only it reports upload progress.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/models/upload`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      try {
        const saved = readAnswer(xhr.status, xhr.responseText);
        modelsChanged();
        resolve(saved);
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => {
      setServerState('unreachable');
      reject(offlineError('unreachable'));
    };
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', { cancelled: true }));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

export async function deleteModel(name) {
  const result = await request(`/models/${encodeURIComponent(name)}`, { method: 'DELETE' });
  modelsChanged();
  return result;
}

export function activateModel(name) {
  return request(`/models/${encodeURIComponent(name)}/activate`, {
    method: 'POST',
    timeout: MODEL_LOAD_MS,
  });
}

export function deactivateModel() {
  return request('/models/deactivate', { method: 'POST' });
}

export function getActiveModel() {
  return request('/models/active');
}

export function fetchConfig() {
  return request('/config');
}

// --- Slots -----------------------------------------------------------------

export function fetchSlots() {
  return request('/slots/');
}

export function bindSlot(index, name, label = null) {
  return request(`/slots/${index}`, { method: 'PUT', body: json({ name, label }) });
}

export function activateSlot(index) {
  return request(`/slots/${index}/activate`, { method: 'POST', timeout: MODEL_LOAD_MS });
}

// --- Profiles and presets --------------------------------------------------

export function fetchLatencyModes() {
  return request('/profiles/latency-modes');
}

export function fetchProfiles() {
  return request('/profiles/');
}

export function saveProfile(name, settings) {
  return request('/profiles/', { method: 'POST', body: json({ name, settings }) });
}

export function deleteProfile(profileId) {
  return request(`/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
}

export function fetchPresets() {
  return request('/presets/');
}

export function savePreset(name, settings, emoji = '⭐') {
  return request('/presets/', { method: 'POST', body: json({ name, settings, emoji }) });
}

export function deletePreset(presetId) {
  return request(`/presets/${encodeURIComponent(presetId)}`, { method: 'DELETE' });
}

// --- File conversion -------------------------------------------------------

/** Returns a WAV Blob of the converted audio. */
export function convertFile(
  file,
  { pitchShift = 0, formantShift = 0, f0Method = 'pm', effects = {}, useModel = true } = {}
) {
  const form = new FormData();
  form.append('file', file);
  form.append('pitch_shift', String(pitchShift));
  form.append('formant_shift', String(formantShift));
  form.append('f0_method', f0Method);
  form.append('effects', json(effects));
  form.append('use_model', String(useModel));
  // No time limit: a long file through a model on a CPU can take many minutes.
  return request('/convert/', { method: 'POST', body: form, timeout: 0, as: 'blob' });
}
