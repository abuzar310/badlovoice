import React, { useEffect, useMemo, useState } from 'react';
import { recordingFile, saveMode, shareRecording } from '../lib/saveRecording';

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Records the mixed output (local pitch monitor + server return).
 * Requires Start first — Record alone does nothing on purpose.
 */
export default function Recorder({ pipeline, onEnsureStarted, compact = false }) {
  const { isRunning, isRecording, recordSeconds, lastRecording } = pipeline;
  const [hint, setHint] = useState(null);
  const [take, setTake] = useState(null);
  const [sharing, setSharing] = useState(false);
  // A blob: download link does nothing inside the Android / iOS apps.
  const mode = useMemo(saveMode, []);
  const canDownload = mode === 'download' || mode === 'share';
  const savedHint = mode === 'download' ? 'Saved — download below.' : 'Saved — share it below.';

  useEffect(() => {
    setTake(null);
    if (!lastRecording) return undefined;
    let stale = false;
    recordingFile(lastRecording, `badlovoice-${Date.now()}.wav`)
      .then((file) => {
        if (!stale) setTake(file);
      })
      .catch(() => {
        if (!stale && !canDownload) setHint('Could not read the take — record it again.');
      });
    return () => {
      stale = true;
    };
  }, [lastRecording, canDownload]);

  const handleShare = async () => {
    setHint(null);
    setSharing(true);
    try {
      await shareRecording(take, mode);
    } catch (err) {
      setHint(
        canDownload
          ? 'Could not open the share sheet — use Download instead.'
          : `Could not share the take: ${err?.message || 'unknown error'}`
      );
    } finally {
      setSharing(false);
    }
  };

  const handleRecord = async () => {
    setHint(null);
    try {
      if (!isRunning) {
        if (!onEnsureStarted) {
          setHint('Tap Start first, then Record.');
          return;
        }
        setHint('Starting…');
        await onEnsureStarted();
      }
      pipeline.startRecording();
      setHint('Recording — talk, then tap Stop.');
    } catch (err) {
      setHint(err.message || 'Could not start recording');
    }
  };

  const handleStop = () => {
    const result = pipeline.stopRecording();
    if (result && typeof result.then === 'function') {
      result.then((rec) => {
        setHint(rec ? savedHint : 'Empty take — talk longer, then try again.');
      });
      return;
    }
    setHint(result ? savedHint : 'Empty take — talk longer, then try again.');
  };

  const downloadRow = lastRecording ? (
    <div
      className={`${compact ? 'mt-3' : 'mt-4'} rounded-2xl border border-[color:var(--line)] bg-[color:var(--surface-2)]/50 p-3.5`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[color:var(--muted)]">
          Last take · {formatDuration(lastRecording.seconds)} · {formatSize(lastRecording.size)}
        </p>
        <div className={`flex items-center gap-2 ${mode === 'share' ? 'flex-wrap' : ''}`}>
          {mode !== 'download' ? (
            <button
              type="button"
              onClick={handleShare}
              disabled={!take || sharing}
              className="chip-button min-h-10 !text-[color:var(--ink-text)]"
            >
              Share
            </button>
          ) : null}
          {canDownload ? (
            <a
              href={lastRecording.url}
              download={take?.name || 'badlovoice.wav'}
              className="chip-button !normal-case min-h-10"
            >
              Download WAV
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => pipeline.discardRecording()}
            className="chip-button min-h-10 !px-2.5"
            aria-label="Discard recording"
          >
            Clear
          </button>
        </div>
      </div>
      <audio
        controls
        controlsList={canDownload ? undefined : 'nodownload'}
        src={lastRecording.url}
        className="mt-3 h-9 w-full"
      />
    </div>
  ) : null;

  if (compact) {
    return (
      <section className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-[color:var(--ink-text)]">Record</p>
          {isRecording ? (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-2 font-mono text-sm tabular-nums text-[color:var(--danger-soft)]">
                <span className="rec-blink inline-block h-2.5 w-2.5 rounded-full bg-[color:var(--danger)]" />
                {formatDuration(recordSeconds)}
              </span>
              <button type="button" onClick={handleStop} className="btn-secondary-danger">
                Stop
              </button>
            </div>
          ) : (
            <button type="button" onClick={handleRecord} className="btn-record">
              {isRunning ? 'Record' : 'Start + Record'}
            </button>
          )}
        </div>
        {hint ? (
          <p className="mt-2 text-xs text-[color:var(--accent-soft)]" role="status">
            {hint}
          </p>
        ) : null}
        {downloadRow}
      </section>
    );
  }

  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="panel-kicker">Recorder</p>
          <h2 className="panel-title">Capture output</h2>
        </div>

        {isRecording ? (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 font-mono text-sm tabular-nums text-[color:var(--danger-soft)]">
              <span className="rec-blink inline-block h-2.5 w-2.5 rounded-full bg-[color:var(--danger)]" />
              {formatDuration(recordSeconds)}
            </span>
            <button type="button" onClick={handleStop} className="btn-secondary-danger">
              Stop
            </button>
          </div>
        ) : (
          <button type="button" onClick={handleRecord} className="btn-record">
            {isRunning ? 'Record' : 'Start + Record'}
          </button>
        )}
      </div>

      <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs text-[color:var(--muted)]">
        <li>Wear headphones</li>
        <li>
          Press <strong className="text-[color:var(--ink-text)]">Start</strong> (or Start + Record)
        </li>
        <li>Talk, then Stop — {mode === 'download' ? 'download WAV' : 'share the take'} here</li>
      </ol>

      {hint ? (
        <p className="mt-2 text-xs text-[color:var(--accent-soft)]" role="status">
          {hint}
        </p>
      ) : null}
      {downloadRow}
    </section>
  );
}
