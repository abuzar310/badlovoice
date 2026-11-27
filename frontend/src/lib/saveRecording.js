// Getting a finished take out of the page.
//
// A blob: download link only works in a real browser. Inside the Android / iOS
// apps the WebView ignores it and Android WebView has no Web Share API, so
// there the take is handed to native code, which opens the system share sheet.

// A multiple of 3 bytes, so every chunk is complete base64 and chunks concatenate.
const CHUNK_BYTES = 3 * 128 * 1024;

/**
 * How this device can save a take:
 * 'app' (Capacitor build), 'wrapper' (Expo WebView app), 'share' (Web Share on
 * a touch device, download still offered) or 'download'.
 */
export function saveMode() {
  try {
    if (window.Capacitor?.isNativePlatform?.()) return 'app';
    if (window.ReactNativeWebView?.postMessage && navigator.userAgent.includes('BadloVoiceExpo')) {
      return 'wrapper';
    }
    const probe = new File([''], 'take.wav', { type: 'audio/wav' });
    if (
      window.matchMedia('(pointer: coarse)').matches &&
      typeof navigator.share === 'function' &&
      navigator.canShare?.({ files: [probe] })
    ) {
      return 'share';
    }
  } catch {
    // Fall through to the plain link.
  }
  return 'download';
}

/** The take as a File. Read up front: Web Share must run inside the tap itself. */
export async function recordingFile(recording, name) {
  const blob = recording.blob || (await (await fetch(recording.url)).blob());
  return new File([blob], name, { type: recording.mime || 'audio/wav' });
}

function readBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Opens the share sheet for a take. Backing out of the sheet is not an error. */
export async function shareRecording(file, mode) {
  if (mode === 'share') {
    await navigator.share({ files: [file] }).catch((err) => {
      if (err?.name !== 'AbortError') throw err;
    });
    return;
  }

  const parts = Math.ceil(file.size / CHUNK_BYTES);
  const chunk = (part) => readBase64(file.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));

  if (mode === 'wrapper') {
    // mobile/App.js writes the parts to a file and opens the share sheet.
    for (let part = 0; part < parts; part += 1) {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'badlovoice-take', part, parts, data: await chunk(part) })
      );
    }
    return;
  }

  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const directory = Directory.Cache;
  const path = `takes/${file.name}`;
  // One take on disk at a time; the folder may not exist yet.
  await Filesystem.rmdir({ path: 'takes', directory, recursive: true }).catch(() => {});
  let uri;
  for (let part = 0; part < parts; part += 1) {
    const data = await chunk(part);
    if (part === 0) {
      ({ uri } = await Filesystem.writeFile({ path, directory, data, recursive: true }));
    } else {
      await Filesystem.appendFile({ path, directory, data });
    }
  }
  await Share.share({ files: [uri], dialogTitle: 'Share recording' }).catch((err) => {
    if (!/cancel/i.test(err?.message || '')) throw err;
  });
}
