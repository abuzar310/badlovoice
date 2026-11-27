# Progress

- Cloned + analyzed Vonovox, w-okada/voice-changer, echidna, OpenVoiceChanger
- Chose OVC as MIT merge base
- Added slots, profiles, latency modes, VAD WS settings
- Frontend rebranded Shiftbooth + SlotBay + StreamExtras
- Docs: findings, attribution, README

## Pass 2 — A-to-Z quality pass

- Built the in-browser voice engine and its tests; removed the old monitor worklet
- Fixed routing: single audible source, recordings no longer silent, voice reaches a chosen output device
- Presets follow the measured speaking pitch; new voices (Alien, Demon, Ghost, Cave, Megaphone, Narrator)
- Converter renders in the browser; restyled for both themes
- Recorder tap moved to the audio thread
- Removed four unused components and a duplicate worklet
- Launched parallel audits: backend, server panels, app shell, mobile, engine review
- Found that colour classes with opacity never rendered; migration script ready

### Verification so far

| Check | Result |
|-------|--------|
| `npm test` (engine) | 24 pass, 0 fail |
| `vite build` | passes |
| Browser, fake mic, no backend | Female 203 Hz, Deeper 87 Hz, Chipmunk 318 Hz, Whisper unpitched; recording works with speakers muted |
| Converter, 6 s file | 0.2 s, pitch on target |
| Chosen output device | voice routed, monitor toggles, no page errors |

### Later in pass 2

- Output routing to a chosen device; mic clean-up options; wake lock while live
- Audits merged: backend (433 tests), server panels (offline-capable), mobile (share sheet in apps)
- App shell audit and engine review were stopped by the owner before reporting
- Browser checks and the colour migration script moved into `dev/checks/`
- Hand-over and open items: `task_plan.md`, section "Hand-over"
