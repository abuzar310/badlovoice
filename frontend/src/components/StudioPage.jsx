import React, { useEffect, useMemo, useState } from 'react';
import Visualizer from './Visualizer';
import VoiceLab from './VoiceLab';
import EffectsRack from './EffectsRack';
import Recorder from './Recorder';
import StreamExtras from './StreamExtras';
import BackgroundBlocker from './BackgroundBlocker';
import PresetBar from './PresetBar';
import ErrorBoundary from './ErrorBoundary';
import {
  VOICE_PROFILES,
  profileToVoicePartial,
} from '../lib/voiceProfiles';
import { defaultEffects } from '../lib/effects';

const GROUPS = ['Adult', 'Teen', 'Child', 'Fun'];

const QUICK_PRESETS = [
  { id: 'natural', label: 'Natural', kind: 'natural' },
  { id: 'deep', label: 'Deep', kind: 'profile', profileId: 'deep' },
  { id: 'female', label: 'Female', kind: 'profile', profileId: 'female' },
  { id: 'robot', label: 'Robot', kind: 'profile', profileId: 'robot' },
  { id: 'monster', label: 'Monster', kind: 'profile', profileId: 'monster' },
  { id: 'whisper-high', label: 'Whisper', kind: 'profile', profileId: 'whisper-high' },
  { id: 'radio', label: 'Radio', kind: 'profile', profileId: 'radio' },
  { id: 'cave', label: 'Cave', kind: 'profile', profileId: 'cave' },
];

// Browser-side mic processing, applied when the mic is opened.
const MIC_OPTIONS = [
  {
    key: 'noiseSuppression',
    label: 'Noise suppression',
    hint: 'Removes steady background noise such as fans and hiss.',
  },
  {
    key: 'echoCancellation',
    label: 'Echo cancellation',
    hint: 'For speakers without headphones. Can dull the voice a little.',
  },
  {
    key: 'autoGain',
    label: 'Auto mic level',
    hint: 'Evens out a mic that is too quiet or too loud.',
  },
];

const RECENT_KEY = 'badlovoice_recent_voices';
const HEAR_KEY = 'badlovoice_hear_myself';

