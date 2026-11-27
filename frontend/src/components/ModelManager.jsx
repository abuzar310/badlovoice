import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchModels,
  uploadModel,
  deleteModel,
  activateModel,
  deactivateModel,
} from '../lib/api';
import useServerStatus from '../hooks/useServerStatus';
import { ALERT, BADGE_ON, NOTE } from '../lib/ui';

const MODEL_FILE = /\.(onnx|pth|pt|index)$/i;
const SETUP_URL = 'https://github.com/abuzar310/badlovoice#quick-start';

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

// "RVC · 54.2 MB · index file · v2 · 40 kHz · on GPU"
function describeModel(model) {
  const { details } = model;
  const kind = model.type === 'onnx' || /\.onnx$/i.test(model.name) ? 'ONNX' : 'RVC';
  const device = details?.device
    ? `on ${/^cpu/i.test(details.device) ? 'CPU' : 'GPU'}`
    : null;
  return [
    kind,
    model.size_bytes != null ? formatFileSize(model.size_bytes) : null,
    model.has_index ? 'index file' : null,
    details?.version,
    details?.target_sample_rate ? `${Math.round(details.target_sample_rate / 1000)} kHz` : null,
    device,
  ]
    .filter(Boolean)
    .join(' · ');
}

function isPhoneApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

