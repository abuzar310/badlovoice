"""Offline file conversion: run an uploaded audio file through the active
model and/or the DSP effect chain and return a rendered WAV."""

import asyncio
import io
import json
import logging
import re
import tempfile
import uuid
from pathlib import Path
from urllib.parse import quote

import numpy as np
from fastapi import APIRouter, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response

from backend.config import settings
from backend.services.audio_processor import MAX_SAMPLE_RATE, MIN_SAMPLE_RATE
from backend.services.dsp_effects import EffectsChain

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/convert", tags=["convert"])

MAX_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB


def _check_format(sample_rate: int, frames: int) -> None:
    """Refuse audio the chain should not be asked to render."""
    if not MIN_SAMPLE_RATE <= sample_rate <= MAX_SAMPLE_RATE:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported sample rate {sample_rate} Hz "
            f"(allowed: {MIN_SAMPLE_RATE}-{MAX_SAMPLE_RATE} Hz)",
        )
    if frames > settings.MAX_CONVERT_SECONDS * sample_rate:
        raise HTTPException(
            status_code=413,
            detail=f"Audio too long (max {settings.MAX_CONVERT_SECONDS // 60} minutes)",
        )


def _load_audio(data: bytes, filename: str) -> tuple[np.ndarray, int]:
    """Decode an uploaded audio file to mono float32 at its native rate."""
    import soundfile as sf

    try:
        with sf.SoundFile(io.BytesIO(data)) as source:
            sample_rate = int(source.samplerate)
            # Checked on the header, before decoding: a few hundred kB of
            # compressed silence expands to gigabytes of samples.
            _check_format(sample_rate, source.frames)
            audio = source.read(dtype="float32", always_2d=True)
        return audio.mean(axis=1).astype(np.float32), sample_rate
    except HTTPException:
        raise
    except Exception:
        pass  # not something libsndfile reads — try librosa below

    # librosa reaches further codecs (m4a, ...) through audioread, which needs
    # a real file on disk rather than an in-memory buffer.
    suffix = Path(filename).suffix
    try:
        import librosa

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ("upload" + (suffix if re.fullmatch(r"\.\w{1,8}", suffix) else ""))
            path.write_bytes(data)
            audio, sample_rate = librosa.load(
                path, sr=None, mono=True, duration=settings.MAX_CONVERT_SECONDS + 1
            )
    except Exception as exc:
        raise ValueError(f"Could not decode audio file '{filename}': {exc}") from exc
    _check_format(int(sample_rate), len(audio))
    return audio.astype(np.float32), int(sample_rate)


def _attachment(filename: str) -> str:
    """Content-Disposition for a download whose name may hold any characters.

    Header values are latin-1 and a quote would end the quoted name, so
    ``filename`` is an ASCII stand-in and ``filename*`` (RFC 5987) carries the
    real name.
    """
    fallback = re.sub(r"[^A-Za-z0-9._ -]", "_", filename)
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def _encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, np.clip(audio, -1.0, 1.0), sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _render(
    audio: np.ndarray,
    sample_rate: int,
    model_manager,
    use_model: bool,
    pitch_shift: float,
    formant_shift: float,
    f0_method: str,
    effects: dict,
) -> np.ndarray:
    chain = EffectsChain(sample_rate)
    processed = chain.pre_process(audio, effects)

    model_applied = False
    if use_model and model_manager.get_active_model() is not None:
        # One model stream per job: a shared id would let the tail of one
        # file become the model's context for the start of another.
        stream_id = f"convert-{uuid.uuid4().hex}"
        try:
            processed = model_manager.process_audio(
                processed,
                {
                    "stream_id": stream_id,
                    "pitch_shift": pitch_shift,
                    "f0_method": f0_method,
                    "sample_rate": sample_rate,
                },
            )
            model_applied = True
        finally:
            model_manager.release_stream(stream_id)

    if not model_applied and abs(pitch_shift) > 1e-3:
        processed = chain.apply_pitch(processed, pitch_shift)

    return chain.post_process(processed, effects, formant_shift)


@router.post("/")
async def convert_file(
    request: Request,
    file: UploadFile,
    pitch_shift: float = Form(0.0),
    formant_shift: float = Form(0.0),
    f0_method: str = Form("rmvpe"),
    effects: str = Form("{}"),
    use_model: bool = Form(True),
) -> Response:
    """Convert an uploaded audio file and return the rendered WAV."""
    model_manager = getattr(request.app.state, "model_manager", None)
    if model_manager is None:
        raise HTTPException(status_code=503, detail="Model manager not initialized")

    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 200 MB)")
    if not data:
        raise HTTPException(status_code=400, detail="File is empty")

    try:
        effects_dict = json.loads(effects) if effects else {}
        if not isinstance(effects_dict, dict):
            effects_dict = {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid effects JSON")

    try:
        audio, sample_rate = await asyncio.to_thread(_load_audio, data, file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if len(audio) == 0:
        raise HTTPException(status_code=400, detail="Audio file contains no samples")

    try:
        rendered = await asyncio.to_thread(
            _render,
            audio,
            sample_rate,
            model_manager,
            use_model,
            float(np.clip(pitch_shift, -24.0, 24.0)),
            float(np.clip(formant_shift, -24.0, 24.0)),
            str(f0_method),
            effects_dict,
        )
        wav_bytes = await asyncio.to_thread(_encode_wav, rendered, sample_rate)
    except Exception as exc:
        logger.exception("File conversion failed")
        raise HTTPException(status_code=500, detail=f"Conversion failed: {exc}")

    out_name = f"{Path(file.filename).stem}_converted.wav"
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": _attachment(out_name)},
    )
