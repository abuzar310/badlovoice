import React, { useId } from 'react';
import { EFFECT_DEFS } from '../lib/effects';

// The threshold range the effect rack and both engines use for the gate.
const RANGE = EFFECT_DEFS.find((def) => def.key === 'gate').params.find(
  (param) => param.key === 'threshold'
);
// What the audio pipeline reports until the gate has measured something.
const NO_READING_DB = -80;

const toPercent = (db) =>
  Math.max(0, Math.min(100, ((db - RANGE.min) / (RANGE.max - RANGE.min)) * 100));

/**
 * The noise gate: mutes the mic while the user is quiet so room noise and
 * background voices are not changed along with theirs. The meter under the
 * slider is on the same scale, so the mic level can be read against the line.
 */
export default function BackgroundBlocker({
  enabled,
  thresholdDb,
  gateOpen,
  levelDb,
  onChange,
  disabled,
}) {
  const id = useId();
  const measuring = gateOpen || (levelDb ?? NO_READING_DB) !== NO_READING_DB;

  let status = 'Closed. Your mic is muted.';
  if (!enabled) status = 'Off. Everything your mic picks up goes through.';
  else if (!measuring) status = 'Press Start to see your mic level against the line.';
  else if (gateOpen) status = 'Open. Your voice is going through.';

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id={`${id}-title`} className="panel-title">
            Noise gate
          </h2>
          <p className="mt-1 max-w-[65ch] text-pretty text-sm text-muted">
            Mutes your mic while you are quiet, so room noise and other voices in the background
            are not changed along with yours.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={`${id}-title`}
          disabled={disabled}
          onClick={() => onChange({ enabled: !enabled })}
          className="switch mt-1"
        />
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`${id}-level`} className="field-label">
            Opens when you are louder than
          </label>
          <output htmlFor={`${id}-level`} className="font-mono text-sm tabular-nums text-ink">
            {thresholdDb} dB
          </output>
        </div>
        <input
          id={`${id}-level`}
          type="range"
          min={RANGE.min}
          max={RANGE.max}
          step={RANGE.step}
          value={thresholdDb}
          disabled={!enabled || disabled}
          onChange={(event) => onChange({ thresholdDb: Number(event.target.value) })}
          className="mt-2 w-full"
        />

        {/* Inset by half the slider cap (12px, 20px on touch: index.css), so the line sits under it. */}
        <div className="mx-[6px] [@media(pointer:coarse)]:mx-[10px]" aria-hidden="true">
          <div className="relative mt-1 h-2 rounded-full bg-ink/10">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-mic transition-[width] duration-75 motion-reduce:transition-none"
              style={{ width: `${enabled && measuring ? toPercent(levelDb) : 0}%` }}
            />
            <div
              className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ink"
              style={{ left: `${toPercent(thresholdDb)}%` }}
            />
          </div>
        </div>
        <div className="mt-2 flex justify-between gap-3">
          <span className="text-xs text-muted">Lets more through</span>
          <span className="text-xs text-muted">Blocks more</span>
        </div>

        <p className="mt-3 text-sm font-medium text-ink">{status}</p>
        <p className="mt-1 max-w-[65ch] text-xs text-muted">
          The bar is your mic level and the line is the gate. If it cuts off quiet words, move the
          slider left. If background noise still gets through, move it right.
        </p>
      </div>
    </section>
  );
}
