import React from 'react';
import useServerStatus from '../hooks/useServerStatus';
import { BADGE, BADGE_ON } from '../lib/ui';

function Engine({ name, state, inUse, children }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">{name}</h3>
        <span className={inUse ? BADGE_ON : BADGE}>{state}</span>
      </div>
      <p className="mt-1.5 max-w-[60ch] text-pretty text-sm text-muted">{children}</p>
    </div>
  );
}

/**
 * The two ways a voice gets changed, and which one is doing the work now.
 * `hasModel` is true while a voice model is active on the server.
 */
export default function EngineModes({ hasModel }) {
  const { online } = useServerStatus();
  const modelInUse = online && hasModel;

  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="panel-title">How your voice is changed</h2>
      <div className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-2">
        <Engine
          name="Built-in engine"
          state={modelInUse ? 'Standing by' : 'In use'}
          inUse={!modelInUse}
        >
          Runs on this device. It shifts pitch and formant and adds effects with almost no delay.
          You still sound like you, only higher, lower or styled.
        </Engine>
        <Engine
          name="AI voice model"
          state={modelInUse ? 'In use' : online ? 'No model active' : 'Needs the desktop server'}
          inUse={modelInUse}
        >
          Runs on the BadloVoice desktop server. A trained model swaps your voice for a different
          one. It is quickest with a graphics card; on a CPU expect a second or more of delay.
        </Engine>
      </div>
    </section>
  );
}
