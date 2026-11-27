"""DSP effect rack: every effect, chunk-by-chunk streaming, and hostile input."""

import logging
import time

import numpy as np
import pytest

from backend.services.dsp_effects import KNOWN_EFFECTS, POST_CHAIN_ORDER, EffectsChain

from .conftest import SR, rms, tone

CHUNK = 4096
N = 12 * CHUNK  # a multiple of every internal block size (64, 128, 256)

# Typical "on" settings for each effect, shaped like the frontend payload.
EFFECT_PARAMS = {
    "robot": {"freq": 90, "mix": 0.75},
    "whisper": {"mix": 1.0},
    "distortion": {"drive": 0.6},
    "bitcrush": {"bits": 6, "down": 4},
    "telephone": {},
    "chorus": {"rate": 0.8, "depth": 0.5, "mix": 0.5},
    "echo": {"time": 0.05, "feedback": 0.4, "mix": 0.5},
    "reverb": {"size": 0.5, "mix": 0.5},
    "eq": {"low": 6, "high": -6},
    "compressor": {"threshold": -30, "ratio": 6},
    "gain": {"db": 6},
    "gate": {"threshold": -45},
}
ALL_PARAM_NAMES = sorted({name for params in EFFECT_PARAMS.values() for name in params})


def on(key: str, **overrides) -> dict:
    return {key: {"enabled": True, **EFFECT_PARAMS[key], **overrides}}


def voice(n: int = N) -> np.ndarray:
    """Deterministic speech-like signal: harmonics with a syllable-rate swell."""
    t = np.arange(n) / SR
    harmonics = sum(
        np.sin(2 * np.pi * f * t) / k
        for k, f in enumerate([140, 280, 420, 560, 1200, 2400], start=1)
    )
    swell = 0.5 + 0.5 * np.sin(2 * np.pi * 3 * t)
    return (0.2 * harmonics * swell).astype(np.float32)


def run_chunked(process, x: np.ndarray, chunk: int = CHUNK) -> np.ndarray:
    return np.concatenate([process(x[i : i + chunk]) for i in range(0, len(x), chunk)])


def spectral_centroid(x: np.ndarray) -> float:
    power = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    return float(np.sum(np.fft.rfftfreq(len(x), 1 / SR) * power) / np.sum(power))


# --- every effect -----------------------------------------------------------


@pytest.mark.parametrize("key", POST_CHAIN_ORDER)
def test_effect_processes_audio(key):
    x = voice()
    y = EffectsChain(SR).post_process(x, on(key))

    assert y.dtype == np.float32
    assert y.shape == x.shape
    assert np.all(np.isfinite(y))
    assert np.max(np.abs(y)) <= 1.0
    assert not np.allclose(y, x, atol=1e-3), "effect left the signal untouched"


