# Browser checks

End-to-end checks used during development. They drive the real app in headless
Chromium with a fake microphone that plays a synthetic voice, then measure the
recorded output. They are not part of `npm test`.

## Setup

1. Start the app: `cd frontend && npx vite --port 5173`
2. Have Playwright with Chromium available (`npm i -D playwright` in a scratch
   folder, or a global install). The scripts `import pw from 'playwright'`.
3. Make the fake mic file once. Each script takes a work folder `<dir>` as its
   first argument and reads `<dir>/mic.wav`, writing screenshots there too:

```bash
mkdir -p /tmp/bv && node dev/checks/mkwav.mjs /tmp/bv/mic.wav
```

## Scripts

| Script | Checks |
|--------|--------|
| `e2e.mjs <dir>` | Start, pick voices, record; prints pitch per voice (Female ≈ 200 Hz, Deeper ≈ 87, Chipmunk ≈ 318, Whisper unpitched) |
| `conv.mjs <dir>` | Converter renders a file in the browser with the Deeper voice |
| `route.mjs <dir>`, `route2.mjs <dir>` | Output device routing, Hear myself text, mic clean-up options |
| `hear.mjs <dir>` | "Live but muted" notice on a phone viewport |
| `wake.mjs <dir>` | Screen wake lock taken on Start, released on Stop |
| `gate.mjs <dir>` | Effects rack Noise Gate switch toggles; Models tab offline |
| `shots.mjs <dir> <tag>` | Studio + settings screenshots, light and dark |
| `readme_shots.mjs <dir> docs/assets` | Regenerates the README screenshots |

## Colour class migration

`migrate_colors.py <src dir> [--write]` renames `X-[color:var(--name)]` Tailwind
classes to the named theme colours in `tailwind.config.js`. Tailwind 3 emits no
CSS for `X-[color:var(--name)]/NN`, so those tints never rendered. Dry run first.
