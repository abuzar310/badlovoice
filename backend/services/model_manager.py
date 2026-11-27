import logging
import os
import re
import threading
import uuid
from pathlib import Path
from typing import BinaryIO

import numpy as np

from backend.services.onnx_processor import OnnxProcessor
from backend.services.rvc_processor import RvcProcessor

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".onnx", ".pth", ".pt"}
# Companion files accepted on upload but not registered as models.
COMPANION_EXTENSIONS = {".index"}
MODEL_TYPE_MAP = {
    ".onnx": "onnx",
    ".pth": "rvc",
    ".pt": "rvc",
}
MAX_MODEL_SIZE = 4 * 1024 * 1024 * 1024  # 4 GB
MAX_FILENAME_BYTES = 200  # well inside every filesystem's 255-byte limit
# Uploads are written under this prefix and renamed into place once complete.
UPLOAD_TMP_PREFIX = ".upload-"


class NoActiveModelError(RuntimeError):
    """process_audio was called while no model is loaded (not an inference failure)."""


def _sanitize_filename(name: str) -> str:
    """Sanitize a filename: keep alphanumeric, hyphens, underscores, and dots."""
    name = os.path.basename(name)
    name = re.sub(r"[^\w.\-]", "_", name)
    # Collapse multiple underscores
    name = re.sub(r"_+", "_", name).strip("_")
    if not name:
        raise ValueError("Filename is empty after sanitization")
    if len(name.encode("utf-8")) > MAX_FILENAME_BYTES:
        raise ValueError("Filename is too long")
    return name


