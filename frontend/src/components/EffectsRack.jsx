import React, { useId } from 'react';
import { EFFECT_DEFS } from '../lib/effects';

const MINUS = '−';

function formatValue(param, value) {
  const num = Number(value);
  // Unitless 0–1 amounts (mix, drive, depth…) read better as a percentage.
  if (!param.unit && param.max <= 1) return `${Math.round(num * 100)}%`;
  const size = Math.abs(num);
  const digits = param.step >= 1 ? String(Math.round(size)) : size.toFixed(2).replace(/\.?0+$/, '');
  const text = `${num < 0 ? MINUS : ''}${digits}`;
  if (param.unit === ':1') return `${text}:1`;
  if (param.unit === 'x') return `${text}×`;
  return param.unit ? `${text} ${param.unit}` : text;
}

function ParamSlider({ effectLabel, param, value, onChange }) {
  const id = useId();
  const text = formatValue(param, value);

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {param.label}
          <span className="sr-only">, {effectLabel}</span>
        </label>
        <span className="font-mono text-xs tabular-nums text-ink" aria-hidden="true">
          {text}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-valuetext={text}
        className="fx-slider w-full"
      />
    </div>
  );
}

// One effect: a switch, and its controls once it is on.
function EffectRow({ def, state, onChange }) {
  const enabled = Boolean(state?.enabled);
  const titleId = useId();

  return (
    <div className="border-t border-line py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p id={titleId} className="text-sm font-semibold text-ink">
            {def.label}
          </p>
          <p className="text-xs text-muted">
            {def.tagline}
            {def.localOnly ? ' · on-device only' : ''}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={titleId}
          className="switch"
          onClick={() => onChange(def.key, { ...state, enabled: !enabled })}
        />
      </div>

      {enabled && def.params.length > 0 && (
        <div className="mt-2 space-y-1">
          {def.params.map((param) => (
            <ParamSlider
              key={param.key}
              effectLabel={def.label}
              param={param}
              value={state?.[param.key] ?? param.default}
              onChange={(value) => onChange(def.key, { ...state, [param.key]: value })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function EffectsRack({ effects, onEffectsChange, embedded = false }) {
  const activeCount = EFFECT_DEFS.filter((def) => effects?.[def.key]?.enabled).length;

  const handleChange = (key, entry) => {
    onEffectsChange({ ...effects, [key]: entry });
  };

  // Switches everything off but keeps each effect's settings for next time.
  const handleAllOff = () => {
    const next = { ...effects };
    for (const def of EFFECT_DEFS) {
      if (next[def.key]) next[def.key] = { ...next[def.key], enabled: false };
    }
    onEffectsChange(next);
  };

  const count = <span className="font-normal text-muted"> · {activeCount} on</span>;

  const allOffButton = (
    <button
      type="button"
      onClick={handleAllOff}
      disabled={activeCount === 0}
      className="chip-button"
    >
      Turn all off
    </button>
  );

  const list = (
    <div
      className={`grid items-start gap-x-8 sm:grid-cols-2 ${
        embedded ? 'xl:grid-cols-3' : 'xl:grid-cols-3 2xl:grid-cols-4'
      }`}
    >
      {EFFECT_DEFS.map((def) => (
        <EffectRow key={def.key} def={def} state={effects?.[def.key]} onChange={handleChange} />
      ))}
    </div>
  );

  if (embedded) {
    return (
      <div id="effects" className="scroll-mt-20">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">
            All effects
            {count}
          </h3>
          {allOffButton}
        </div>
        {list}
      </div>
    );
  }

  return (
    <section id="effects" className="panel scroll-mt-20 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="panel-title">
          Effects
          {count}
        </h2>
        {allOffButton}
      </div>
      <p className="mb-4 mt-1 text-xs text-muted">
        Effects run live on this device, in the order listed. With an AI model active the same
        chain runs on the server after the model.
      </p>
      {list}
    </section>
  );
}
