import React from 'react';

const STATUS = {
  connected: { dot: 'bg-success', label: 'Server' },
  connecting: { dot: 'bg-accent', label: 'Connecting' },
  disconnected: { dot: 'bg-success', label: 'On-device' },
  error: { dot: 'bg-success', label: 'On-device' },
};

// Header status: where the voice is processed, and with which engine or model.
export default function StatusIndicator({ wsStatus, activeModel, mode }) {
  const status = STATUS[wsStatus] || STATUS.disconnected;
  const connecting = wsStatus === 'connecting';
  const engine = activeModel ? (mode === 'onnx' ? 'ONNX' : 'RVC') : null;

  // Below 1280px the header has no room to spare, so the pill only shows for
  // the one state worth knowing there: a live server link. The Studio status
  // readout says "on-device" at every size.
  const visibility = wsStatus === 'connected' ? 'flex' : 'hidden xl:flex';

  return (
    <div className={`${visibility} min-w-0 items-center gap-2`}>
      <div
        className="flex min-h-9 items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5"
        title={wsStatus === 'connected' ? 'Connected to the desktop server' : undefined}
      >
        <span className="relative flex h-2 w-2" aria-hidden="true">
          {connecting && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${status.dot}`} />
        </span>
        {/* Between 1024 and 1280px the bar only has room for the dot; the word stays for screen readers. */}
        <span className="whitespace-nowrap text-[13px] font-semibold text-ink lg:max-xl:sr-only">
          {status.label}
        </span>
      </div>

      <div
        className="hidden min-h-9 min-w-0 items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 xl:flex"
        title={activeModel || 'Built-in voice engine — runs on this device'}
      >
        {engine && <span className="text-[13px] font-semibold text-ink">{engine}</span>}
        <span className="max-w-[160px] truncate text-[13px] text-muted">
          {activeModel || 'Built-in engine'}
        </span>
      </div>
    </div>
  );
}
