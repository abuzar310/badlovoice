/** @type {import('tailwindcss').Config} */

// Theme colours are the CSS variables from src/index.css, so every utility
// follows the light/dark theme. They go through color-mix so that opacity
// modifiers work: `bg-accent/12`, `border-ink/25`, `text-muted`.
// (Tailwind cannot apply `/NN` to an arbitrary `[color:var(--x)]` value — it
// silently emits no rule at all — so always use these names for tints.)
const v = (name) => `color-mix(in srgb, var(--${name}) calc(<alpha-value> * 100%), transparent)`;

// Every whole percent is a valid opacity step, so `/12` or `/92` compile.
const everyPercent = Object.fromEntries(
  Array.from({ length: 99 }, (_, i) => [i + 1, String((i + 1) / 100)])
);

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  // The theme switch sets data-theme on <html>, so `dark:` follows it.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      opacity: everyPercent,
      colors: {
        ink: v('ink-text'),
        muted: v('muted'),
        line: v('line'),
        surface: v('surface'),
        'surface-2': v('surface-2'),
        accent: v('accent'),
        'accent-soft': v('accent-soft'),
        success: v('success'),
        danger: v('danger'),
        'danger-soft': v('danger-soft'),
        mic: v('mic'),
      },
      keyframes: {
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        // No fill mode on purpose: a transform that stays applied after the
        // animation turns the page into the containing block for its
        // position:fixed children (the Studio status bar).
        'fade-in-up': 'fade-in-up 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
