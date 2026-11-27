import React from 'react';

const STATUS_CONFIG = {
  connected: { color: 'bg-[color:var(--success)]', label: 'Server' },
  connecting: { color: 'bg-amber-500', label: 'Connecting' },
  disconnected: { color: 'bg-[color:var(--success)]', label: 'On-device' },
  error: { color: 'bg-[color:var(--success)]', label: 'On-device' },
};

// Compact header status: connection dot, engine mode, active model.
export default function StatusIndicator({ wsStatus, activeModel, mode }) {
  const config = STATUS_CONFIG[wsStatus] || STATUS_CONFIG.disconnected;
  const engineLabel = activeModel
    ? (mode === 'onnx' ? 'ONNX' : 'RVC')
    : 'Local';

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 rounded-xl border border-[color:var(--line)] bg-[color:var(--surface)] px-2.5 py-1.5">
        <div className="relative">
          <div className={`h-2 w-2 rounded-full ${config.color}`} />
          {wsStatus === 'connecting' && (
            <div className={`absolute inset-0 h-2 w-2 rounded-full ${config.color} animate-ping opacity-75`} />
          )}
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--ink-text)]">
          {config.label}
        </span>
      </div>

      <div
        className="hidden items-center gap-2 rounded-xl border border-[color:var(--line)] bg-[color:var(--surface)] px-2.5 py-1.5 md:flex"
        title={activeModel || 'Built-in voice engine — runs on this device'}
      >
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--ink-text)]">
          {engineLabel}
        </span>
        <span className="max-w-[160px] truncate text-[11px] text-[color:var(--muted)]">
          {activeModel || 'Built-in engine'}
        </span>
      </div>
    </div>
  );
}