class ModelManager:
    """Manages voice conversion models: loading, unloading, and inference routing.

    Two locks, so that a slow model load never stalls anything else:

    * ``_lock`` guards the registry and the active-model pointers. It is held
      only for dictionary work — never across a load, an unload or disk I/O —
      so audio threads and the event loop can take it at any time.
    * ``_switch_lock`` serialises the slow operations (activate, deactivate,
      delete, finishing an upload) so that two of them cannot interleave.
      Always taken before ``_lock``, never the other way round.
    """

    def __init__(self, models_dir: str) -> None:
        self._models_dir = Path(models_dir)
        self._models_dir.mkdir(parents=True, exist_ok=True)

        self._lock = threading.Lock()
        self._switch_lock = threading.Lock()
        self._active_model_name: str | None = None
        self._active_processor: OnnxProcessor | RvcProcessor | None = None

        # Scan existing models
        self._known_models: dict[str, dict] = {}
        self._scan_models()

    def _scan_models(self) -> None:
        """Scan the models directory and register all valid model files."""
        for path in self._models_dir.iterdir():
            if path.name.startswith(UPLOAD_TMP_PREFIX):
                # An upload that was cut short by a crash; never a model.
                path.unlink(missing_ok=True)
            elif path.is_file() and path.suffix.lower() in ALLOWED_EXTENSIONS:
                self._register_model(path)
        logger.info("Scanned %d model(s) in %s", len(self._known_models), self._models_dir)

    def _register_model(self, path: Path) -> dict:
        """Register a model file and return a copy of its metadata."""
        meta = {
            "name": path.name,
            "type": MODEL_TYPE_MAP.get(path.suffix.lower(), "unknown"),
            "size_bytes": path.stat().st_size,
            "path": str(path),
            "active": False,
            "has_index": self._find_index_file(path.name) is not None,
        }
        with self._lock:
            meta["details"] = self._known_models.get(path.name, {}).get("details")
            self._known_models[path.name] = meta
            return dict(meta)

    def list_models(self) -> list[dict]:
        """Return metadata for all known models."""
        with self._lock:
            active = self._active_model_name
            models = [dict(meta) for meta in self._known_models.values()]
        for meta in models:
            meta["active"] = meta["name"] == active
            # Recomputed live so index files uploaded later are reflected.
            meta["has_index"] = self._find_index_file(meta["name"]) is not None
        return models

    def upload_model(self, name: str, source: BinaryIO) -> dict:
        """Save an uploaded model file and register it.

        Blocking (it copies the whole file): call it from a worker thread.

        Args:
            name: Desired model filename.
            source: The uploaded file, positioned at its start.

        Returns:
            Model metadata dict.

        Raises:
            ValueError: If the name, extension or size is not acceptable.
        """
        safe_name = _sanitize_filename(name)
        ext = Path(safe_name).suffix.lower()

        if ext not in ALLOWED_EXTENSIONS | COMPANION_EXTENSIONS:
            allowed = ", ".join(sorted(ALLOWED_EXTENSIONS | COMPANION_EXTENSIONS))
            raise ValueError(f"Unsupported file type '{ext}'. Allowed: {allowed}")

        # Stored with a lower-case extension ("Voice.PTH" -> "Voice.pth").
        dest = self._models_dir / (Path(safe_name).stem + ext)

        # Copy under a temporary name and rename into place, so an oversized
        # or failed upload never truncates or deletes a model already there.
        tmp = self._models_dir / f"{UPLOAD_TMP_PREFIX}{uuid.uuid4().hex}.part"
        try:
            size = 0
            with open(tmp, "wb") as out:
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_MODEL_SIZE:
                        raise ValueError(
                            f"File exceeds maximum size ({MAX_MODEL_SIZE // (1024**3)} GB)"
                        )
                    out.write(chunk)
            with self._switch_lock:  # not in the middle of a delete or a load
                os.replace(tmp, dest)
                meta = None if ext in COMPANION_EXTENSIONS else self._register_model(dest)
        finally:
            tmp.unlink(missing_ok=True)

        if meta is None:
            logger.info("Uploaded companion file: %s (%d bytes)", dest.name, size)
            return {
                "name": dest.name,
                "type": "index",
                "size_bytes": size,
                "path": str(dest),
                "active": False,
            }

        logger.info("Uploaded model: %s (%d bytes)", dest.name, size)
        return meta

    def delete_model(self, name: str) -> None:
        """Delete a model file (and its index) and unload it if active.

        Raises:
            FileNotFoundError: If the model is not known.
        """
        with self._switch_lock:
            with self._lock:
                meta = self._known_models.get(name)
                if meta is None:
                    raise FileNotFoundError(f"Model not found: {name}")
                processor = (
                    self._detach_active_locked() if self._active_model_name == name else None
                )
            if processor is not None:
                processor.unload()

            Path(meta["path"]).unlink(missing_ok=True)

            stem = Path(name).stem
            with self._lock:
                del self._known_models[name]
                index_still_used = any(
                    other["type"] == "rvc" and Path(other["name"]).stem == stem
                    for other in self._known_models.values()
                )
            # The index belongs to its model: left behind, it would silently
            # attach to whatever is uploaded under the same name next.
            index_path = self._find_index_file(name)
            if meta["type"] == "rvc" and index_path and not index_still_used:
                Path(index_path).unlink(missing_ok=True)
        logger.info("Deleted model: %s", name)

    def activate_model(self, name: str) -> dict:
        """Activate a model for inference.

        Blocking (loading takes seconds): call it from a worker thread.

        Args:
            name: The registered model name.

        Returns:
            Status dict with model info.

        Raises:
            FileNotFoundError: If the model is not known.
            RuntimeError: If the model fails to load.
        """
        with self._switch_lock:
            with self._lock:
                meta = self._known_models.get(name)
                if meta is None:
                    raise FileNotFoundError(f"Model not found: {name}")
                model_path, model_type = meta["path"], meta["type"]
                previous = self._detach_active_locked()
            # Unload the old model first so the new one has the memory to load into.
            if previous is not None:
                previous.unload()

            try:
                if model_type == "onnx":
                    processor = OnnxProcessor(model_path)
                elif model_type == "rvc":
                    # Look for a matching .index file
                    processor = RvcProcessor(model_path, self._find_index_file(name))
                else:
                    raise ValueError(f"Unknown model type: {model_type}")
            except Exception as exc:
                logger.error("Failed to load model %s: %s", name, exc)
                raise RuntimeError(f"Failed to load model: {exc}") from exc

            details = None
            try:
                details = processor.describe()
            except Exception:
                logger.exception("Failed to collect model details for %s", name)

            if isinstance(processor, RvcProcessor):
                try:
                    processor.warm_up()
                except Exception as exc:
                    logger.warning("RVC warm-up failed for %s: %s", name, exc)

            with self._lock:
                if details is not None:
                    meta["details"] = details
                details = meta.get("details")
                self._active_model_name = name
                self._active_processor = processor

        logger.info("Activated model: %s (type: %s)", name, model_type)
        return {
            "name": name,
            "type": model_type,
            "status": "active",
            "details": details,
        }

    def _find_index_file(self, model_name: str) -> str | None:
        """Look for a .index file matching the model name."""
        stem = Path(model_name).stem
        for ext in (".index",):
            candidate = self._models_dir / f"{stem}{ext}"
            if candidate.exists():
                return str(candidate)
        return None

    def deactivate_model(self) -> None:
        """Deactivate and unload the current model."""
        with self._switch_lock:
            with self._lock:
                processor = self._detach_active_locked()
            if processor is not None:
                processor.unload()

    def _detach_active_locked(self) -> OnnxProcessor | RvcProcessor | None:
        """Clear the active-model pointers and return the processor to unload.

        Must be called while holding self._lock. The caller unloads the
        processor after releasing it: unloading waits for running inference.
        """
        processor = self._active_processor
        if processor is not None:
            logger.info("Deactivating model: %s", self._active_model_name)
        self._active_processor = None
        self._active_model_name = None
        return processor

    def get_active_model(self) -> dict | None:
        """Return info about the currently active model, or None."""
        with self._lock:
            meta = self._known_models.get(self._active_model_name)
            return {**meta, "active": True} if meta else None

    def process_audio(self, audio: np.ndarray, settings: dict) -> np.ndarray:
        """Route audio through the active processor.

        Args:
            audio: Float32 PCM samples.
            settings: Dict with processing parameters (pitch_shift, f0_method, etc.).

        Returns:
            Processed audio samples.

        Raises:
            NoActiveModelError: If no model is active.
        """
        with self._lock:
            processor = self._active_processor
        if processor is None:
            raise NoActiveModelError("No model is currently active")

        pitch_shift = settings.get("pitch_shift", 0.0)

        if isinstance(processor, RvcProcessor):
            f0_method = settings.get("f0_method", "pm")
            sample_rate = int(settings.get("sample_rate", 40000))
            stream_id = settings.get("stream_id")
            return processor.process(
                audio,
                pitch_shift=pitch_shift,
                f0_method=f0_method,
                sample_rate=sample_rate,
                stream_id=stream_id,
                index_rate=settings.get("index_rate"),
                filter_radius=settings.get("filter_radius"),
                rms_mix_rate=settings.get("rms_mix_rate"),
                protect=settings.get("protect"),
            )
        else:
            return processor.process(audio, pitch_shift=pitch_shift)

    def release_stream(self, stream_id: str | int | None) -> None:
        """Release any per-stream state held by the active processor."""
        if stream_id is None:
            return
        with self._lock:
            processor = self._active_processor
        if isinstance(processor, RvcProcessor):
            processor.release_stream(stream_id)
