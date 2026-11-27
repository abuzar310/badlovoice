"""Realtime audio WebSocket: DSP round trip, protocol robustness, model fallback."""

import json
import logging
import queue
import struct
import threading
from contextlib import contextmanager

import numpy as np
import pytest

from backend.routers import websocket as ws_module

from .conftest import SR, rms
from .test_dsp_effects import voice

CHUNK = 4096
HEADER = struct.Struct("<II")  # sequence number, reserved / server time


def frame(seq: int, samples) -> bytes:
    return HEADER.pack(seq, 0) + np.asarray(samples, dtype="<f4").tobytes()


def receive(ws, timeout: float = 5.0) -> dict:
    """ws.receive() that fails the test instead of hanging on a silent server."""
    result: queue.Queue = queue.Queue()
    threading.Thread(target=lambda: result.put(ws.receive()), daemon=True).start()
    try:
        return result.get(timeout=timeout)
    except queue.Empty:
        pytest.fail("the server sent nothing")


def next_audio(ws, statuses: list | None = None):
    """Wait for the next binary response; JSON status messages are collected."""
    while True:
        message = receive(ws)
        assert message["type"] == "websocket.send", f"server closed the stream: {message}"
        if message.get("bytes") is not None:
            data = message["bytes"]
            seq, server_time = HEADER.unpack(data[:8])
            return seq, server_time, np.frombuffer(data[8:], dtype="<f4")
        if statuses is not None:
            statuses.append(json.loads(message["text"]))


def exchange(ws, seq: int, samples) -> np.ndarray:
    ws.send_bytes(frame(seq, samples))
    got_seq, _, audio = next_audio(ws)
    assert got_seq == seq
    return audio


@contextmanager
def stream(client, sample_rate: int = SR, chunk_size: int = CHUNK, **settings):
    with client.websocket_connect("/ws/audio") as ws:
        ws.send_text(json.dumps({"sample_rate": sample_rate, "chunk_size": chunk_size}))
        if settings:
            ws.send_text(json.dumps({"type": "settings", **settings}))
        yield ws


def close_code_after(client, first_message) -> int:
    """Send one message on a fresh socket and return the code the server closes with."""
    with client.websocket_connect("/ws/audio") as ws:
        if isinstance(first_message, bytes):
            ws.send_bytes(first_message)
        else:
            ws.send_text(first_message)
        message = receive(ws)
        assert message["type"] == "websocket.close", message
        return message["code"]


class FakeModelManager:
    """Stands in for the model runtime, which the light install does not have."""

    def __init__(self, convert):
        self.convert = convert
        self.calls: list[dict] = []
        self.released: list = []

    def process_audio(self, audio, settings):
        self.calls.append(settings)
        return self.convert(audio)

    def get_active_model(self):
        return {"name": "voice.pth", "type": "rvc", "active": True}

    def release_stream(self, stream_id):
        self.released.append(stream_id)


# --- DSP mode round trip ------------------------------------------------------


def test_dsp_round_trip_at_48k(client, monkeypatch):
    monkeypatch.setattr(ws_module, "STATUS_INTERVAL", 0.0)  # a status after every frame
    effects = {
        "robot": {"enabled": True, "freq": 90, "mix": 0.75},
        # Browser-only effects the backend does not implement.
        "monotone": {"enabled": True, "freq": 110},
        "vibrato": {"enabled": True, "rate": 5.5, "depth": 0.6},
    }
    x = voice(5 * CHUNK)
    statuses: list = []

    with stream(client, sample_rate=48000, pitch_shift=0, effects=effects) as ws:
        out = []
        for seq in range(5):
            chunk = x[seq * CHUNK : (seq + 1) * CHUNK]
            ws.send_bytes(frame(seq, chunk))
            got_seq, server_time, audio = next_audio(ws, statuses)
            assert got_seq == seq
            assert server_time > 0  # hundredths of a millisecond spent on the server
            assert audio.shape == chunk.shape
            out.append(audio)
        ws.send_bytes(frame(99, x[:CHUNK]))
        next_audio(ws, statuses)  # flushes the last status message

    y = np.concatenate(out)
    assert np.all(np.isfinite(y))
    assert not np.allclose(y, x, atol=1e-3), "the robot effect was not applied"

    status = statuses[-1]
    assert status["type"] == "status"
    assert status["mode"] == "dsp"
    assert status["active_model"] is None
    assert status["effects_active"] == 1  # robot only; unknown keys are not counted


def test_stream_without_effects_returns_the_input(client):
    x = voice(CHUNK)

    with stream(client) as ws:
        y = exchange(ws, 7, x)

    np.testing.assert_array_equal(y, x)


