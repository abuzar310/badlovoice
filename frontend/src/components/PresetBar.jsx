import React, { useId, useMemo, useState } from 'react';
import { fetchPresets, savePreset, deletePreset } from '../lib/api';
import useSavedItems from '../hooks/useSavedItems';
import { BUILTIN_PRESETS, MAX_NAME_LENGTH, localPresets } from '../lib/savedSettings';
import { ALERT, BUTTON_PRIMARY, FIELD, NOTE, OPTION, OPTION_ON } from '../lib/ui';

// Same shape as the quick-voice chips in the Studio.
const CHIP =
  'inline-flex min-h-11 items-center border px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';

/**
 * A panel of named settings the user can apply, save and delete. Presets and
 * profiles are both one of these; `noun` is the word used for an item.
 *
 * `saved` comes from useSavedItems. `onApply(item)` applies one and may return
 * a sentence to show. `onSaved(item)` runs after a new one is saved.
 * `isActive(item)` marks the one in use, if that is known.
 */
export function SavedSettings({
  id,
  title,
  description,
  noun,
  builtin = [],
  saved,
  getSettings,
  onApply,
  onSaved,
  isActive = () => false,
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState(null); // { tone, text, undo }
  const nameId = useId();

  const say = (text, undo = null) => setMessage({ tone: 'ok', text, undo });
  const fail = (text) => setMessage({ tone: 'error', text });

  const apply = (item) => {
    const note = onApply(item);
    if (note) say(note);
    else setMessage(null);
  };

  const closeForm = () => {
    setNaming(false);
    setName('');
  };

  const save = async (event) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || working) return;
    setWorking(true);
    try {
      const { item, where } = await saved.save(clean, getSettings());
      closeForm();
      onSaved?.(item);
      say(where === 'device' ? `Saved "${item.name}" on this device.` : `Saved "${item.name}".`);
    } catch (err) {
      fail(`Couldn't save "${clean}". ${err.message}`);
    } finally {
      setWorking(false);
    }
  };

  const remove = async (item) => {
    setWorking(true);
    try {
      await saved.remove(item);
      say(`Deleted "${item.name}".`, item);
    } catch (err) {
      fail(`Couldn't delete "${item.name}". ${err.message}`);
    } finally {
      setWorking(false);
    }
  };

  const restore = async (item) => {
    setWorking(true);
    try {
      await saved.save(item.name, item.settings);
      say(`Restored "${item.name}".`);
    } catch (err) {
      fail(`Couldn't restore "${item.name}". ${err.message}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <section id={id} className="panel scroll-mt-20 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="panel-title">{title}</h2>
          <p className="mt-1 max-w-[65ch] text-pretty text-sm text-muted">{description}</p>
        </div>
        {!naming && (
          <button type="button" className="chip-button" onClick={() => setNaming(true)}>
            Save as a {noun}
          </button>
        )}
      </div>

      {naming && (
        <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-48 sm:max-w-xs">
            <label htmlFor={nameId} className="field-label block">
              Name for this {noun}
            </label>
            <input
              id={nameId}
              className={`${FIELD} mt-1`}
              value={name}
              maxLength={MAX_NAME_LENGTH}
              autoFocus
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeForm();
              }}
            />
          </div>
          <button type="submit" className={BUTTON_PRIMARY} disabled={working || !name.trim()}>
            {working ? 'Saving…' : `Save ${noun}`}
          </button>
          <button type="button" className="chip-button" onClick={closeForm}>
            Cancel
          </button>
        </form>
      )}

      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 ${
            message.tone === 'error' ? ALERT : `${NOTE} text-sm text-ink`
          }`}
        >
          <span className="min-w-0 flex-1 break-words">{message.text}</span>
          {message.undo && (
            <button
              type="button"
              className="chip-button"
              disabled={working}
              onClick={() => restore(message.undo)}
            >
              Undo
            </button>
          )}
        </p>
      )}

      {saved.loadError && (
        <p role="alert" className={`${ALERT} mt-4 flex flex-wrap items-center gap-3`}>
          <span className="min-w-0 flex-1">
            Couldn't load the {noun}s saved on the server. {saved.loadError}
          </span>
          <button type="button" className="chip-button" onClick={saved.reload}>
            Try again
          </button>
        </p>
      )}

      {builtin.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {builtin.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                title={item.description}
                aria-pressed={isActive(item)}
                onClick={() => apply(item)}
                className={`${CHIP} rounded-xl ${isActive(item) ? OPTION_ON : OPTION}`}
              >
                {item.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {saved.items.length > 0 && (
        <>
          {builtin.length > 0 && (
            <h3 className="mt-5 text-sm font-semibold text-ink">Your {noun}s</h3>
          )}
          <ul className={`flex flex-wrap gap-2 ${builtin.length > 0 ? 'mt-2' : 'mt-4'}`}>
            {saved.items.map((item) => (
              <li key={item.id} className="flex max-w-full">
                <button
                  type="button"
                  aria-pressed={isActive(item)}
                  onClick={() => apply(item)}
                  className={`${CHIP} min-w-0 rounded-l-xl ${isActive(item) ? OPTION_ON : OPTION}`}
                >
                  <span className="truncate">{item.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${noun} ${item.name}`}
                  title={`Delete ${item.name}`}
                  disabled={working}
                  onClick={() => remove(item)}
                  className={`${CHIP} ${OPTION} rounded-r-xl border-l-0 hover:text-danger-soft`}
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// Voices in the library and presets share one "active" id in the app, and
// several share an id ("female", "robot"). The prefix stops a preset from
// lighting up the voice of the same name, or being swapped for it later.
const activeId = (preset) => `preset:${preset.id}`;

export default function PresetBar({ activePresetId, onApplyPreset, getCurrentSettings }) {
  const [builtin, setBuiltin] = useState(BUILTIN_PRESETS);

  const remote = useMemo(
    () => ({
      list: async () => {
        const data = await fetchPresets();
        if (Array.isArray(data?.builtin) && data.builtin.length) setBuiltin(data.builtin);
        return data?.user;
      },
      save: savePreset,
      remove: deletePreset,
    }),
    []
  );
  const saved = useSavedItems(localPresets, remote);

  const apply = (preset) => {
    onApplyPreset({ ...preset, id: activeId(preset) });
  };

  return (
    <SavedSettings
      id="presets"
      title="Presets"
      description="A preset sets pitch, formant and effects in one tap. Save the current settings to make your own."
      noun="preset"
      builtin={builtin}
      saved={saved}
      getSettings={getCurrentSettings}
      onApply={apply}
      // The new preset is what is playing now, so show it as the chosen one.
      onSaved={apply}
      isActive={(preset) => activePresetId === activeId(preset)}
    />
  );
}
