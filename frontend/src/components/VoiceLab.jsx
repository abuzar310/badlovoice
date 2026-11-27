import React, { useId, useState } from 'react';

const F0_METHODS = [
  { value: 'pm', label: 'PM', description: 'Lowest latency' },
  { value: 'harvest', label: 'Harvest', description: 'Stable tone' },
  { value: 'crepe', label: 'Crepe', description: 'GPU quality' },
  { value: 'rmvpe', label: 'RMVPE', description: 'Best overall' },
  { value: 'fcpe', label: 'FCPE', description: 'Fast neural, realtime' },
];

// Voice presets aim for a target pitch and can ask for up to ±16 semitones
// (pitchFromHost in lib/voiceProfiles.js), in steps of 0.1. The sliders cover
// the same range and step so the cap always sits where the number says.
const PITCH_RANGE = 16;
const FORMANT_RANGE = 12;
const SHIFT_STEP = 0.1;

const MINUS = '−';

function signed(value) {
  const n = Number(value) || 0;
  const text = Math.abs(n).toFixed(1);
  if (n > 0) return `+${text}`;
  if (n < 0) return `${MINUS}${text}`;
  return text;
}

// What a screen reader says for a slider position.
function spokenSemitones(value) {
  const n = Number(value) || 0;
  if (n === 0) return '0 semitones, no change';
  const size = Math.abs(n);
  const amount = Number.isInteger(size) ? String(size) : size.toFixed(1);
  return `${amount} ${size === 1 ? 'semitone' : 'semitones'} ${n > 0 ? 'up' : 'down'}`;
}

function ResetIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function ShiftSlider({ label, value, range, lowWord, highWord, onChange, onReset }) {
  const id = useId();
  const n = Number(value) || 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <span
            className={`font-mono text-xl font-semibold tabular-nums tracking-[-0.03em] ${
              n === 0 ? 'text-muted' : 'text-ink'
            }`}
            aria-hidden="true"
          >
            {signed(n)} st
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={n === 0}
            className="chip-button tap-target !px-2.5"
            aria-label={`Reset ${label.toLowerCase()} to 0`}
            title={`Reset ${label.toLowerCase()} to 0`}
          >
            <ResetIcon />
          </button>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={-range}
        max={range}
        step={SHIFT_STEP}
        value={n}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-valuetext={spokenSemitones(n)}
        className="mt-1 w-full"
      />
      <div className="flex items-center justify-between text-xs text-muted" aria-hidden="true">
        <span>
          {MINUS}
          {range} {lowWord}
        </span>
        <span>0</span>
        <span>
          {highWord} +{range}
        </span>
      </div>
    </div>
  );
}

function MiniSlider({ label, value, min, max, step, onChange }) {
  const id = useId();
  const n = Number(value) || 0;
  const percent = `${Math.round(n * 100)}%`;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <span className="font-mono text-xs tabular-nums text-ink" aria-hidden="true">
          {percent}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={n}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-valuetext={percent}
        className="fx-slider mt-1 w-full"
      />
    </div>
  );
}

export default function VoiceLab({ voice, onChange, hasModel, isRunning, compact = false }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const headingId = useId();
  const f0Id = useId();
  const advancedId = useId();

  const pitch = Number(voice.pitch) || 0;
  const formant = Number(voice.formant) || 0;
  const unchanged = pitch === 0 && formant === 0;

  const header = (
    <div className="flex items-center justify-between gap-2">
      <h2 id={headingId} className="panel-title">
        Pitch &amp; formant
      </h2>
      <button
        type="button"
        className="chip-button"
        onClick={() => onChange({ pitch: 0, formant: 0 })}
        disabled={unchanged}
      >
        Reset both
      </button>
    </div>
  );

  const sliders = (
    <div className={compact ? 'mt-3 space-y-4' : 'mt-4 space-y-5'}>
      <ShiftSlider
        label="Pitch"
        value={pitch}
        range={PITCH_RANGE}
        lowWord="lower"
        highWord="higher"
        onChange={(value) => onChange({ pitch: value })}
        onReset={() => onChange({ pitch: 0 })}
      />
      <ShiftSlider
        label="Formant"
        value={formant}
        range={FORMANT_RANGE}
        lowWord="darker"
        highWord="brighter"
        onChange={(value) => onChange({ formant: value })}
        onReset={() => onChange({ formant: 0 })}
      />
    </div>
  );

  if (compact) {
    return (
      <section className="panel p-4" aria-labelledby={headingId}>
        {header}
        {sliders}
      </section>
    );
  }

  return (
    <section className="panel p-5" aria-labelledby={headingId}>
      {header}
      <p className="mt-1 text-xs text-muted">
        {unchanged
          ? 'At 0 your voice is unchanged.'
          : `Pitch ${signed(pitch)} st, formant ${signed(formant)} st.`}{' '}
        {isRunning ? 'Changes apply live.' : 'Changes apply when you start.'}
      </p>

      {sliders}

      <div className="mt-6 border-t border-line pt-5" role="group" aria-labelledby={f0Id}>
        <p id={f0Id} className="field-label">
          Pitch detection{hasModel ? '' : ' — needs an RVC model'}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {F0_METHODS.map((method) => {
            const selected = voice.f0Method === method.value;
            return (
              <button
                key={method.value}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange({ f0Method: method.value })}
                className={`tap-target rounded-xl border px-3 py-2.5 text-left transition ${
                  selected
                    ? 'border-accent/50 bg-accent/12 text-ink'
                    : 'border-line bg-surface-2/40 text-muted hover:border-ink/25 hover:text-ink'
                }`}
              >
                <span className="block text-sm font-semibold leading-tight">{method.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{method.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 border-t border-line pt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((open) => !open)}
          aria-expanded={showAdvanced}
          aria-controls={advancedId}
          className="tap-target flex w-full items-center justify-between rounded-lg text-sm font-semibold text-muted transition hover:text-ink"
        >
          RVC model settings
          <svg
            className={`h-4 w-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {showAdvanced && (
          <div id={advancedId} className="mt-3 space-y-4">
            <MiniSlider
              label="Index rate"
              value={voice.indexRate}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => onChange({ indexRate: value })}
            />
            <MiniSlider
              label="Loudness follow (RMS mix)"
              value={voice.rmsMixRate}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => onChange({ rmsMixRate: value })}
            />
            <MiniSlider
              label="Protect consonants"
              value={voice.protect}
              min={0}
              max={0.5}
              step={0.01}
              onChange={(value) => onChange({ protect: value })}
            />
            <p className="text-xs leading-5 text-muted">
              Index rate blends retrieval features, loudness follow tracks how loud you speak,
              protect keeps breaths and consonants clear.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
