import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { fetchConfig } from '../lib/api';
import useServerStatus from '../hooks/useServerStatus';
import { FIELD } from '../lib/ui';

const SAMPLE_RATE_OPTIONS = [32000, 40000, 44100, 48000];
const CHUNK_SIZE_OPTIONS = [1024, 2048, 4096, 8192];

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))].sort(
    (a, b) => a - b
  );
}

function describeRvc(torch) {
  if (!torch?.available) return "Not available. PyTorch isn't installed on the server.";
  if (torch.device === 'cpu') return 'Ready, on the CPU. Expect a second or more of delay.';
  return `Ready, on ${torch.gpuName || 'the graphics card'}.`;
}

function describeOnnx(onnx) {
  if (!onnx?.available) return "Not available. ONNX Runtime isn't installed on the server.";
  if (onnx.gpuEnabled) return 'Ready, on the graphics card.';
  const provider = (onnx.activeProvider || 'CPU').replace(/ExecutionProvider$/, '');
  return provider === 'CPU' ? 'Ready, on the CPU.' : `Ready, using ${provider}.`;
}

/**
 * The settings dialog. Everything in it belongs to the desktop server: how
 * audio is sent there, and what that server can run. The built-in engine picks
 * its own sample rate, so without a server there is nothing to set.
 */
export default function GlobalSettings({ config, onChange, disabled, onClose }) {
  const server = useServerStatus();
  const id = useId();
  const dialogRef = useRef(null);
  // What the server can run, asked fresh: undefined while loading, null if that failed.
  const [runtime, setRuntime] = useState();

  const sampleRateOptions = useMemo(
    () => uniqueSorted([config.sampleRate, ...SAMPLE_RATE_OPTIONS]),
    [config.sampleRate]
  );
  const chunkSizeOptions = useMemo(
    () => uniqueSorted([config.chunkSize, ...CHUNK_SIZE_OPTIONS]),
    [config.chunkSize]
  );
  const chunkMs = Math.round((config.chunkSize / config.sampleRate) * 1000);

  useEffect(() => {
    if (!server.online) return undefined;
    let current = true;
    fetchConfig()
      .then((answer) => current && setRuntime(answer?.runtime || null))
      .catch(() => current && setRuntime(null));
    return () => {
      current = false;
    };
  }, [server.online]);

  // Move focus into the dialog, and back to where it was on close.
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  return (
    <section
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      className="panel mx-auto w-full max-w-2xl p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id={`${id}-title`} className="panel-title text-lg">
          Settings
        </h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="chip-button px-2.5"
            aria-label="Close settings"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        ) : null}
      </div>

      {server.state === 'checking' && (
        <div
          className="mt-4 h-16 animate-pulse rounded-xl bg-ink/7 motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}

      {server.offline && (
        <>
          <p className="mt-3 max-w-[65ch] text-pretty text-sm text-muted">
            These settings are for the BadloVoice desktop server, which runs AI voice models.{' '}
            {server.state === 'unreachable'
              ? "It can't be reached right now."
              : "This page isn't connected to one."}{' '}
            The built-in voices and effects set themselves up, so there is nothing to change here.
          </p>
          {server.state === 'unreachable' && (
            <button
              type="button"
              className="chip-button mt-4"
              disabled={server.rechecking}
              onClick={server.recheck}
            >
              {server.rechecking ? 'Checking…' : 'Check again'}
            </button>
          )}
        </>
      )}

      {server.online && (
        <>
          <h3 className="mt-5 text-sm font-semibold text-ink">Audio sent to the server</h3>
          <p className="mt-1 text-xs text-muted">
            {disabled
              ? 'Stop the voice changer to change these.'
              : 'Saved on this device and used from the next time you press Start.'}
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-rate`} className="field-label block">
                Sample rate
              </label>
              <select
                id={`${id}-rate`}
                value={config.sampleRate}
                onChange={(event) => onChange?.({ sampleRate: Number(event.target.value) })}
                disabled={disabled}
                className={`${FIELD} native-select-safe mt-1`}
              >
                {sampleRateOptions.map((value) => (
                  <option key={value} value={value}>
                    {value.toLocaleString()} Hz
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted">Higher is clearer and takes more computing power.</p>
            </div>

            <div>
              <label htmlFor={`${id}-chunk`} className="field-label block">
                Chunk size
              </label>
              <select
                id={`${id}-chunk`}
                value={config.chunkSize}
                onChange={(event) => onChange?.({ chunkSize: Number(event.target.value) })}
                disabled={disabled}
                className={`${FIELD} native-select-safe mt-1`}
              >
                {chunkSizeOptions.map((value) => (
                  <option key={value} value={value}>
                    {value.toLocaleString()} samples
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted">
                About {chunkMs} ms of sound at a time. Smaller means less delay; too small can
                crackle.
              </p>
            </div>
          </div>

          {runtime !== null && (
            <>
              <h3 className="mt-6 text-sm font-semibold text-ink">What the server can run</h3>
              {runtime === undefined ? (
                <div
                  className="mt-2 h-12 animate-pulse rounded-xl bg-ink/7 motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                  <dt className="font-medium text-ink">RVC models (.pth)</dt>
                  <dd className="text-muted">{describeRvc(runtime.torch)}</dd>
                  <dt className="font-medium text-ink">ONNX models (.onnx)</dt>
                  <dd className="text-muted">{describeOnnx(runtime.onnx)}</dd>
                </dl>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
