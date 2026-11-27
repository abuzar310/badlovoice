"""Shared fixtures.

The suite runs on the light install (backend/requirements-dev.txt): no torch,
onnxruntime or RVC runtime is needed, and nothing is written into the repo.
"""

import io
import threading
import time

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

SR = 48000


def audio_bytes(audio: np.ndarray, sr: int = SR, fmt: str = "WAV", subtype: str = "PCM_16") -> bytes:
    """Encode samples as an audio file in memory."""
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format=fmt, subtype=subtype)
    return buf.getvalue()


class FakeProcessor:
    """Stands in for OnnxProcessor: onnxruntime is not part of the light install.

    Tracks which instances are loaded so tests can check nothing is leaked.
    """

    load_seconds = 0.0
    alive: list = []
    loading: threading.Event

    def __init__(self, model_path: str) -> None:
        type(self).loading.set()
        time.sleep(type(self).load_seconds)
        self.model_path = model_path
        type(self).alive.append(self)

    def process(self, audio: np.ndarray, pitch_shift: float = 0.0) -> np.ndarray:
        return audio * 0.5

    def describe(self) -> dict:
        return {"engine": "fake"}

    def unload(self) -> None:
        type(self).alive.remove(self)


@pytest.fixture
def fake_onnx(monkeypatch):
    """Make `.onnx` models loadable by swapping in FakeProcessor."""
    from backend.services import model_manager

    class Fake(FakeProcessor):
        load_seconds = 0.0
        alive: list = []
        loading = threading.Event()

    monkeypatch.setattr(model_manager, "OnnxProcessor", Fake)
    return Fake


def tone(seconds: float = 1.0, freq: float = 220.0, sr: int = SR, amp: float = 0.3) -> np.ndarray:
    """A plain sine wave as float32 PCM."""
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)))


@pytest.fixture
def app_paths(tmp_path, monkeypatch):
    """Point every on-disk location the app uses at a per-test directory."""
    from backend.config import settings

    monkeypatch.setattr(settings, "MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setattr(settings, "PRESETS_PATH", str(tmp_path / "data" / "presets.json"))
    monkeypatch.setattr(settings, "SLOTS_PATH", str(tmp_path / "data" / "slots.json"))
    monkeypatch.setattr(settings, "PROFILES_PATH", str(tmp_path / "data" / "profiles.json"))
    return tmp_path


@pytest.fixture
def client(app_paths):
    """A started app (lifespan run) talking to per-test storage."""
    from backend.main import app

    with TestClient(app) as test_client:
        yield test_client