def test_dsp_pitch_shift_is_applied_when_no_model_is_active(client):
    x = voice(4 * CHUNK)

    with stream(client, pitch_shift=7) as ws:
        y = np.concatenate([exchange(ws, i, x[i * CHUNK : (i + 1) * CHUNK]) for i in range(4)])

    assert np.all(np.isfinite(y))
    assert not np.allclose(y, x, atol=1e-3)


def test_sample_rate_change_mid_stream_keeps_streaming(client):
    x = voice(2 * CHUNK)
    effects = {"echo": {"enabled": True, "time": 0.05, "feedback": 0.3, "mix": 0.5}}

    with stream(client, sample_rate=40000, effects=effects) as ws:
        first = exchange(ws, 0, x[:CHUNK])
        ws.send_text(json.dumps({"type": "settings", "sample_rate": 48000, "chunk_size": 2048}))
        second = exchange(ws, 1, x[CHUNK : CHUNK + 2048])

    assert first.shape == (CHUNK,)
    assert second.shape == (2048,)
    assert np.all(np.isfinite(second))


def test_clean_disconnect_logs_no_errors(client, caplog):
    with caplog.at_level(logging.WARNING, logger="backend"):
        with stream(client) as ws:
            exchange(ws, 0, voice(CHUNK))

    problems = [r for r in caplog.records if r.name.startswith("backend") and r.levelno >= logging.WARNING]
    assert not problems


# --- malformed input ----------------------------------------------------------


def test_malformed_binary_frames_are_dropped_and_the_stream_continues(client):
    x = voice(CHUNK)

    with stream(client) as ws:
        ws.send_bytes(b"\x01\x02\x03")  # shorter than the header
        ws.send_bytes(frame(1, x)[:-3])  # payload is not whole float32 samples
        ws.send_text("{not json")
        ws.send_text("[1, 2, 3]")
        ws.send_text("5")
        y = exchange(ws, 2, x)

    np.testing.assert_array_equal(y, x)


def test_frame_larger_than_the_biggest_chunk_is_dropped(client):
    # One giant frame would otherwise hold the model for seconds and stall
    # every other stream behind it.
    model = FakeModelManager(lambda audio: audio)
    client.app.state.model_manager = model
    oversized = np.zeros(ws_module.MAX_CHUNK_SIZE + 1, dtype=np.float32)

    with stream(client) as ws:
        ws.send_bytes(frame(1, oversized))
        y = exchange(ws, 2, voice(CHUNK))  # the next reply belongs to the valid frame

    assert y.shape == (CHUNK,)
    assert len(model.calls) == 1


def test_frame_of_exactly_the_biggest_chunk_is_processed(client):
    biggest = voice(ws_module.MAX_CHUNK_SIZE)

    with stream(client) as ws:
        y = exchange(ws, 1, biggest)

    np.testing.assert_array_equal(y, biggest)


def test_header_only_frame_gets_an_empty_reply(client):
    with stream(client) as ws:
        assert len(exchange(ws, 3, [])) == 0


def test_non_finite_samples_do_not_break_the_stream(client):
    effects = {"eq": {"enabled": True, "low": 6, "high": 3}}
    bad = voice(CHUNK).copy()
    bad[10], bad[20] = np.nan, np.inf

    with stream(client, effects=effects) as ws:
        first = exchange(ws, 0, bad)
        second = exchange(ws, 1, voice(CHUNK))

    assert np.all(np.isfinite(first))
    assert np.all(np.isfinite(second))


@pytest.mark.parametrize(
    "first_message",
    [
        "[]",
        "5",
        '"sample_rate"',
        "{not json",
        '{"sample_rate": "abc"}',
        '{"sample_rate": null}',
        '{"chunk_size": 1e999}',
        '{"sample_rate": 100}',
        '{"chunk_size": 1}',
        frame(0, [0.0, 0.0]),  # audio before any config
    ],
    ids=repr,
)
def test_bad_first_message_closes_with_unsupported_data(client, first_message):
    assert close_code_after(client, first_message) == 1003


@pytest.mark.parametrize("bad_rate", [0, -1, 7999, 192001, 10**12, "abc", None, [48000], 1e999])
def test_out_of_range_sample_rate_update_is_ignored(bad_rate):
    # Checked on the handler itself: letting a 10**12 Hz rate reach the DSP
    # chain would try to allocate a delay line of hundreds of gigabytes.
    conn_state = {"sample_rate": 48000, "chunk_size": 4096}
    update = json.dumps({"type": "settings", "sample_rate": bad_rate}).replace("Infinity", "1e999")

    ws_module._handle_json_message(update, conn_state)

    assert conn_state["sample_rate"] == 48000


@pytest.mark.parametrize("bad_size", [0, -4096, 127, 65537, "big", None, 1e999])
def test_out_of_range_chunk_size_update_is_ignored(bad_size):
    conn_state = {"sample_rate": 48000, "chunk_size": 4096}
    update = json.dumps({"type": "settings", "chunk_size": bad_size}).replace("Infinity", "1e999")

    ws_module._handle_json_message(update, conn_state)

    assert conn_state["chunk_size"] == 4096


