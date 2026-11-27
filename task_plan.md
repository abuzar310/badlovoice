# Task Plan — Shiftbooth merge

## Goal

One product: Shiftbooth realtime voice changer with best features from OVC / w-okada / Vonovox / echidna.

## Phases

### Phase 1 — Scaffold monorepo ✅
- [x] Research clones + findings
- [x] Copy OVC backend + frontend skeleton
- [x] Keep Shiftbooth brand / CSS tokens
- [x] ATTRIBUTION.md

### Phase 2 — Backend merge ✅
- [x] FastAPI app branded Shiftbooth
- [x] Model slots (5) on SlotManager
- [x] Latency modes → chunk defaults
- [x] VAD/noise-gate settings on WS config
- [x] Profiles API
- [x] Crossfade/extra-buffer settings on WS

### Phase 3 — Frontend merge ✅
- [x] AudioWorklet + WS pipeline from OVC
- [x] Studio: devices, VU, spectrum, latency
- [x] Effects rack + presets
- [x] Model bay with slots
- [x] File converter
- [x] Profiles + latency mode selector
- [x] VAC / routing guide panel

### Phase 4 — Verify ✅
- [x] Frontend build
- [x] Backend syntax smoke
- [x] README run instructions

## Status

Merge v1 complete. RVC GPU path needs local `hubert_base.pt` + optional RVC pip install.

---

# Pass 2 — A-to-Z quality pass

## Goal

Every part of BadloVoice works as described, with no backend required for the core voice changer: browser, hosted site and Android.

## Current Phase

Phase 7

## Phases

### Phase 5 — In-browser voice engine
- [x] Pitch + formant shifter with pitch tracker (`frontend/public/voiceEngineCore.js`)
- [x] Whole effects rack in the browser, same order and parameters as the Python rack
- [x] Presets aim from the user's measured speaking pitch
- [x] Voice library rebuilt; file converter renders in the browser
- [x] `npm test` suite for the engine
- **Status:** complete

### Phase 6 — Routing, recorder, converter
- [x] One audible source at a time (local engine or server model)
- [x] Voice always reaches a chosen output device; Hear myself is a separate monitor
- [x] Recordings and meters work with speakers muted
- [x] Recorder tap on the audio thread
- [x] Mic clean-up options (noise suppression, echo cancellation, auto level)
- [x] Converter readable in both themes
- **Status:** complete

### Phase 7 — Parallel audits (one agent per area)
- [ ] Backend: defects, security (vibe-sec), pytest suite
- [ ] Server-backed panels + API layer: sensible with no backend
- [ ] App shell: visual, phone layout, accessibility (impeccable)
- [ ] Android + Expo wrapper + saving recordings on phones
- [ ] Independent review of the audio engine
- **Status:** in_progress

### Phase 8 — Colour tokens
- [ ] Named theme colours in `tailwind.config.js`
- [ ] Rename every `[color:var(--x)]` class across `src/`
- [ ] Re-check both themes once the missing tints render
- **Status:** pending

### Phase 9 — Integration and verification
- [ ] Check each agent's diff against its report
- [ ] Engine review findings: reproduce, then fix with a failing test first
- [ ] Full run: engine tests, backend tests, build, browser end-to-end
- **Status:** pending

### Phase 10 — Docs and final review
- [ ] README, MODELS, CONTRIBUTING match the code; fresh screenshots
- [ ] Code review of the whole branch; fix findings
- **Status:** pending

## Decisions

| Decision | Why |
|----------|-----|
| Pitch-synchronous overlap-add shifter | Formants stay put when pitch moves, about 22 ms latency, cheap enough for phones |
| Server used only while an AI model is active | The browser engine covers pitch, formant and effects; no audio leaves the device otherwise |
| Mic processing stays off by default | Same raw-mic default as before; options are one tap away |
| Keep the cream / orange identity | The brand and logo are the owner's; this pass polishes, it does not redesign |

## Errors Encountered

| Error | Resolution |
|-------|------------|
| Could not install a speech synthesiser or download speech samples (refused) | Tests use synthetic speech-like signals; real-voice listening still needed |
| Offline file render ignored the chosen voice | Settings arrived after rendering started; now passed with the node at construction |
| Colour classes with opacity never rendered | Tailwind 3 emits nothing for `[color:var(--x)]/NN`; migrating to named colours (Phase 8) |

