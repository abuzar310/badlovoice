# Attribution

BadloVoice (first developed as Shiftbooth) merges ideas and MIT-licensed code from open-source voice changers.

## OpenVoiceChanger (primary architecture)

- Repo: https://github.com/sioaeko/OpenVoiceChanger
- License: MIT (Copyright 2024 Sioaeko)
- Used: FastAPI backend, WebSocket binary audio protocol, AudioWorklet pipeline, DSP effects rack, presets, model manager, offline converter, latency telemetry UI patterns

## w-okada / voice-changer (patterns)

- Repo: https://github.com/w-okada/voice-changer
- Used conceptually: model slots, SOLA/crossfade & buffer knobs, remote client/server split, RVC tutorial flows, multi-engine mindset
- Not a wholesale code copy (different license / large surface)

## Vonovox (patterns)

- Repo: https://github.com/dr87/Vonovox
- Used conceptually: VAD/talk-detect + noise gate assist, VAC routing guidance, 48 kHz / flexible sample-rate discipline, CUDA-first quality bar
- Core inference is Cython/NVIDIA-only — not redistributed here

## echidna (patterns)

- Repo: https://github.com/supermarsx/echidna
- Used conceptually: latency modes (ultra/balanced/quality), settings profiles, DSP telemetry framing
- Android Zygisk/LSPosed system hooks are out of scope for this desktop/web product

## Original to this repository

- The in-browser voice engine (`frontend/public/voiceEngineCore.js`): pitch tracker, pitch-synchronous pitch and formant shifter, and the JavaScript effects rack
- BadloVoice UI identity and the voice library
