# Contributing to BadloVoice

Thanks for helping. The goal is a **local-first realtime voice changer** that is easy on a phone and still gives full control on desktop.

## Before you start

1. Open an [issue](https://github.com/abuzar310/badlovoice/issues) for big ideas so we can align.
2. Keep pull requests focused: one problem or feature each.
3. Never commit secrets (`.env`, `secrets/`, OAuth JSON, API keys, model weights under `models/` except documented assets placeholders).

## Dev setup

The UI and the built-in voice engine need only Node.js:

```powershell
cd frontend
npm install
npm run dev
```

The backend is needed only for AI voice models:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

## Tests

```powershell
cd frontend
npm test
```

This runs the voice engine suite in Node. If you change `frontend/public/voiceEngineCore.js`, add a test that fails without your change.

## What to work on

| Area | Ideas |
|------|--------|
| UI | First-run copy, empty states, phone layout, accessibility |
| Audio | New voices and effects, pitch tracking on difficult voices, latency |
| Models | Clearer install docs, sample model links (respect licenses) |
| Android | Release signing docs, permissions UX |
| Docs | Screenshots, Discord VAC videos, non-Windows install |

## PR checklist

- [ ] Runs locally (`npm run dev`; plus uvicorn if you touched the backend)
- [ ] `npm test` passes in `frontend/`
- [ ] Checked in both the light and the dark theme, on a phone-width window
- [ ] No secrets or large binary dumps
- [ ] UI uses the theme colours from `tailwind.config.js` (`text-ink`, `bg-accent/12`, ...), not hard-coded colours
- [ ] Credit upstream if you port a pattern (see [ATTRIBUTION.md](ATTRIBUTION.md))

## Code of conduct

Be respectful. No harassment. Assume good intent. Maintainers may close off-topic or unsafe PRs.
