import asyncio
import json
import logging
import math
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.services.audio_processor import (
    MAX_SAMPLE_RATE,
    MIN_SAMPLE_RATE,
    audio_to_bytes,
    bytes_to_audio,
)
from backend.services.dsp_effects import MAX_SHIFT_SEMITONES, EffectsChain
from backend.services.model_manager import NoActiveModelError

logger = logging.getLogger(__name__)

router = APIRouter()

# How often to send latency status messages (seconds)
STATUS_INTERVAL = 1.0
# A model that fails does so on every chunk; log it this often, not per chunk.
MODEL_ERROR_LOG_INTERVAL = 5.0

MIN_CHUNK_SIZE = 128
MAX_CHUNK_SIZE = 65536
CONFIG_HINT = (
    f"Config needs sample_rate {MIN_SAMPLE_RATE}-{MAX_SAMPLE_RATE} "
    f"and chunk_size {MIN_CHUNK_SIZE}-{MAX_CHUNK_SIZE}"
)

# Everything int() / float() / .get() can raise on a hostile JSON value.
_BAD_VALUE = (TypeError, ValueError, AttributeError, OverflowError)


def _finite(value) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"not a finite number: {value!r}")
    return number


def _stream_format(data, conn_state: dict) -> tuple[int, int]:
    """Read (sample_rate, chunk_size) from a message, defaulting to the current ones.

    Raises one of ``_BAD_VALUE`` when a value is malformed or out of range.
    """
    sample_rate = int(data.get("sample_rate", conn_state["sample_rate"]))
    chunk_size = int(data.get("chunk_size", conn_state["chunk_size"]))
    if not MIN_SAMPLE_RATE <= sample_rate <= MAX_SAMPLE_RATE:
        raise ValueError(f"sample_rate out of range: {sample_rate}")
    if not MIN_CHUNK_SIZE <= chunk_size <= MAX_CHUNK_SIZE:
        raise ValueError(f"chunk_size out of range: {chunk_size}")
    return sample_rate, chunk_size


@router.websocket("/ws/audio")
async def audio_websocket(websocket: WebSocket) -> None:
    """Real-time audio processing WebSocket endpoint.

    Protocol:
        1. Client connects, server accepts.
        2. Client sends a JSON config message: {"sample_rate": int, "chunk_size": int, ...}.
        3. Client sends binary frames (audio) or JSON frames (settings updates).
        4. Server processes binary frames through the active model (or the DSP
           passthrough chain when no model is loaded) plus the effect rack, and
           sends back binary responses. The response header's second uint32
           carries the server processing time in hundredths of a millisecond.
        5. Server periodically sends JSON status messages with a timing breakdown.
    """
    await websocket.accept()
    client_id = id(websocket)
    logger.info("WebSocket connected: %s", client_id)

    model_manager = getattr(websocket.app.state, "model_manager", None)
    if model_manager is None:
        await websocket.close(code=1011, reason="Model manager not available")
        return

    # Connection-local state
    conn_state: dict = {
        "stream_id": str(client_id),
        "sample_rate": 40000,
        "chunk_size": 4096,
        "pitch_shift": 0.0,
        "formant_shift": 0.0,
        "f0_method": "pm",
        "index_rate": None,
        "filter_radius": None,
        "rms_mix_rate": None,
        "protect": None,
        "effects": {},
        "chain": None,
        "configured": False,
        "last_status_time": time.perf_counter(),
        "latency_ms": 0.0,
        "model_ms": 0.0,
        "dsp_ms": 0.0,
        "mode": "dsp",
        # Vonovox-inspired talk detect / noise gate assist
        "vad_enabled": False,
        "vad_threshold_db": -45.0,
        # w-okada / echidna latency + seam controls
        "latency_mode": "balanced",
        "crossfade_ms": 8,
        "extra_buffer_chunks": 1,
    }

    try:
        # Wait for initial JSON config message
        config = await _receive_config(websocket, conn_state)
        if config is None:
            return

        logger.info("WebSocket %s configured: sr=%d, chunk=%d",
                     client_id, conn_state["sample_rate"], conn_state["chunk_size"])

        # Main message loop
        while True:
            message = await websocket.receive()

            if "bytes" in message and message["bytes"]:
                await _handle_binary_frame(websocket, message["bytes"], model_manager, conn_state)

                # Send periodic status updates
                now = time.perf_counter()
                if now - conn_state["last_status_time"] >= STATUS_INTERVAL:
                    await _send_status(websocket, model_manager, conn_state)
                    conn_state["last_status_time"] = now

            elif "text" in message and message["text"]:
                _handle_json_message(message["text"], conn_state)

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: %s", client_id)
    except RuntimeError as exc:
        if "disconnect" in str(exc).lower():
            logger.info("WebSocket disconnected: %s", client_id)
        else:
            logger.error("WebSocket error (%s): %s", client_id, exc)
    except Exception as exc:
        logger.error("WebSocket error (%s): %s", client_id, exc, exc_info=True)
        try:
            await websocket.close(code=1011, reason="Internal server error")
        except Exception:
            pass
    finally:
        model_manager.release_stream(conn_state["stream_id"])


