import { useCallback, useEffect, useRef, useState } from 'react';

// Chrome lists the system default (and on Windows the "communications" device)
// a second time under these ids. The pickers have their own "Default" entry.
const ALIAS_IDS = new Set(['default', 'communications']);

// The voice is played through an AudioContext, and only some browsers can
// point one at a chosen speaker. Elsewhere a speaker picker would do nothing.
const canPickOutput = () =>
  typeof window.AudioContext?.prototype?.setSinkId === 'function';

const NO_MEDIA = window.isSecureContext
  ? "This browser can't use a microphone."
  : 'The microphone only works on https or on localhost. Open BadloVoice from one of those.';

function micProblem(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return "The microphone is blocked. Allow it in the browser's site settings, then try again.";
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
    return 'No microphone found. Plug one in, then try again.';
  }
  if (err?.name === 'NotReadableError' || err?.name === 'AbortError') {
    return 'The microphone is in use by another app. Close that app, then try again.';
  }
  return "Couldn't open the microphone.";
}

// Plain objects with a label that is always usable: browsers hide the real
// names until the microphone has been allowed once.
function pick(devices, kind, fallback) {
  return devices
    .filter((device) => device.kind === kind && device.deviceId && !ALIAS_IDS.has(device.deviceId))
    .map((device, i) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      kind: device.kind,
      label: device.label || `${fallback} ${i + 1}`,
      named: Boolean(device.label),
    }));
}

/**
 * The microphones and speakers the user can choose from.
 *
 * `refresh()` re-reads the list and, if the browser is still hiding device
 * names, asks for the microphone once to unlock them. It never throws; a
 * problem ends up in `error` as a sentence that can be shown as it is.
 * `outputDevices` is empty where the browser cannot switch speakers.
 */
export default function useAudioDevices() {
  const [inputDevices, setInputDevices] = useState([]);
  const [outputDevices, setOutputDevices] = useState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasLabels, setHasLabels] = useState(false);
  const [permissionState, setPermissionState] = useState('prompt');
  const [error, setError] = useState(null);

  const mountedRef = useRef(true);
  const latestRef = useRef(0);

  /** Reads the device list. Resolves to whether real names were available. */
  const enumerate = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError(NO_MEDIA);
      return false;
    }
    const turn = ++latestRef.current;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = pick(devices, 'audioinput', 'Microphone');
      const named = inputs.some((device) => device.named);
      // A newer read (a device was just plugged in, say) wins over this one.
      if (mountedRef.current && turn === latestRef.current) {
        setInputDevices(inputs);
        setOutputDevices(canPickOutput() ? pick(devices, 'audiooutput', 'Speaker') : []);
        setHasLabels(named);
      }
      return named;
    } catch {
      setError("Couldn't read the list of microphones.");
      return false;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(NO_MEDIA);
      return;
    }
    setIsRefreshing(true);
    setError(null);
    try {
      // Opening the mic only to learn its name is slow and makes headsets
      // click, so do it just once: when the names are still hidden.
      if (await enumerate()) return;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (err?.name === 'NotAllowedError') setPermissionState('denied');
        setError(micProblem(err));
        return;
      }
      setPermissionState('granted');
      await enumerate();
      stream.getTracks().forEach((track) => track.stop());
    } finally {
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, [enumerate]);

  // On mount, read the list without asking for anything; names may be hidden.
  // Then keep it current as devices come and go and as permission changes.
  useEffect(() => {
    mountedRef.current = true;
    enumerate();

    const media = navigator.mediaDevices;
    media?.addEventListener?.('devicechange', enumerate);

    let watching = true;
    let permission = null;
    const onPermission = () => {
      setPermissionState(permission.state);
      enumerate();
    };
    // Not every browser knows 'microphone' here; the list works without it.
    navigator.permissions
      ?.query({ name: 'microphone' })
      .then((status) => {
        if (!watching) return;
        permission = status;
        setPermissionState(status.state);
        status.addEventListener('change', onPermission);
      })
      .catch(() => {});

    return () => {
      watching = false;
      mountedRef.current = false;
      media?.removeEventListener?.('devicechange', enumerate);
      permission?.removeEventListener('change', onPermission);
    };
  }, [enumerate]);

  return {
    inputDevices,
    outputDevices,
    refresh,
    isRefreshing,
    hasLabels,
    permissionState,
    error,
  };
}
