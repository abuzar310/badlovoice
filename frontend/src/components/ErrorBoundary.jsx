import React from 'react';

// Settings the app keeps in localStorage. A damaged or outdated value is the
// usual reason a crash survives a reload, so the full-page fallback can drop
// them. The theme choice is harmless and is kept.
const SETTING_PREFIXES = ['shiftbooth_', 'badlovoice_'];
const KEEP_KEYS = ['badlovoice_theme'];

function clearSavedSettings() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && !KEEP_KEYS.includes(key) && SETTING_PREFIXES.some((p) => key.startsWith(p))) {
        keys.push(key);
      }
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Storage blocked: the reload below is still worth trying.
  }
}

function reload() {
  window.location.reload();
}

/**
 * Catches render errors below it.
 *  - default: the failed panel is replaced by a small notice, the rest of the page keeps working.
 *  - fullPage: used once at the root, so a crash never leaves a blank screen.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('UI error boundary:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const detail = error?.message || 'Unknown error';

    if (this.props.fullPage) {
      return (
        <main
          className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-6 py-10"
          role="alert"
        >
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            BadloVoice stopped working
          </h1>
          <p className="text-sm text-muted">
            The page hit an error and cannot continue. Reload to start again. If it comes back,
            reset the saved settings: a damaged setting is the usual cause.
          </p>
          <p className="break-words rounded-xl border border-line bg-surface px-3 py-2 font-mono text-xs text-muted">
            {detail}
          </p>
          <button type="button" className="btn-primary" onClick={reload}>
            Reload
          </button>
          <button
            type="button"
            className="chip-button"
            onClick={() => {
              clearSavedSettings();
              reload();
            }}
          >
            Reset saved settings and reload
          </button>
        </main>
      );
    }

    return (
      <div className="panel p-4" role="alert">
        <h2 className="panel-title">This panel stopped working</h2>
        <p className="mt-1 text-sm text-muted">
          The rest of the page still works. Try the panel again, or reload the page.
        </p>
        <p className="mt-2 break-words font-mono text-xs text-muted">{detail}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="chip-button"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button type="button" className="chip-button" onClick={reload}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
