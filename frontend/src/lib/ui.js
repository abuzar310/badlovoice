// Class strings the server-backed panels share, so the same thing looks the
// same in each of them. Buttons, labels, switches and panels come from
// index.css (chip-button, field-label, switch, panel); colours are the theme
// names from tailwind.config.js.

/** A text input. Add `native-select-safe` for a <select>. */
export const FIELD =
  'min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50';

/** The one main action of a small form. */
export const BUTTON_PRIMARY =
  'inline-flex min-h-[var(--tap)] items-center justify-center rounded-xl bg-accent px-4 py-1.5 text-sm font-semibold text-[#1f120c] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45';

/** A quiet block for something the user should read. */
export const NOTE = 'rounded-xl border border-line bg-surface-2/50 px-4 py-3';

/** Something went wrong. */
export const ALERT = 'rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger-soft';

const PILL = 'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium';
export const BADGE = `${PILL} border-line text-muted`;
/** "This one is on." */
export const BADGE_ON = `${PILL} border-success/50 bg-success/15 text-ink`;

/** One of several options, like the quick-voice chips in the Studio. Pair with aria-pressed. */
export const OPTION = 'border-line bg-surface text-ink hover:border-ink/25';
export const OPTION_ON = 'border-accent/50 bg-accent/12 text-accent-soft';