def test_gate_attenuates_signal_below_threshold():
    quiet = tone(amp=0.001)  # about -63 dBFS, under the -45 dB threshold
    y = EffectsChain(SR).pre_process(quiet, on("gate"))

    assert rms(y[SR // 2 :]) < 0.1 * rms(quiet[SR // 2 :])


def test_gate_passes_signal_above_threshold():
    loud = tone(amp=0.3)
    y = EffectsChain(SR).pre_process(loud, on("gate"))

    np.testing.assert_allclose(y, loud, atol=1e-6)


def test_pitch_shift_moves_the_spectrum_up_an_octave():
    # The dual-tap shifter splits a pure tone into sidebands around the target
    # (220 Hz -> 408 + 471 Hz), so this checks where the energy sits, not a peak.
    y = EffectsChain(SR).apply_pitch(tone(seconds=N / SR, freq=220), 12)

    assert spectral_centroid(y[N // 2 :]) == pytest.approx(440, rel=0.1)


def test_formant_shift_reshapes_the_spectrum_at_similar_level():
    x = voice()
    y = EffectsChain(SR).post_process(x, {}, formant_shift=4)

    assert np.all(np.isfinite(y))
    assert not np.allclose(y, x, atol=1e-3)
    assert 0.3 < rms(y) / rms(x) < 3.0


def test_output_gain_trim_is_respected():
    x = voice()
    y = EffectsChain(SR).post_process(x, on("gain", db=-12))

    assert rms(y) / rms(x) == pytest.approx(10 ** (-12 / 20), rel=0.02)


def test_count_active_counts_known_effects_and_formant():
    effects = {**on("robot"), **on("gate"), "echo": {"enabled": False}}

    assert EffectsChain.count_active(effects) == 2
    assert EffectsChain.count_active(effects, formant_shift=2.0) == 3


# --- streaming: chunk by chunk must equal one pass ---------------------------


@pytest.mark.parametrize("key", POST_CHAIN_ORDER)
def test_effect_streaming_matches_one_shot(key):
    x = voice()
    whole = EffectsChain(SR).post_process(x, on(key))

    chain = EffectsChain(SR)
    chunked = run_chunked(lambda c: chain.post_process(c, on(key)), x)

    np.testing.assert_allclose(chunked, whole, atol=1e-4)


def test_gate_streaming_matches_one_shot():
    x = voice() * 0.02  # hovers around the threshold so the gate opens and closes
    whole = EffectsChain(SR).pre_process(x, on("gate"))

    chain = EffectsChain(SR)
    chunked = run_chunked(lambda c: chain.pre_process(c, on("gate")), x)

    np.testing.assert_allclose(chunked, whole, atol=1e-6)


def test_pitch_streaming_matches_one_shot():
    x = voice()
    whole = EffectsChain(SR).apply_pitch(x, 5)

    chain = EffectsChain(SR)
    chunked = run_chunked(lambda c: chain.apply_pitch(c, 5), x)

    np.testing.assert_allclose(chunked, whole, atol=1e-4)


def test_formant_streaming_matches_one_shot():
    x = voice()
    whole = EffectsChain(SR).post_process(x, {}, formant_shift=-3)

    chain = EffectsChain(SR)
    chunked = run_chunked(lambda c: chain.post_process(c, {}, formant_shift=-3), x)

    np.testing.assert_allclose(chunked, whole, atol=1e-4)


def test_full_rack_streaming_matches_one_shot():
    effects = {}
    for key in KNOWN_EFFECTS:
        effects.update(on(key))
    x = voice()

    def render(chain, chunk):
        gated = chain.pre_process(chunk, effects)
        return chain.post_process(chain.apply_pitch(gated, 3), effects, formant_shift=2)

    whole = render(EffectsChain(SR), x)
    chain = EffectsChain(SR)
    chunked = run_chunked(lambda c: render(chain, c), x)

    assert np.all(np.isfinite(whole))
    np.testing.assert_allclose(chunked, whole, atol=1e-3)


def test_reenabled_effect_does_not_replay_old_audio():
    chain = EffectsChain(SR)
    echo_on = on("echo", time=0.5, feedback=0.8, mix=1.0)
    silence = np.zeros(CHUNK, dtype=np.float32)

    chain.post_process(tone(seconds=CHUNK / SR, amp=0.5), echo_on)  # fills the delay line
    for _ in range(3):
        chain.post_process(silence, {})  # effect switched off
    replay = np.concatenate([chain.post_process(silence, echo_on) for _ in range(8)])

    assert np.max(np.abs(replay)) < 1e-6


def test_reenabled_formant_shift_does_not_replay_old_audio():
    chain = EffectsChain(SR)
    silence = np.zeros(CHUNK, dtype=np.float32)

    chain.post_process(tone(seconds=CHUNK / SR, amp=0.5), {}, formant_shift=4)
    for _ in range(3):
        chain.post_process(silence, {}, formant_shift=0)  # shifter switched off
    replay = chain.post_process(silence, {}, formant_shift=4)  # and back on

    assert np.max(np.abs(replay)) < 1e-6


def test_eq_parameter_change_keeps_filter_memory():
    # The tone peaks exactly on the chunk boundary, where one slider moves a
    # single step. Wiping the filter memory there would drop the +12 dB bass
    # boost back to the dry level for an instant: a loud click.
    x = tone(seconds=2 * CHUNK / SR, freq=SR / CHUNK * 8.25, amp=0.2)
    chain = EffectsChain(SR)

    before = chain.post_process(x[:CHUNK], on("eq", low=12, high=0))
    after = chain.post_process(x[CHUNK:], on("eq", low=12, high=0.5))

    assert abs(after[0] - before[-1]) < 0.1 * abs(before[-1])


def test_long_input_formant_shift_scales_linearly():
    def seconds_to_shift(n):
        x = voice(n)
        best = float("inf")
        for _ in range(2):
            start = time.perf_counter()
            EffectsChain(SR).post_process(x, {}, formant_shift=3)
            best = min(best, time.perf_counter() - start)
        return best

    short = seconds_to_shift(15 * SR)
    long = seconds_to_shift(60 * SR)

    # Four times the audio should cost about four times as long, not sixteen.
    assert long / short < 6


# --- hostile input ------------------------------------------------------------


def test_unknown_effect_keys_are_ignored():
    x = voice()
    effects = {
        "monotone": {"enabled": True, "freq": 110},
        "vibrato": {"enabled": True, "rate": 5.5, "depth": 0.6},
        "does-not-exist": {"enabled": True},
        "eq": "not a dict",
        "echo": None,
    }
    chain = EffectsChain(SR)

    y = chain.post_process(chain.pre_process(x, effects), effects)

    np.testing.assert_array_equal(y, x)
    assert EffectsChain.count_active(effects) == 0


@pytest.mark.parametrize("effects", [None, "robot", 5, [], [{"robot": {"enabled": True}}]], ids=repr)
def test_non_dict_effects_payload_is_passthrough(effects):
    x = voice(CHUNK)
    chain = EffectsChain(SR)

    y = chain.post_process(chain.pre_process(x, effects), effects)

    np.testing.assert_array_equal(y, x)
    assert EffectsChain.count_active(effects) == 0


GARBAGE = [None, "abc", "", [], {}, True, -1e30, 1e30, float("nan"), float("inf"), float("-inf")]


@pytest.mark.parametrize("junk", GARBAGE, ids=repr)
@pytest.mark.parametrize("key", KNOWN_EFFECTS)
def test_garbage_parameter_values_are_tolerated(key, junk, caplog):
    junk_effects = {key: {"enabled": True, **{name: junk for name in ALL_PARAM_NAMES}}}
    sane_effects = on(key)
    chain = EffectsChain(SR)
    x = voice(2 * CHUNK)

    with caplog.at_level(logging.ERROR, logger="backend.services.dsp_effects"):
        for effects in (junk_effects, sane_effects):  # sane second: state must survive
            for start in (0, CHUNK):
                chunk = x[start : start + CHUNK]
                y = chain.post_process(chain.pre_process(chunk, effects), effects)
                assert y.shape == chunk.shape
                assert np.all(np.isfinite(y))

    assert not caplog.records, "the effect raised instead of falling back to a safe value"


GARBAGE_SHIFTS = [float("nan"), float("inf"), float("-inf"), 1e9, -1e9, None, "abc"]


@pytest.mark.parametrize("junk", GARBAGE_SHIFTS, ids=repr)
def test_garbage_pitch_shift_is_tolerated(junk, caplog):
    chain = EffectsChain(SR)
    x = voice(CHUNK)

    with caplog.at_level(logging.ERROR, logger="backend.services.dsp_effects"):
        assert np.all(np.isfinite(chain.apply_pitch(x, junk)))
        assert np.all(np.isfinite(chain.apply_pitch(x, 3)))  # shifter not poisoned

    assert not caplog.records


@pytest.mark.parametrize("junk", GARBAGE_SHIFTS, ids=repr)
def test_garbage_formant_shift_is_tolerated(junk, caplog):
    chain = EffectsChain(SR)
    x = voice(CHUNK)

    with caplog.at_level(logging.ERROR, logger="backend.services.dsp_effects"):
        assert np.all(np.isfinite(chain.post_process(x, {}, formant_shift=junk)))
        assert np.all(np.isfinite(chain.post_process(x, {}, formant_shift=3)))

    assert not caplog.records


def test_non_finite_samples_do_not_poison_effect_state():
    effects = {**on("gate"), **on("eq"), **on("echo"), **on("reverb"), **on("compressor")}
    chain = EffectsChain(SR)

    def render(chunk):
        gated = chain.pre_process(chunk, effects)
        return chain.post_process(chain.apply_pitch(gated, 2), effects, formant_shift=2)

    bad = voice(CHUNK).copy()
    bad[100], bad[200], bad[300] = np.nan, np.inf, -np.inf

    assert np.all(np.isfinite(render(bad)))
    assert np.all(np.isfinite(render(voice(CHUNK))))  # the chunk after the bad one


def test_empty_chunk_is_returned_as_is():
    chain = EffectsChain(SR)
    empty = np.zeros(0, dtype=np.float32)
    effects = {**on("gate"), **on("echo")}

    assert len(chain.pre_process(empty, effects)) == 0
    assert len(chain.apply_pitch(empty, 4)) == 0
    assert len(chain.post_process(empty, effects, formant_shift=2)) == 0
