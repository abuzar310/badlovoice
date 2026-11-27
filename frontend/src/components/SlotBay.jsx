import React, { useCallback, useEffect, useState } from 'react';
import { activateSlot, bindSlot, fetchModels, fetchSlots, onModelsChanged } from '../lib/api';
import useServerStatus from '../hooks/useServerStatus';
import { ALERT, BADGE_ON, FIELD } from '../lib/ui';

// Five places to pin a voice model for one-click switching. Only shown once
// there is a server with at least one model: before that there is nothing to
// pin, and the model list below explains what is missing.
export default function SlotBay({ activeModel, onActiveModelChange }) {
  const { online } = useServerStatus();
  const [slots, setSlots] = useState([]);
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // { index, activating } of the slot being changed

  const reload = useCallback(async () => {
    try {
      const [slotList, modelList] = await Promise.all([fetchSlots(), fetchModels()]);
      setSlots(Array.isArray(slotList) ? slotList : []);
      setModels(Array.isArray(modelList) ? modelList : []);
    } catch (err) {
      if (!err.offline) setError(`Couldn't load your slots. ${err.message}`);
    }
  }, []);

  useEffect(() => {
    if (online) reload();
  }, [online, reload, activeModel]);

  useEffect(() => onModelsChanged(reload), [reload]);

  if (!online || models.length === 0) return null;

  const change = async (state, failed, action) => {
    setBusy(state);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError(`${failed} ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const pin = (slot, name) =>
    change({ index: slot.index }, "Couldn't change that slot.", () =>
      bindSlot(slot.index, name || null)
    );

  const activate = (slot) =>
    change({ index: slot.index, activating: true }, `Couldn't activate ${slot.name}.`, async () => {
      const result = await activateSlot(slot.index);
      onActiveModelChange?.(result?.name || slot.name);
    });

  const names = models.map((model) => model.name);

  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="panel-title">Quick slots</h2>
      <p className="mt-1 max-w-[65ch] text-sm text-muted">
        Pin up to five models here to switch between them with one click.
      </p>

      <ul className="mt-4 grid gap-x-3 gap-y-4 sm:grid-cols-2 lg:grid-cols-5">
        {slots.map((slot) => {
          const label = slot.label || `Slot ${slot.index + 1}`;
          const missing = slot.name && !names.includes(slot.name);
          const fieldId = `slot-${slot.index}`;
          return (
            <li key={slot.index} className="min-w-0">
              <div className="flex min-h-6 items-center justify-between gap-2">
                <label htmlFor={fieldId} className="field-label block">
                  {label}
                </label>
                {slot.active && <span className={BADGE_ON}>Active</span>}
              </div>
              <select
                id={fieldId}
                className={`${FIELD} native-select-safe mt-1`}
                value={slot.name || ''}
                disabled={busy !== null}
                onChange={(event) => pin(slot, event.target.value)}
              >
                <option value="">Empty</option>
                {missing && <option value={slot.name}>{slot.name} (deleted)</option>}
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="chip-button mt-2 w-full"
                disabled={!slot.name || missing || slot.active || busy !== null}
                onClick={() => activate(slot)}
              >
                {busy?.activating && busy.index === slot.index ? 'Activating…' : 'Activate'}
              </button>
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className={`${ALERT} mt-4`}>
          {error}
        </p>
      )}
    </section>
  );
}
