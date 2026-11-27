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

Phase 9 (integration). Phases 7 and 8 partly done; see the open items below.

## Hand-over: where things stand

Branch `claude/adoring-clarke-6c84rz`. Everything is committed and pushed.
Read this section first in a new session.

### How to verify the tree

- `cd frontend && npm test`: engine + API layer tests (35 at last run, all passing)
- `cd frontend && npx vite build`
- `npm run test:backend` from the repo root, after `pip install -r backend/requirements-dev.txt` (433 passing)
- Browser checks: `dev/checks/README.md`

### Phases

### Phase 5 — In-browser voice engine — complete
### Phase 6 — Routing, recorder, converter — complete

### Phase 7 — Parallel audits
- [x] Backend: security (cross-site API control, bind address), RVC chunk bug, upload data loss, store crash safety, 433 tests
- [x] Server panels + API layer: work with no backend, presets/profiles saved on device, timeouts, real upload progress
- [x] Android + Expo + saving recordings: share sheet in both apps, wrapper hardening (not tested on a device)
- [ ] App shell / visual / accessibility: STOPPED part-way. Last commit `bff0cc4` holds its unfinished `index.css` and `ErrorBoundary.jsx` edits, not built or tested after that point. First job in a new session: build, run `dev/checks/shots.mjs`, look at both themes.
- [ ] Independent audio engine review: STOPPED, no report. Re-run if wanted.
- **Status:** in_progress

### Phase 8 — Colour tokens
- [x] Named theme colours in `tailwind.config.js`
- [x] Most of `src/` migrated
- [ ] `frontend/src/components/Recorder.jsx`: 11 classes left (`python3 dev/checks/migrate_colors.py frontend/src --write`)
- [ ] Re-check both themes
- **Status:** in_progress

### Phase 9 — Integration — open items
- [ ] Dark theme legibility in shared classes (`frontend/src/index.css`): `.btn-stop` (pale slab, unreadable text), `.chip-button`, `.btn-record`, `.status-pill-live`, `.voice-chip`, header buttons. Cause: `color-mix(... white)` and light-theme constants inside shared classes. Check whether the stopped shell agent already fixed some.
- [ ] Small uppercase "eyebrow" labels above every Studio panel (`text-[11px] font-semibold uppercase tracking-[0.14em]` in `StudioPage.jsx`): replace with one plain heading per panel (owner's design skills ban the pattern).
- [ ] VoiceLab pitch slider is -12..+12 but presets set up to ±16; widen to ±16.
- [ ] Level meters animate `width` (`index.css` `.level-fill`); use a transform.
- [ ] README screenshots: retake with `dev/checks/readme_shots.mjs` once the UI settles.
- **Status:** pending

### Phase 10 — Final review
- [ ] Code review of the whole branch (`55d8dad..HEAD`); fix findings
- [ ] Open a pull request only if the owner asks
- **Status:** pending

### Owner decisions waiting
- 8 of the 12 built-in presets duplicate voice-library voices: trim or keep.
- Backend: `torch.load(weights_only=False)` in `rvc_processor.py` runs code from a loaded `.pth`; switch to `weights_only=True` after testing real models.
- Backend: DNS rebinding still possible; `TrustedHostMiddleware` would close it but blocks LAN access by IP until listed.
- Backend: `fairseq` installs from an unpinned git branch; pin a commit.
- Backend: `latency_mode`, `crossfade_ms`, `extra_buffer_chunks` are stored and echoed but never used; remove or implement.
- Backend: server-side DSP pitch shifter is poor (+12 st on 220 Hz gives 408 + 471 Hz); only used with a server and no model. Port the browser shifter or drop it.
- Android: release signing, AAB for Play, privacy policy (app records audio), version numbers.
- Android: `npm run apk` is Windows-only; a cross-platform command is in the mobile notes below.
- Expo: `eas.json` development profile needs `expo-dev-client` or removal; SafeAreaView from `react-native-safe-area-context` for edge-to-edge.
- Look: the cream + orange theme is a common generated-design default per the owner's design skills; kept as the brand. Offer a distinctive restyle if wanted.

### Owner must test on real hardware
- Android APK (`cd frontend && npm install && npm run apk`, JDK 21): Start, mic prompt, Record, Share, Back leaves the app, splash. If Gradle fails, try AGP 8.13.0 / Gradle 8.14.3 (Capacitor 8.5 template).
- Expo wrapper: deploy the site first, then `cd mobile && npm ci && npx expo-doctor && npm run apk:preview`.
- Real RVC / ONNX model end to end (backend fixes were tested against a stand-in pipeline).
- Listen to the built-in voices with a real voice; tests use synthetic speech only.

### Mobile notes
Cross-platform `apk` script, untested on Windows:
`"apk": "npm run mobile:sync && node -e \"process.exit(require('child_process').spawnSync(process.platform==='win32'?'gradlew.bat':'./gradlew',['assembleDebug'],{cwd:'android',stdio:'inherit',shell:true}).status??1)\""`

### Skills
The owner's skills live in the public repo `abuzar310/agent-skills-starter` (`skills/<name>/SKILL.md`).
Used here: impeccable, frontend-design, vibe-sec, ponytail, systematic-debugging,
test-driven-development, verification-before-completion, dispatching-parallel-agents,
requesting-code-review, agency-accessibility-auditor, agency-mobile-app-builder,
agency-mobile-release-engineer, agency-code-reviewer, stop-slop, planning-with-files.
Run impeccable's scripts with `IMPECCABLE_NO_UPDATE_CHECK=1` (otherwise one phones home).

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

