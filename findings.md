# Findings — voice changer repo merge

## Sources

| Repo | Path | License | Role |
|------|------|---------|------|
| OpenVoiceChanger | `.research/OpenVoiceChanger` | MIT | **Primary architecture** |
| w-okada/voice-changer | `.research/voice-changer` | custom/CLA | Slots, SOLA/crossfade, multi-engine, remote client |
| Vonovox | `.research/Vonovox` | (source mostly Cython `.pyd`) | CUDA latency, VAD, RNNoise, AP-BWE, VAC routing |
| echidna | `.research/echidna` | see license.md | Latency modes, profiles, system routing concepts |

## Best-at matrix

| Capability | Winner | Why |
|------------|--------|-----|
| Web stack (React+WS+AudioWorklet) | OpenVoiceChanger | Clean FastAPI, binary WS protocol, DSP passthrough |
| Model slots / remote PC split | w-okada | Slot manager, server-device mode, multi-VC engines |
| Lowest CUDA latency / quality | Vonovox | Full GPU pipeline, FCPE/RMVPE, Cython, AP-BWE 48k |
| System-wide / call injection | echidna | Zygisk/AAudio hooks — Android only |
| Effects rack + presets | OpenVoiceChanger | 12 streaming DSP FX + 16 presets, model-free mode |
| Offline file convert | OpenVoiceChanger | Upload → model+FX → WAV |
| Crossfade/SOLA seamlessness | w-okada | VoiceChangerV2 sola + crossfade |
| Mic noise / talk detect | Vonovox | RNNoise + Silero VAD |

## Cannot literally merge

- Vonovox core is compiled `.pyd` (no portable source) + NVIDIA-only
- echidna is Android Magisk/Zygisk — transfer **concepts only**
- w-okada full multi-engine stack is huge; take patterns not whole tree

## Merge decision

Build **Shiftbooth** as OVC-based monorepo + Shiftbooth UI + ported concepts:

1. OVC: WS pipeline, DSP rack, models, presets, recorder, offline convert
2. w-okada: model slots, latency/chunk profiles, crossfade settings UI
3. Vonovox: VAD gate, noise reduction emphasis, VAC setup docs, SR flexibility
4. echidna: LatencyMode + Settings profiles + telemetry strip

---

# Pass 2 findings — what was actually broken

| Area | Finding | Evidence |
|------|---------|----------|
| Hosted site / APK | Only a two-tap delay pitch shift and a mild ring-mod ran without the backend. Formant and 10 of 12 effects did nothing, so most voices sounded alike. | `dspMonitorWorklet.js` (removed) handled `pitch` and `robot` only |
| Audio routing | With a backend connected and no model, the local monitor and the server return were both audible: doubled voice with a delay. | Both gains were 1.0 in `applyOutputGains` |
| Recorder | Takes were silent whenever Hear myself was off (the default). The output meter was dead too. | The recorder tapped the bus after the monitor gains |
| Discord / virtual cable | Nothing reached the selected output device unless Hear myself was ticked. | Same gains muted the only path to the device |
| Presets | Every preset assumed a 120 Hz speaker, so "Female" pushed a high voice far too high. | `DEFAULT_HOST_HZ` used for all shifts |
| File converter | Needed the backend; failed on the hosted site. | Called `/api/convert` only |
| UI colours | About 50 lines of tints (selected chips, error boxes, focus borders) never rendered. | Tailwind 3 emits no rule for `X-[color:var(--name)]/NN`; computed styles show the default border and a transparent background |
| Settings dialog | No dimmed backdrop. | `bg-black/72` is not in the default opacity scale, so no rule |
| Converter (light theme) | Result file name unreadable, Convert button white on cream. | Hard-coded dark-theme classes |
| README screenshot | Shows a Simple home screen that no longer exists. | `SimpleHome.jsx` was not imported anywhere |

## Engine design notes

- Shifter: two-period Hann grains cut at multiples of the tracked period. Grain spacing sets pitch; resampling each grain sets formants.
- Tracker: normalised autocorrelation on a low-passed 8 kHz copy, first strong peak, octave-jump guard, voiced/unvoiced hysteresis.
- Unvoiced sound passes through at 50 % overlap so consonants do not turn into a buzz.
- Measured on synthetic speech: pitch within 0.15 semitones, over 90 % of voiced frames on the target pitch, under 3 % leaking the original.
- Not yet verified by ear on real recordings.