def _get_chain(conn_state: dict) -> EffectsChain:
    """Return the connection's DSP chain, (re)building it on sample-rate change."""
    chain = conn_state.get("chain")
    sample_rate = int(conn_state["sample_rate"])
    if chain is None or chain.sr != sample_rate:
        chain = EffectsChain(sample_rate)
        conn_state["chain"] = chain
    return chain


async def _receive_config(websocket: WebSocket, conn_state: dict) -> dict | None:
    """Wait for and parse the initial JSON configuration message."""
    try:
        message = await asyncio.wait_for(websocket.receive(), timeout=10.0)
    except asyncio.TimeoutError:
        logger.warning("WebSocket config timeout — closing")
        await websocket.close(code=1008, reason="Config timeout")
        return None
    if message["type"] == "websocket.disconnect":
        return None

    try:
        # A binary frame has no text, which fails here like any other non-JSON.
        config = json.loads(message.get("text") or "")
        sample_rate, chunk_size = _stream_format(config, conn_state)
    except _BAD_VALUE:
        await websocket.close(code=1003, reason=CONFIG_HINT)
        return None

    conn_state["sample_rate"] = sample_rate
    conn_state["chunk_size"] = chunk_size
    conn_state["configured"] = True

    # Apply any extra settings included in the config
    _apply_settings(config, conn_state)

    return config


def _apply_settings(data: dict, conn_state: dict) -> None:
    """Merge a settings payload (config or live update) into connection state."""
    try:
        # Floats go through _finite: json.loads accepts NaN / Infinity, and
        # these values are handed on to the model as they are.
        for key in ("pitch_shift", "formant_shift"):
            if key in data:
                shift = _finite(data[key])
                conn_state[key] = max(-MAX_SHIFT_SEMITONES, min(MAX_SHIFT_SEMITONES, shift))
        if "f0_method" in data:
            conn_state["f0_method"] = str(data["f0_method"])
        if "index_rate" in data and data["index_rate"] is not None:
            conn_state["index_rate"] = _finite(data["index_rate"])
        if "filter_radius" in data and data["filter_radius"] is not None:
            conn_state["filter_radius"] = int(data["filter_radius"])
        if "rms_mix_rate" in data and data["rms_mix_rate"] is not None:
            conn_state["rms_mix_rate"] = _finite(data["rms_mix_rate"])
        if "protect" in data and data["protect"] is not None:
            conn_state["protect"] = _finite(data["protect"])
        if "effects" in data and isinstance(data["effects"], dict):
            conn_state["effects"] = data["effects"]
        if "vad_enabled" in data:
            conn_state["vad_enabled"] = bool(data["vad_enabled"])
        if "vad_threshold_db" in data:
            conn_state["vad_threshold_db"] = _finite(data["vad_threshold_db"])
        if "latency_mode" in data:
            conn_state["latency_mode"] = str(data["latency_mode"])
        if "crossfade_ms" in data:
            conn_state["crossfade_ms"] = max(0, min(64, int(data["crossfade_ms"])))
        if "extra_buffer_chunks" in data:
            conn_state["extra_buffer_chunks"] = max(0, min(8, int(data["extra_buffer_chunks"])))

        # Auto-wire noise gate when VAD assist is on (Vonovox-style talk detect).
        if conn_state.get("vad_enabled"):
            effects = dict(conn_state.get("effects") or {})
            gate = dict(effects.get("gate") or {})
            gate["enabled"] = True
            gate["threshold"] = conn_state["vad_threshold_db"]
            effects["gate"] = gate
            conn_state["effects"] = effects
    except _BAD_VALUE as exc:
        logger.warning("Ignoring invalid settings values: %s", exc)