function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(id) {
  const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

function LevelMeter({ label, value, tone = 'mic' }) {
  const pct = Math.min(100, Math.max(0, Number(value) || 0));
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="level-track h-1.5">
        <div
          className={`level-fill ${tone === 'out' ? 'bg-accent' : 'bg-mic'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function VoiceCard({ profile, selected, pitch, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(profile)}
      aria-pressed={selected}
      className={`voice-chip w-full ${selected ? 'voice-chip-on' : ''}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="voice-chip-name block text-sm font-semibold tracking-tight">
          {profile.name}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-accent-soft">
          {pitch > 0 ? `+${pitch}` : pitch}
        </span>
      </span>
      <span className="mt-0.5 block text-xs text-muted">{profile.blurb}</span>
    </button>
  );
}

/**
 * Studio workflow UI. All audio/state comes from App — no duplicate pipeline.
 */
export default function StudioPage({
  density = 'studio', // simple | studio | advanced
  devices,
  pipeline,
  voice,
  onVoiceChange,
  effects,
  onEffectsChange,
  activePresetId,
  onSelectProfile,
  hostPitch,
  onCalibrateHostPitch,
  modelActive = false,
  applyPreset,
  getCurrentSettings,
  extras,
  onExtrasChange,
  onApplyLatencyMode,
  getProfileSnapshot,
  wsStatus,
  activeModel,
  latency,
  serverMs,
  serverStats,
  runtimeConfig,
}) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('Adult');
  const [recent, setRecent] = useState(readRecent);
  const [selectedInput, setSelectedInput] = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const [showAdvancedFx, setShowAdvancedFx] = useState(density === 'advanced');
  const [quickId, setQuickId] = useState(null);
  const [calibrateNote, setCalibrateNote] = useState(null);
  const [hearMyself, setHearMyself] = useState(() => {
    try {
      return localStorage.getItem(HEAR_KEY) === '1';
    } catch {
      return false;
    }
  });

  const isSimple = density === 'simple';
  const isAdvanced = density === 'advanced';

  useEffect(() => {
    pipeline.setHearMyself?.(hearMyself);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync saved preference once on mount
  }, []);

  const handleHearMyself = (on) => {
    setHearMyself(on);
    pipeline.setHearMyself?.(on);
    try {
      localStorage.setItem(HEAR_KEY, on ? '1' : '0');
    } catch {
      // ignore
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return VOICE_PROFILES.filter((p) => {
      if (group !== 'All' && p.group !== group) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.blurb.toLowerCase().includes(q) ||
        p.group.toLowerCase().includes(q)
      );
    });
  }, [query, group]);

  const recentProfiles = useMemo(
    () => recent.map((id) => VOICE_PROFILES.find((p) => p.id === id)).filter(Boolean),
    [recent]
  );

  const handleSelectProfile = (profile) => {
    onSelectProfile(profile);
    setRecent(pushRecent(profile.id));
    setQuickId(null);
  };

  const handleStart = async () => {
    setError(null);
    setStarting(true);
    try {
      await devices.refresh?.();
      await pipeline.start(selectedInput || undefined, selectedOutput || undefined);
    } catch (err) {
      setError(err.message || 'Could not start. Allow the mic, then try again.');
    } finally {
      setStarting(false);
    }
  };

  const handleStop = () => {
    setError(null);
    pipeline.stop();
  };

  const toggleEffect = (key) => {
    const cur = effects?.[key] || { enabled: false };
    onEffectsChange({
      ...effects,
      [key]: { ...cur, enabled: !cur.enabled },
    });
  };

  const applyQuick = (preset) => {
    setQuickId(preset.id);
    if (preset.kind === 'natural') {
      onVoiceChange({ pitch: 0, formant: 0 });
      onEffectsChange(defaultEffects());
      return;
    }
    if (preset.kind === 'profile') {
      const profile = VOICE_PROFILES.find((p) => p.id === preset.profileId);
      if (profile) handleSelectProfile(profile);
      return;
    }
    if (preset.kind === 'effect') {
      const cur = effects?.[preset.effectKey] || { enabled: false };
      onEffectsChange({
        ...effects,
        [preset.effectKey]: { ...cur, enabled: true },
      });
    }
  };

  const handleCalibrate = () => {
    if (!pipeline.isRunning) {
      setCalibrateNote('Press Start and talk for a few seconds first.');
      return;
    }
    setCalibrateNote(
      onCalibrateHostPitch?.()
        ? 'Matched — voices now aim from your own pitch.'
        : 'Keep talking normally for a few seconds, then tap again.'
    );
  };

  const live = pipeline.isRunning;
  const shownLatency = modelActive ? latency : pipeline.engineLatencyMs;
  const dspActive = Object.values(effects || {}).filter((e) => e && e.enabled).length;

  return (
    <div className="studio-page space-y-4 animate-fade-in-up pb-24">
      {/* Main grid */}
      <div
        className={`grid gap-4 ${
          isSimple
            ? 'grid-cols-1 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)_minmax(0,280px)]'
            : 'grid-cols-1 lg:grid-cols-2 xl:grid-cols-[minmax(0,260px)_minmax(0,1fr)_minmax(0,300px)]'
        }`}
      >
        {/* LEFT — Voice library */}
        <aside className="panel flex max-h-[70vh] flex-col overflow-hidden p-3 xl:max-h-[calc(100svh-11rem)] order-3 lg:order-1">
          <div className="mb-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              Voice library
            </p>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search voices"
              className="mt-2 min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm outline-none focus-visible:border-accent/50"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {GROUPS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGroup(g)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                    group === g
                      ? 'bg-accent/15 text-accent-soft'
                      : 'bg-surface-2/50 text-muted hover:text-ink'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          {!isSimple && recentProfiles.length > 0 && (
            <div className="mb-3 border-b border-line pb-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                Recent
              </p>
              <div className="flex flex-wrap gap-1.5">
                {recentProfiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelectProfile(p)}
                    className={`rounded-lg border px-2 py-1 text-xs font-medium ${
                      activePresetId === p.id
                        ? 'border-accent/50 text-accent-soft'
                        : 'border-line text-muted'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
            {filtered.map((profile) => {
              const { pitch } = profileToVoicePartial(profile, hostPitch?.hz);
              return (
                <VoiceCard
                  key={profile.id}
                  profile={profile}
                  selected={activePresetId === profile.id}
                  pitch={pitch}
                  onSelect={handleSelectProfile}
                />
              );
            })}
            {filtered.length === 0 && (
              <p className="px-1 py-6 text-center text-sm text-muted">
                No voices match.
              </p>
            )}
          </div>
        </aside>

        {/* CENTER — Live hero */}
        <section className="order-1 flex flex-col gap-3 lg:order-2">
          <div className="panel relative flex min-h-[280px] flex-1 flex-col overflow-hidden p-4 sm:min-h-[340px]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                  Live
                </p>
                <h2 className="font-display text-lg font-bold tracking-tight">
                  {live ? 'Transforming' : 'Voice stage'}
                </h2>
              </div>
              <div
                className={`status-pill ${live ? 'status-pill-live' : 'status-pill-off'}`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    live ? 'bg-accent rec-blink' : 'bg-ink/25'
                  }`}
                />
                {live ? 'LIVE' : 'Ready'}
              </div>
            </div>

            <div className="relative min-h-0 flex-1">
              <Visualizer
                getAnalysers={pipeline.getAnalysers}
                isRunning={live}
                hero
              />
              {!live && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                  <p className="font-display text-xl font-bold tracking-tight text-ink sm:text-2xl">
                    Ready to transform your voice
                  </p>
                  <p className="mt-2 max-w-sm text-sm text-muted">
                    Select a voice and press Start
                  </p>
                </div>
              )}
            </div>

            {live && !hearMyself && !pipeline.sendingToDevice && (
              <div
                className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2"
                role="status"
              >
                <p className="text-sm text-ink">
                  You are live, but the speakers are muted. Put on headphones to listen.
                </p>
                <button type="button" className="chip-button" onClick={() => handleHearMyself(true)}>
                  Hear myself
                </button>
              </div>
            )}

            {live && (
              <div className="mt-3 flex gap-4">
                <LevelMeter label="Input" value={pipeline.inputLevel} />
                <LevelMeter label="Output" value={pipeline.outputLevel} tone="out" />
                <div className="shrink-0 text-right">
                  <p className="text-[11px] text-muted">Latency</p>
                  <p className="font-mono text-sm font-semibold tabular-nums">
                    {shownLatency > 0 ? `${Math.round(shownLatency)} ms` : '—'}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[11px] text-muted">Your pitch</p>
                  <p className="font-mono text-sm font-semibold tabular-nums">
                    {pipeline.voicePitchHz > 0 ? `${pipeline.voicePitchHz} Hz` : '—'}
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            {!live ? (
              <button
                type="button"
                onClick={handleStart}
                disabled={starting}
                className="btn-primary text-base tracking-wide"
              >
                {starting ? 'Starting…' : '🎙  Start voice'}
              </button>
            ) : (
              <button type="button" onClick={handleStop} className="btn-stop text-base tracking-wide">
                ●  Stop
              </button>
            )}
            <div className="sm:min-w-[220px] sm:flex-1">
              <Recorder
                compact
                pipeline={pipeline}
                onEnsureStarted={async () => {
                  if (pipeline.isRunning) return;
                  await devices.refresh?.();
                  await pipeline.start(selectedInput || undefined, selectedOutput || undefined);
                }}
              />
            </div>
          </div>

          <div className="panel p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              Quick voices
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {QUICK_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyQuick(p)}
                  aria-pressed={quickId === p.id || activePresetId === p.profileId}
                  className={`min-h-11 shrink-0 rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${
                    quickId === p.id || activePresetId === p.profileId
                      ? 'border-accent/50 bg-accent/12 text-accent-soft'
                      : 'border-line bg-surface text-ink hover:border-ink/25'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-accent"
              checked={hearMyself}
              onChange={(e) => handleHearMyself(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">
                Hear myself
              </span>
              <span className="mt-0.5 block text-xs text-muted">
                {pipeline.sendingToDevice
                  ? hearMyself
                    ? 'Sending to your chosen output and playing a copy on your default speakers.'
                    : 'Your changed voice is going to the output you chose. Turn this on to also hear it yourself.'
                  : hearMyself
                    ? 'Playing your changed voice — use headphones to avoid echo.'
                    : 'Speakers muted. Meters and Record still capture your changed voice.'}
              </span>
            </span>
          </label>

          {error && (
            <div
              className="rounded-xl border border-danger/30 bg-danger/10 p-3"
              role="alert"
            >
              <p className="text-sm text-danger-soft">{error}</p>
            </div>
          )}
        </section>

        {/* RIGHT — Voice Lab */}
        <aside className="order-2 space-y-3 lg:order-3">
          <VoiceLab
            voice={voice}
            onChange={onVoiceChange}
            hasModel={Boolean(activeModel)}
            isRunning={live}
            compact
          />

          <div className="panel p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                  Your voice
                </p>
                <p className="mt-1 text-sm">
                  <span className="font-mono font-semibold tabular-nums">
                    {Math.round(hostPitch?.hz || 0)} Hz
                  </span>{' '}
                  <span className="text-xs text-muted">
                    {hostPitch?.measured ? 'measured' : 'assumed until you talk'}
                  </span>
                </p>
              </div>
              <button type="button" className="chip-button shrink-0" onClick={handleCalibrate}>
                Match my voice
              </button>
            </div>
            <p className="mt-2 text-xs text-muted" aria-live="polite">
              {calibrateNote ||
                'Voices like Female or Deep aim for a target pitch, measured from how you really speak.'}
            </p>
          </div>

          {!isSimple && (
            <div className="panel p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                Devices
              </p>
              <div className="mt-2 space-y-2">
                <select
                  value={selectedInput}
                  onChange={(e) => setSelectedInput(e.target.value)}
                  disabled={live}
                  className="native-select-safe min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm disabled:opacity-50"
                >
                  <option value="">Default microphone</option>
                  {devices.inputDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Mic (${d.deviceId.slice(0, 8)}…)`}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedOutput}
                  onChange={(e) => setSelectedOutput(e.target.value)}
                  disabled={live}
                  className="native-select-safe min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm disabled:opacity-50"
                >
                  <option value="">Default speaker</option>
                  {devices.outputDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Speaker (${d.deviceId.slice(0, 8)}…)`}
                    </option>
                  ))}
                </select>
              </div>
              {devices.error && (
                <p className="mt-2 text-sm text-danger-soft" role="alert">
                  {devices.error}
                </p>
              )}
              <fieldset className="mt-3 space-y-2" disabled={live}>
                <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                  Mic clean-up
                </legend>
                {MIC_OPTIONS.map((opt) => (
                  <label
                    key={opt.key}
                    className={`flex items-start gap-2.5 ${live ? 'opacity-60' : 'cursor-pointer'}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-accent"
                      checked={Boolean(extras?.[opt.key])}
                      onChange={(e) => onExtrasChange({ [opt.key]: e.target.checked })}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">
                        {opt.label}
                      </span>
                      <span className="block text-xs text-muted">{opt.hint}</span>
                    </span>
                  </label>
                ))}
                {live && (
                  <p className="text-xs text-muted">Stop to change these.</p>
                )}
              </fieldset>
            </div>
          )}
        </aside>
      </div>

      {/* Effects */}
      {!isSimple && (
        <section className="panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                Effects
              </p>
              <p className="mt-0.5 text-sm text-muted">
                {modelActive
                  ? 'Applied on the server after the AI model'
                  : 'All effects run live on this device — no server needed'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAdvancedFx((v) => !v)}
              className="chip-button"
              aria-expanded={showAdvancedFx}
            >
              {showAdvancedFx ? 'Hide advanced' : 'Advanced effects →'}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { key: 'gate', label: 'Noise Gate', viaExtras: true },
              { key: 'eq', label: 'Tone EQ' },
              { key: 'compressor', label: 'Compressor' },
            ].map((item) => {
              const on = item.viaExtras
                ? Boolean(extras.blockBackground)
                : Boolean(effects?.[item.key]?.enabled);
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    if (item.viaExtras) {
                      onExtrasChange({
                        blockBackground: !extras.blockBackground,
                        vadEnabled: !extras.blockBackground,
                      });
                    } else {
                      toggleEffect(item.key);
                    }
                  }}
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                    on
                      ? 'border-accent/45 bg-accent/12 text-accent-soft'
                      : 'border-line text-muted'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          {(showAdvancedFx || isAdvanced) && (
            <div className="mt-4">
              <EffectsRack
                effects={effects}
                formantShift={voice.formant}
                onEffectsChange={onEffectsChange}
                embedded
              />
            </div>
          )}
        </section>
      )}

      {/* Advanced extras (server-backed panels are safe when API is offline) */}
      {isAdvanced && (
        <ErrorBoundary>
          <div className="space-y-4">
            <BackgroundBlocker
              enabled={Boolean(extras?.blockBackground)}
              thresholdDb={Number(extras?.vadThresholdDb) || -56}
              gateOpen={pipeline.gateOpen}
              levelDb={pipeline.gateLevelDb}
              onChange={(partial) => {
                onExtrasChange({
                  blockBackground: partial.enabled ?? extras.blockBackground,
                  vadThresholdDb: partial.thresholdDb ?? extras.vadThresholdDb,
                  vadEnabled: partial.enabled ?? extras.blockBackground,
                });
              }}
            />
            <StreamExtras
              vadEnabled={extras?.vadEnabled}
              vadThresholdDb={extras?.vadThresholdDb}
              latencyMode={extras?.latencyMode}
              crossfadeMs={extras?.crossfadeMs ?? 8}
              extraBufferChunks={extras?.extraBufferChunks ?? 1}
              onChange={onExtrasChange}
              onApplyLatencyMode={onApplyLatencyMode}
              getSnapshot={getProfileSnapshot}
              disabled={live}
            />
            <PresetBar
              activePresetId={activePresetId}
              onApplyPreset={applyPreset}
              getCurrentSettings={getCurrentSettings}
            />
          </div>
        </ErrorBoundary>
      )}

      {/* Bottom status bar */}
      <div className="studio-status-bar">
        <div className="mx-auto flex w-full max-w-[1560px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-xs sm:px-6 lg:px-8">
          <span className={`inline-flex items-center gap-1.5 font-semibold ${live ? 'text-accent-soft' : 'text-muted'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-accent rec-blink' : 'bg-ink/30'}`} />
            {live ? 'LIVE' : 'IDLE'}
          </span>
          <span className="text-muted">
            Mic{' '}
            <strong className="font-medium text-ink">
              {devices.inputDevices.find((d) => d.deviceId === selectedInput)?.label || 'Default'}
            </strong>
          </span>
          <span className="text-muted">
            Speaker{' '}
            <strong className="font-medium text-ink">
              {devices.outputDevices.find((d) => d.deviceId === selectedOutput)?.label || 'Default'}
            </strong>
          </span>
          <span className="text-muted">
            Latency{' '}
            <strong className="font-mono font-medium text-ink">
              {shownLatency > 0 ? `${Math.round(shownLatency)}ms` : '—'}
            </strong>
            {serverMs > 0 ? (
              <span className="ml-1 opacity-70">· srv {Math.round(serverMs)}ms</span>
            ) : null}
          </span>
          <span className="text-muted">
            Model{' '}
            <strong className="font-medium text-ink">
              {modelActive ? activeModel : 'Built-in engine'}
            </strong>
          </span>
          <span className="text-muted">
            DSP{' '}
            <strong className="font-medium text-ink">
              {dspActive > 0 ? `${dspActive} on` : 'off'}
            </strong>
          </span>
          <span className="text-muted">
            Server{' '}
            <strong className="font-medium text-ink">
              {wsStatus === 'connected' ? 'connected' : 'not needed'}
            </strong>
          </span>
          {pipeline.isRecording && (
            <span className="ml-auto font-mono font-semibold text-danger-soft">
              ● REC {Math.floor((pipeline.recordSeconds || 0) / 60)}:
              {String(Math.floor((pipeline.recordSeconds || 0) % 60)).padStart(2, '0')}
            </span>
          )}
          {!pipeline.isRecording && runtimeConfig?.sampleRate && (
            <span className="ml-auto text-muted">
              {modelActive ? `${runtimeConfig.sampleRate} Hz · mode ${serverStats?.mode || 'model'}` : 'On-device'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