def test_zero_sample_rate_update_does_not_kill_the_stream(client):
    x = voice(CHUNK)
    effects = {"telephone": {"enabled": True}}

    with stream(client, effects=effects) as ws:
        ws.send_text(json.dumps({"type": "settings", "sample_rate": 0}))
        y = exchange(ws, 0, x)

    assert y.shape == x.shape
    assert np.all(np.isfinite(y))


@pytest.mark.parametrize(
    "setting",
    ["pitch_shift", "formant_shift", "index_rate", "rms_mix_rate", "protect", "vad_threshold_db"],
)
@pytest.mark.parametrize("junk", ["NaN", "Infinity", "-Infinity", '"nan"', '"inf"'])
def test_non_finite_setting_keeps_the_previous_value(setting, junk):
    conn_state = {setting: 0.25, "effects": {}}

    ws_module._apply_settings(json.loads(f'{{"{setting}": {junk}}}'), conn_state)

    assert conn_state[setting] == 0.25


@pytest.mark.parametrize("setting", ["filter_radius", "crossfade_ms", "extra_buffer_chunks"])
def test_overflowing_integer_setting_does_not_kill_the_stream(client, setting):
    x = voice(CHUNK)

    with stream(client) as ws:
        ws.send_text(f'{{"type": "settings", "{setting}": 1e999}}')
        y = exchange(ws, 0, x)

    np.testing.assert_array_equal(y, x)


def test_pitch_setting_is_clamped_to_the_supported_range():
    conn_state = {"pitch_shift": 0.0, "formant_shift": 0.0, "effects": {}}

    ws_module._apply_settings({"pitch_shift": 1e9, "formant_shift": -1e9}, conn_state)

    assert conn_state["pitch_shift"] == 24.0
    assert conn_state["formant_shift"] == -24.0


# --- model path (runtime replaced by a stand-in) ------------------------------


def test_model_output_is_streamed_back_with_stream_settings(client):
    model = FakeModelManager(lambda audio: audio * 0.5)
    client.app.state.model_manager = model
    x = voice(CHUNK)

    with stream(client, sample_rate=44100, f0_method="rmvpe", index_rate=0.4) as ws:
        y = exchange(ws, 0, x)

    np.testing.assert_allclose(y, x * 0.5, atol=1e-6)
    sent = model.calls[0]
    assert sent["sample_rate"] == 44100  # the device rate, not the 40 kHz default
    assert sent["f0_method"] == "rmvpe"
    assert sent["index_rate"] == 0.4
    assert model.released == [sent["stream_id"]]  # per-stream state freed on disconnect


def test_status_reports_the_active_model(client, monkeypatch):
    monkeypatch.setattr(ws_module, "STATUS_INTERVAL", 0.0)
    client.app.state.model_manager = FakeModelManager(lambda audio: audio)
    statuses: list = []

    with stream(client) as ws:
        exchange(ws, 0, voice(CHUNK))
        ws.send_bytes(frame(1, voice(CHUNK)))
        next_audio(ws, statuses)

    assert statuses[-1]["mode"] == "rvc"
    assert statuses[-1]["active_model"] == "voice.pth"


def test_model_failure_falls_back_to_dsp_and_is_logged_once(client, caplog):
    def explode(audio):
        raise RuntimeError("RVC inference failed: CUDA out of memory")

    client.app.state.model_manager = FakeModelManager(explode)
    x = voice(CHUNK)

    with caplog.at_level(logging.ERROR, logger="backend.routers.websocket"):
        with stream(client) as ws:
            outputs = [exchange(ws, seq, x) for seq in range(5)]

    for y in outputs:
        np.testing.assert_array_equal(y, x)  # dry signal instead of silence
    failures = [r for r in caplog.records if "inference failed" in r.getMessage()]
    assert len(failures) == 1, "expected one log line, not one per audio chunk (or none)"
    assert "CUDA out of memory" in caplog.text


def test_model_returning_nan_does_not_poison_the_effect_rack(client):
    calls = {"n": 0}

    def flaky(audio):
        calls["n"] += 1
        return np.full_like(audio, np.nan) if calls["n"] == 1 else audio

    client.app.state.model_manager = FakeModelManager(flaky)
    effects = {"eq": {"enabled": True, "low": 6, "high": 3}}

    with stream(client, effects=effects) as ws:
        first = exchange(ws, 0, voice(CHUNK))
        second = exchange(ws, 1, voice(CHUNK))

    assert np.all(np.isfinite(first))
    assert np.all(np.isfinite(second))
    assert rms(second) > 0.01
