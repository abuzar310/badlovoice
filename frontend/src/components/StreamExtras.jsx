import React, { useEffect, useState } from 'react';
import { deleteProfile, fetchLatencyModes, fetchProfiles, saveProfile } from '../lib/api';
import useServerStatus from '../hooks/useServerStatus';
import useSavedItems from '../hooks/useSavedItems';
import { localProfiles } from '../lib/savedSettings';
import { OPTION, OPTION_ON } from '../lib/ui';
import { SavedSettings } from './PresetBar';

const REMOTE_PROFILES = { list: fetchProfiles, save: saveProfile, remove: deleteProfile };

// Plain words for the server's latency modes, by id.
const DELAY_WORDS = {
  ultra: ['Fastest', 'Least delay. Can crackle on a slow computer.'],
  balanced: ['Balanced', 'Right for most computers.'],
  quality: ['Smoothest', 'Most delay, fewest glitches.'],
};

// How much audio goes to the server at a time. It only matters while a voice
// model there is doing the work, so it is hidden when there is no server.
function ServerDelay({ chunkSize, sampleRate, onApply, disabled }) {
  const { online } = useServerStatus();
  const [modes, setModes] = useState([]);

  useEffect(() => {
    if (!online) return undefined;
    let current = true;
    fetchLatencyModes()
      .then((list) => current && setModes(Array.isArray(list) ? list : []))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [online]);

  if (!online || modes.length === 0) return null;

  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="panel-title">Delay with a voice model</h2>
      <p className="mt-1 max-w-[65ch] text-pretty text-sm text-muted">
        A voice model on the server works on your voice in chunks. Small chunks keep the delay
        short. Large ones are steadier on a slow computer.
      </p>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {modes.map((mode) => {
          const [label, blurb] = DELAY_WORDS[mode.id] || [mode.label, mode.blurb];
          const chosen = mode.chunk_size === chunkSize;
          const ms = sampleRate ? Math.round((mode.chunk_size / sampleRate) * 1000) : null;
          return (
            <button
              key={mode.id}
              type="button"
              disabled={disabled}
              aria-pressed={chosen}
              onClick={() => onApply(mode)}
              className={`rounded-xl border px-3.5 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                chosen ? OPTION_ON : OPTION
              }`}
            >
              <span className="block text-sm font-semibold text-ink">
                {label}
              </span>
              <span className="mt-0.5 block text-xs font-normal text-muted">
                {blurb}
                {ms ? ` About ${ms} ms per chunk.` : ''}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">
        {disabled
          ? 'Stop the voice changer to change this.'
          : 'Used from the next time you press Start.'}
      </p>
    </section>
  );
}

// Sending the changed voice into another app means playing it into a virtual
// cable, which needs a browser that can pick the output device.
function OtherApps() {
  const canPickOutput = typeof window.AudioContext?.prototype?.setSinkId === 'function';

  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="panel-title">Use your voice in Discord, games and calls</h2>
      {canPickOutput ? (
        <ol className="mt-3 max-w-[65ch] list-decimal space-y-1.5 pl-5 text-sm text-ink">
          <li>Install a virtual audio cable on your computer. VB-Cable is a free one.</li>
          <li>
            Under Devices, choose the cable as your speaker (it is listed as CABLE Input). If the
            list is empty, press Start once to allow the microphone, then Stop.
          </li>
          <li>In the other app, choose the cable as your microphone (CABLE Output).</li>
          <li>Press Start. Turn on Hear myself to listen to what the others hear.</li>
        </ol>
      ) : (
        <p className="mt-1 max-w-[65ch] text-pretty text-sm text-muted">
          Sending your changed voice into another app needs Chrome or Edge on a computer. Here you
          can still record it and share the recording.
        </p>
      )}
    </section>
  );
}

/**
 * The Advanced extras that sit between the noise gate and the presets:
 * the server delay (only with a server), the guide for other apps, and profiles.
 */
export default function StreamExtras({ onChange, onApplyLatencyMode, getSnapshot, disabled }) {
  const profiles = useSavedItems(localProfiles, REMOTE_PROFILES);
  const snapshot = getSnapshot();

  return (
    <>
      <ServerDelay
        chunkSize={snapshot.chunk_size}
        sampleRate={snapshot.sample_rate}
        onApply={onApplyLatencyMode}
        disabled={disabled}
      />
      <OtherApps />
      <SavedSettings
        title="Profiles"
        description="A profile keeps the whole setup as it is now: voice, effects, noise gate and mic clean-up. Load one to get it all back."
        noun="profile"
        saved={profiles}
        getSettings={getSnapshot}
        onApply={(profile) => {
          onChange({ applyProfile: profile.settings });
          return `Loaded "${profile.name}".`;
        }}
      />
    </>
  );
}
