"""ModelManager: locking, races between requests, and what ends up on disk."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.config import settings
from backend.services.model_manager import ModelManager, NoActiveModelError


def model_files(directory: Path, *names: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name in names:
        (directory / name).write_bytes(b"model-bytes")


def test_models_on_disk_are_found_whatever_the_extension_case(tmp_path):
    model_files(tmp_path, "soft.onnx", "Loud.ONNX", "Voice.PTH", "old.pt", "readme.txt", "voice.index")

    found = {m["name"]: m["type"] for m in ModelManager(str(tmp_path)).list_models()}

    assert found == {"soft.onnx": "onnx", "Loud.ONNX": "onnx", "Voice.PTH": "rvc", "old.pt": "rvc"}


def test_stale_partial_uploads_are_removed_at_startup(tmp_path):
    model_files(tmp_path, "voice.onnx", ".upload-abc123.part")

    ModelManager(str(tmp_path))

    assert sorted(p.name for p in tmp_path.iterdir()) == ["voice.onnx"]


def test_processing_without_a_model_raises_no_active_model(tmp_path):
    manager = ModelManager(str(tmp_path))

    with pytest.raises(NoActiveModelError):
        manager.process_audio(np.zeros(16, dtype=np.float32), {})


def test_failed_activation_leaves_no_model_active(tmp_path, fake_onnx, monkeypatch):
    model_files(tmp_path, "good.onnx", "broken.onnx")
    manager = ModelManager(str(tmp_path))
    manager.activate_model("good.onnx")

    def refuse(self, path):
        raise OSError("corrupt model file")

    monkeypatch.setattr(fake_onnx, "__init__", refuse)
    with pytest.raises(RuntimeError, match="corrupt model file"):
        manager.activate_model("broken.onnx")

    assert manager.get_active_model() is None
    assert fake_onnx.alive == []  # the previous model was unloaded, nothing leaked


def test_queries_do_not_wait_for_a_model_that_is_loading(tmp_path, fake_onnx):
    model_files(tmp_path, "slow.onnx")
    manager = ModelManager(str(tmp_path))
    fake_onnx.load_seconds = 1.0
    loading = threading.Thread(target=manager.activate_model, args=("slow.onnx",))
    loading.start()
    assert fake_onnx.loading.wait(timeout=5)

    started = time.perf_counter()
    assert manager.get_active_model() is None
    assert [m["active"] for m in manager.list_models()] == [False]
    with pytest.raises(NoActiveModelError):
        manager.process_audio(np.zeros(16, dtype=np.float32), {})
    manager.release_stream("some-stream")
    waited = time.perf_counter() - started
    loading.join()

    assert waited < 0.3, "a quick query was stuck behind the model load"
    assert manager.get_active_model()["name"] == "slow.onnx"


def test_concurrent_activations_leave_exactly_one_model_loaded(tmp_path, fake_onnx):
    names = [f"{letter}.onnx" for letter in "abcd"]
    model_files(tmp_path, *names)
    manager = ModelManager(str(tmp_path))
    fake_onnx.load_seconds = 0.02

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(manager.activate_model, names * 4))

    active = manager.get_active_model()
    assert [Path(p.model_path).name for p in fake_onnx.alive] == [active["name"]]


def test_deactivate_racing_with_activate_never_leaks_a_loaded_model(tmp_path, fake_onnx):
    model_files(tmp_path, "a.onnx")
    manager = ModelManager(str(tmp_path))
    fake_onnx.load_seconds = 0.01

    def flip(i):
        if i % 2:
            manager.deactivate_model()
        else:
            manager.activate_model("a.onnx")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(flip, range(40)))
    manager.deactivate_model()

    assert manager.get_active_model() is None
    assert fake_onnx.alive == []


def test_registry_matches_disk_after_racing_upload_and_delete_of_one_name(tmp_path):
    import io

    manager = ModelManager(str(tmp_path))
    stop = threading.Event()
    upload_errors: list = []

    def uploader():
        while not stop.is_set():
            try:
                manager.upload_model("voice.onnx", io.BytesIO(b"model-bytes"))
            except Exception as exc:  # a finished upload must never fail half-way
                upload_errors.append(exc)

    def deleter():
        while not stop.is_set():
            try:
                manager.delete_model("voice.onnx")
            except FileNotFoundError:
                pass  # nothing uploaded at this instant

    threads = [threading.Thread(target=uploader), threading.Thread(target=deleter)]
    for thread in threads:
        thread.start()
    time.sleep(1.0)
    stop.set()
    for thread in threads:
        thread.join()

    assert not upload_errors, upload_errors[:3]
    # A model file the registry does not know about would be invisible in the
    # UI (and undeletable) until the next restart.
    on_disk = sorted(p.name for p in tmp_path.iterdir())
    assert sorted(m["name"] for m in manager.list_models()) == on_disk


def test_listing_models_while_others_upload_and_delete(app_paths, fake_onnx):
    # Handlers run on worker threads, so the registry is read and changed
    # concurrently; a torn read shows up as a 500 or an exception here.
    from backend.main import app

    failures: list = []
    stop = threading.Event()

    with TestClient(app) as client:

        def churn(worker: int):
            try:
                for i in range(60):
                    name = f"m{worker}-{i % 6}.onnx"
                    files = {"file": (name, b"model-bytes", "application/octet-stream")}
                    assert client.post("/api/models/upload", files=files).status_code == 200
                    assert client.delete(f"/api/models/{name}").status_code in (200, 404)
            except BaseException as exc:
                failures.append(exc)

        def read():
            try:
                while not stop.is_set():
                    assert client.get("/api/models/").status_code == 200
                    assert client.get("/api/slots/").status_code == 200
            except BaseException as exc:
                failures.append(exc)

        readers = [threading.Thread(target=read) for _ in range(2)]
        writers = [threading.Thread(target=churn, args=(w,)) for w in range(4)]
        for thread in readers + writers:
            thread.start()
        for thread in writers:
            thread.join()
        stop.set()
        for thread in readers:
            thread.join()

        assert not failures, failures[:3]
        assert client.get("/api/models/").json() == []
    assert list(Path(settings.MODELS_DIR).iterdir()) == []
