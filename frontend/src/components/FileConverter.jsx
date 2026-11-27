import React, { useState } from 'react';
import { convertFile } from '../lib/api';
import { countActiveEffects } from '../lib/effects';
import { renderFileLocally } from '../lib/voiceEngine';

const ACCEPTED = '.wav,.mp3,.flac,.ogg,.m4a,.aiff,audio/*';

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function signed(value) {
  const n = Number(value) || 0;
  return `${n > 0 ? '+' : ''}${n}`;
}

// Converts a whole audio file with the current Studio voice. Without an AI
// model the file is rendered here in the browser by the built-in engine (works
// on the hosted site and in the Android app). With a model active it can go
// through the server instead.
export default function FileConverter({ voice, effects, activeModel, gate }) {
  const [file, setFile] = useState(null);
  const [useModel, setUseModel] = useState(true);
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState(null); // {url, name, size}
  const [error, setError] = useState(null);
  const [dragActive, setDragActive] = useState(false);

  const fxCount = countActiveEffects(effects, voice.formant);
  const viaModel = useModel && Boolean(activeModel);

  const pickFile = (candidate) => {
    if (!candidate) return;
    setFile(candidate);
    setError(null);
    setResult((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  const handleConvert = async () => {
    if (!file || converting) return;
    setConverting(true);
    setError(null);
    try {
      const blob = viaModel
        ? await convertFile(file, {
            pitchShift: voice.pitch,
            formantShift: voice.formant,
            f0Method: voice.f0Method,
            effects,
            useModel: true,
          })
        : await renderFileLocally(file, {
            pitch: Number(voice.pitch) || 0,
            formant: Number(voice.formant) || 0,
            effects,
            gate,
          });
      const name = `${file.name.replace(/\.[^.]+$/, '')}_converted.wav`;
      setResult((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(blob), name, size: blob.size };
      });
    } catch (err) {
      setError(err.message || 'Could not convert that file.');
    } finally {
      setConverting(false);
    }
  };

  return (
    <section className="panel p-5 sm:p-6">
      <p className="text-sm text-[color:var(--muted)]">
        Voice in use: pitch {signed(voice.pitch)} st, formant {signed(voice.formant)} st,{' '}
        {fxCount} effect{fxCount === 1 ? '' : 's'}
        {viaModel ? `, AI model ${activeModel}` : ''}. Change it on the Studio tab.
      </p>

      <label
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          pickFile(event.dataTransfer.files?.[0]);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        className={`mt-4 block cursor-pointer rounded-2xl border border-dashed p-8 text-center transition-colors duration-200 focus-within:border-[color:var(--accent)] focus-within:ring-2 focus-within:ring-[color:var(--accent)]/30 ${
          dragActive
            ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 drag-active'
            : 'border-[color:var(--ink-text)]/25 bg-[color:var(--surface)] hover:border-[color:var(--ink-text)]/45'
        }`}
      >
        <input
          type="file"
          accept={ACCEPTED}
          onChange={(event) => {
            pickFile(event.target.files?.[0]);
            event.target.value = '';
          }}
          className="sr-only"
        />
        <svg
          className="mx-auto mb-3 h-9 w-9 text-[color:var(--muted)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
        {file ? (
          <>
            <span className="block break-all text-sm font-medium text-[color:var(--ink-text)]">
              {file.name}
            </span>
            <span className="mt-1 block text-xs text-[color:var(--muted)]">
              {formatSize(file.size)} · choose another file
            </span>
          </>
        ) : (
          <>
            <span className="block text-sm font-medium text-[color:var(--ink-text)]">
              {dragActive ? 'Drop the file here' : 'Choose an audio file, or drop one here'}
            </span>
            <span className="mt-1 block text-xs text-[color:var(--muted)]">
              WAV, MP3, M4A, OGG or FLAC
            </span>
          </>
        )}
      </label>

      <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {activeModel ? (
          <label className="flex items-center gap-2.5 text-sm text-[color:var(--ink-text)]">
            <input
              type="checkbox"
              checked={useModel}
              onChange={(event) => setUseModel(event.target.checked)}
              className="h-4 w-4 accent-[color:var(--accent)]"
            />
            <span className="min-w-0 break-words">Use the AI model ({activeModel})</span>
          </label>
        ) : (
          <p className="text-sm text-[color:var(--muted)]">Converts on this device. Nothing is uploaded.</p>
        )}

        <button
          type="button"
          onClick={handleConvert}
          disabled={!file || converting}
          className="btn-primary sm:w-auto sm:min-w-[12rem]"
        >
          {converting ? 'Converting…' : 'Convert file'}
        </button>
      </div>

      {converting && viaModel && (
        <p className="mt-3 text-xs text-[color:var(--muted)]" role="status">
          Long files take a while: the whole file runs through the model on the server.
        </p>
      )}

      {error && (
        <div
          className="mt-4 rounded-2xl border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/10 p-3.5"
          role="alert"
        >
          <p className="text-sm text-[color:var(--danger-soft)]">{error}</p>
        </div>
      )}

      {result && (
        <div className="mt-5 rounded-2xl border border-[color:var(--success)]/35 bg-[color:var(--success)]/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 break-all text-sm font-medium text-[color:var(--ink-text)]">
              {result.name}{' '}
              <span className="text-xs font-normal text-[color:var(--muted)]">
                {formatSize(result.size)}
              </span>
            </p>
            <a href={result.url} download={result.name} className="chip-button !text-[color:var(--ink-text)]">
              Download WAV
            </a>
          </div>
          <audio controls src={result.url} className="mt-3 h-10 w-full" />
        </div>
      )}
    </section>
  );
}