def _process_frame_sync(audio, model_manager, conn_state: dict) -> tuple:
    """Full processing path for one chunk. Runs inside a worker thread."""
    chain = conn_state["chain"]
    effects = conn_state["effects"]
    pitch_shift = conn_state["pitch_shift"]

    t0 = time.perf_counter()
    processed = chain.pre_process(audio, effects)

    model_ms = 0.0
    mode = "dsp"
    t_model = time.perf_counter()
    try:
        processed = model_manager.process_audio(
            processed,
            {
                "stream_id": conn_state["stream_id"],
                "pitch_shift": pitch_shift,
                "f0_method": conn_state["f0_method"],
                "sample_rate": conn_state["sample_rate"],
                "index_rate": conn_state["index_rate"],
                "filter_radius": conn_state["filter_radius"],
                "rms_mix_rate": conn_state["rms_mix_rate"],
                "protect": conn_state["protect"],
            },
        )
        model_ms = (time.perf_counter() - t_model) * 1000.0
        active = model_manager.get_active_model()
        mode = (active or {}).get("type", "model")
    except NoActiveModelError:
        # No active model — DSP passthrough handles pitch instead.
        processed = chain.apply_pitch(processed, pitch_shift)
    except Exception:
        # RVC/ONNX failure must not drop the stream to silence.
        now = time.monotonic()
        if now - conn_state.get("model_error_logged", -math.inf) >= MODEL_ERROR_LOG_INTERVAL:
            conn_state["model_error_logged"] = now
            logger.exception("Model inference failed — falling back to DSP pitch")
        processed = chain.apply_pitch(processed, pitch_shift)
        mode = "dsp"
        model_ms = (time.perf_counter() - t_model) * 1000.0

    processed = chain.post_process(processed, effects, conn_state["formant_shift"])

    total_ms = (time.perf_counter() - t0) * 1000.0
    return processed, mode, model_ms, max(total_ms - model_ms, 0.0)


async def _handle_binary_frame(
    websocket: WebSocket,
    data: bytes,
    model_manager,
    conn_state: dict,
) -> None:
    """Parse a binary audio frame, process it, and send back the result."""
    t_start = time.perf_counter()

    try:
        audio, seq_num, _reserved = bytes_to_audio(data)
        if len(audio) > MAX_CHUNK_SIZE:
            # One giant frame would hold the model for seconds and stall
            # every other stream queued behind it.
            raise ValueError(f"{len(audio)} samples exceeds the {MAX_CHUNK_SIZE} maximum")
    except ValueError as exc:
        logger.warning("Invalid audio frame: %s", exc)
        return

    _get_chain(conn_state)
    processed, mode, model_ms, dsp_ms = await asyncio.to_thread(
        _process_frame_sync, audio, model_manager, conn_state
    )

    elapsed_ms = (time.perf_counter() - t_start) * 1000.0
    conn_state["latency_ms"] = elapsed_ms
    conn_state["model_ms"] = model_ms
    conn_state["dsp_ms"] = dsp_ms
    conn_state["mode"] = mode

    # Reserved header field carries server time in hundredths of a millisecond.
    server_time = min(int(elapsed_ms * 100), 0xFFFFFFFF)
    response_bytes = audio_to_bytes(processed, seq_num, reserved=server_time)
    await websocket.send_bytes(response_bytes)


def _handle_json_message(text: str, conn_state: dict) -> None:
    """Handle a JSON settings update from the client."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("Invalid JSON message: %s", text[:200])
        return

    _apply_settings(data, conn_state)

    # The device rate can change mid-stream (the client learns it on Start),
    # but only within the same limits as the initial config.
    try:
        conn_state["sample_rate"], conn_state["chunk_size"] = _stream_format(data, conn_state)
    except _BAD_VALUE as exc:
        logger.warning("Ignoring invalid stream format update: %s", exc)


async def _send_status(websocket: WebSocket, model_manager, conn_state: dict) -> None:
    """Send a JSON status message with a processing-time breakdown."""
    active = model_manager.get_active_model()
    status = {
        "type": "status",
        "latency_ms": round(conn_state["latency_ms"], 2),
        "model_ms": round(conn_state["model_ms"], 2),
        "dsp_ms": round(conn_state["dsp_ms"], 2),
        "mode": conn_state["mode"] if active else "dsp",
        "active_model": active["name"] if active else None,
        "effects_active": EffectsChain.count_active(
            conn_state["effects"], conn_state["formant_shift"]
        ),
        "vad_enabled": bool(conn_state.get("vad_enabled")),
        "latency_mode": conn_state.get("latency_mode"),
        "crossfade_ms": conn_state.get("crossfade_ms"),
        "extra_buffer_chunks": conn_state.get("extra_buffer_chunks"),
    }
    try:
        await websocket.send_json(status)
    except Exception:
        pass