// The one place the Models tab says why there is nothing to manage.
function NoServer({ server }) {
  const [checked, setChecked] = useState(false);
  const phone = isPhoneApp();
  const starting = server.state === 'unreachable';

  let title = 'Voice models need the desktop server';
  let body =
    "AI voice models (RVC and ONNX files) run on the BadloVoice desktop server, which you install on your own computer. This page isn't connected to one.";
  if (phone) {
    title = "Voice models aren't available in the phone app";
    body = 'AI voice models (RVC and ONNX files) run on the BadloVoice desktop server, on a computer.';
  } else if (starting) {
    title = "Can't reach the desktop server";
    body = 'Voice models are loaded and run by the BadloVoice server. Start it, then check again.';
  }

  return (
    <div className={`${NOTE} mt-4`}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-[65ch] text-pretty text-sm text-muted">
        {body} Every voice and effect in Studio works without it.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Only worth asking again where a server could still turn up. */}
        {starting && (
          <button
            type="button"
            className="chip-button"
            disabled={server.rechecking}
            onClick={async () => {
              setChecked(false);
              await server.recheck();
              setChecked(true);
            }}
          >
            {server.rechecking ? 'Checking…' : 'Check again'}
          </button>
        )}
        <a
          href={SETUP_URL}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-ink underline underline-offset-4"
        >
          How to set up the server
        </a>
        <span role="status" className="text-xs text-muted">
          {checked && !server.rechecking ? "Still can't reach it." : ''}
        </span>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="mt-4 space-y-3" aria-hidden="true">
      {[0, 1].map((row) => (
        <div
          key={row}
          className="h-12 animate-pulse rounded-xl bg-ink/7 motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

export default function ModelManager({ activeModel = null, onActiveModelChange }) {
  const server = useServerStatus();
  const [models, setModels] = useState(null); // null until the first list arrives
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null); // { name, action }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [upload, setUpload] = useState(null); // { name, index, total, progress }
  const [notice, setNotice] = useState(null); // { tone: 'ok' | 'error', text }
  const [dragActive, setDragActive] = useState(false);

  const fileInputRef = useRef(null);
  const uploadAbortRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchModels();
      const next = Array.isArray(list) ? list : [];
      setModels(next);
      setLoadError(null);
      onActiveModelChange?.(next.find((model) => model.active)?.name || null);
    } catch (err) {
      // With no server the panel shows the notice instead.
      if (!err.offline) setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onActiveModelChange]);

  useEffect(() => {
    if (server.online) load();
  }, [server.online, load]);

  // Leaving the tab stops an upload rather than letting it run unseen.
  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  const addFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length || upload) return;
    const wanted = files.filter((file) => MODEL_FILE.test(file.name));
    const skipped = files.filter((file) => !MODEL_FILE.test(file.name));
    if (!wanted.length) {
      setNotice({
        tone: 'error',
        text: `${skipped[0].name} isn't a voice model. Add .pth, .pt or .onnx files, or a matching .index file.`,
      });
      return;
    }

    const abort = new AbortController();
    uploadAbortRef.current = abort;
    setNotice(null);
    const added = [];
    let problem = null;
    for (const [i, file] of wanted.entries()) {
      setUpload({ name: file.name, index: i + 1, total: wanted.length, progress: 0 });
      try {
        await uploadModel(file, {
          signal: abort.signal,
          onProgress: (progress) => setUpload((current) => current && { ...current, progress }),
        });
        added.push(file.name);
      } catch (err) {
        problem = err.cancelled ? 'Upload cancelled.' : `Couldn't add ${file.name}. ${err.message}`;
        break;
      }
    }
    uploadAbortRef.current = null;
    setUpload(null);
    if (added.length) await load();

    const done = added.length === 1 ? `Added ${added[0]}.` : `Added ${added.length} files.`;
    if (problem) {
      setNotice({ tone: 'error', text: added.length ? `${done} ${problem}` : problem });
    } else {
      const also = skipped.length ? ` Skipped ${skipped.length} that aren't model files.` : '';
      setNotice({ tone: 'ok', text: `${done}${also}` });
    }
  };

  const activate = async (name) => {
    setBusy({ name, action: 'activate' });
    setNotice(null);
    try {
      await activateModel(name);
      onActiveModelChange?.(name);
      await load();
      setNotice({ tone: 'ok', text: `${name} is active. Go to Studio and press Start.` });
    } catch (err) {
      setNotice({ tone: 'error', text: `Couldn't activate ${name}. ${err.message}` });
    } finally {
      setBusy(null);
    }
  };

  const deactivate = async (name) => {
    setBusy({ name, action: 'deactivate' });
    setNotice(null);
    try {
      await deactivateModel();
      onActiveModelChange?.(null);
      await load();
      setNotice({ tone: 'ok', text: 'Deactivated. Studio is back on the built-in engine.' });
    } catch (err) {
      setNotice({ tone: 'error', text: `Couldn't deactivate ${name}. ${err.message}` });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name) => {
    setConfirmDelete(null);
    setBusy({ name, action: 'delete' });
    setNotice(null);
    try {
      await deleteModel(name);
      if (activeModel === name) onActiveModelChange?.(null);
      await load();
      setNotice({ tone: 'ok', text: `Deleted ${name}.` });
    } catch (err) {
      setNotice({ tone: 'error', text: `Couldn't delete ${name}. ${err.message}` });
    } finally {
      setBusy(null);
    }
  };

  const locked = Boolean(busy) || Boolean(upload);

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="panel-title">Voice models</h2>
        {server.online && (
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="chip-button px-2.5"
            aria-label="Reload the model list"
            title="Reload the model list"
          >
            <svg
              className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        )}
      </div>

      {server.offline && <NoServer server={server} />}
      {server.state === 'checking' && <ListSkeleton />}

      {server.online && (
        <>
          <p className="mt-1 max-w-[65ch] text-pretty text-sm text-muted">
            Add a model file, then activate it to speak with that voice in Studio. One model is
            active at a time.
          </p>

          <div
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              addFiles(event.dataTransfer.files);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false);
            }}
            className={`mt-4 flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center ${
              dragActive
                ? 'drag-active border-accent bg-accent/8'
                : 'border-ink/30'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".onnx,.pth,.pt,.index"
              multiple
              className="hidden"
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
              }}
            />
            {upload ? (
              <div className="w-full max-w-md" role="status">
                <p className="truncate text-sm font-medium text-ink">
                  Uploading {upload.name}
                  {upload.total > 1 ? ` (${upload.index} of ${upload.total})` : ''}
                </p>
                <progress
                  className="mt-2 h-2 w-full accent-accent"
                  max={1}
                  value={upload.progress}
                  aria-label={`Uploading ${upload.name}`}
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs tabular-nums text-muted">
                    {upload.progress >= 1
                      ? 'Saving on the server…'
                      : `${Math.round(upload.progress * 100)}%`}
                  </span>
                  <button
                    type="button"
                    className="chip-button"
                    onClick={() => uploadAbortRef.current?.abort()}
                  >
                    Cancel upload
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm font-medium text-ink">
                  {dragActive ? 'Drop to add' : 'Drop model files here'}
                </p>
                <p className="text-xs text-muted">
                  .pth, .pt or .onnx. Add the matching .index file too if you have one.
                </p>
                <button
                  type="button"
                  className="chip-button mt-1"
                  disabled={locked}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose files
                </button>
              </>
            )}
          </div>

          {notice && (
            <p
              role={notice.tone === 'error' ? 'alert' : 'status'}
              className={`mt-4 ${
                notice.tone === 'error'
                  ? ALERT
                  : `${NOTE} text-sm text-ink`
              }`}
            >
              {notice.text}
            </p>
          )}

          {loadError && (
            <div role="alert" className={`${ALERT} mt-4 flex flex-wrap items-center gap-3`}>
              <p className="min-w-0 flex-1">Couldn't load your models. {loadError}</p>
              <button type="button" className="chip-button" onClick={load} disabled={loading}>
                Try again
              </button>
            </div>
          )}

          {models === null && !loadError && <ListSkeleton />}

          {models?.length === 0 && (
            <p className="mt-4 text-sm text-muted">
              No voice models yet. Add a .pth or .onnx file to hear it in Studio. The built-in
              voices keep working either way.
            </p>
          )}

          {models?.length > 0 && (
            <ul className="mt-4 divide-y divide-line border-y border-line">
              {models.map((model) => {
                const { name } = model;
                const isActive = activeModel === name;
                const working = busy?.name === name ? busy.action : null;

                return (
                  <li key={name} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="flex items-center gap-2">
                        <span
                          className="truncate text-sm font-semibold text-ink"
                          title={name}
                        >
                          {name}
                        </span>
                        {isActive && (
                          <span className={BADGE_ON}>
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-success"
                              aria-hidden="true"
                            />
                            Active
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">{describeModel(model)}</p>
                    </div>

                    {confirmDelete === name ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-ink">
                          Delete this file from the server?
                        </span>
                        <button
                          type="button"
                          className="btn-secondary-danger"
                          onClick={() => remove(name)}
                        >
                          Delete model
                        </button>
                        <button
                          type="button"
                          className="chip-button"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep
                        </button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-2">
                        {working === 'activate' && (
                          <span className="text-xs text-muted" role="status">
                            Loading. This can take a minute.
                          </span>
                        )}
                        <button
                          type="button"
                          className="chip-button"
                          disabled={locked}
                          onClick={() => (isActive ? deactivate(name) : activate(name))}
                        >
                          {working === 'activate'
                            ? 'Activating…'
                            : working === 'deactivate'
                              ? 'Deactivating…'
                              : isActive
                                ? 'Deactivate'
                                : 'Activate'}
                        </button>
                        <button
                          type="button"
                          className="chip-button"
                          disabled={locked}
                          onClick={() => setConfirmDelete(name)}
                          aria-label={`Delete ${name}`}
                        >
                          {working === 'delete' ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
