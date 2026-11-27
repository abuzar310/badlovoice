"""REST routes: health/config, presets, profiles, slots, models and file convert."""

import io
import json
import sys
import threading
import time
import tracemalloc
import types
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from backend.config import settings
from backend.services import model_manager as model_manager_module
from backend.services import onnx_processor

from .conftest import SR, audio_bytes, rms
from .test_dsp_effects import voice

JSON = {"content-type": "application/json"}


def upload(client, name: str, data: bytes = b"model-bytes"):
    return client.post("/api/models/upload", files={"file": (name, data, "application/octet-stream")})


def convert(client, audio_file: bytes, filename: str = "take.wav", **fields):
    fields.setdefault("use_model", "false")
    return client.post(
        "/api/convert/", files={"file": (filename, audio_file, "audio/wav")}, data=fields
    )


def decode(response) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(io.BytesIO(response.content), dtype="float32")
    return audio, sr


def restart(client) -> TestClient:
    """A second app start on the same storage, as after a server restart."""
    return TestClient(client.app)


# --- health / config ----------------------------------------------------------


def test_health(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_config_reports_stream_defaults_and_runtime(client):
    config = client.get("/api/config").json()

    assert config["sample_rate"] == settings.SAMPLE_RATE
    assert config["chunk_size"] == settings.CHUNK_SIZE
    assert {mode["id"] for mode in config["latency_modes"]} == {"ultra", "balanced", "quality"}
    assert isinstance(config["onnx_available"], bool)
    assert isinstance(config["torch_available"], bool)
    assert config["runtime"]["torch"]["device"]


# --- presets ------------------------------------------------------------------


def test_presets_start_with_builtins_only(client):
    presets = client.get("/api/presets/").json()

    assert len(presets["builtin"]) >= 10
    assert all(p["builtin"] for p in presets["builtin"])
    assert presets["user"] == []


def test_preset_save_list_delete_round_trip(client):
    effects = {
        "echo": {"enabled": True, "time": 0.2},
        "monotone": {"enabled": True, "freq": 110},  # browser-only effect: must round-trip
    }
    saved = client.post(
        "/api/presets/",
        json={"name": "Night Shift", "emoji": "🌙", "settings": {"pitch_shift": -3, "effects": effects}},
    )
    assert saved.status_code == 200
    preset = saved.json()
    assert preset["name"] == "Night Shift"
    assert preset["settings"] == {"pitch_shift": -3.0, "formant_shift": 0.0, "effects": effects}

    assert client.get("/api/presets/").json()["user"] == [preset]
    with restart(client) as again:
        assert again.get("/api/presets/").json()["user"] == [preset]

    assert client.delete(f"/api/presets/{preset['id']}").status_code == 200
    assert client.get("/api/presets/").json()["user"] == []
    assert client.delete(f"/api/presets/{preset['id']}").status_code == 404


def test_preset_saved_again_under_the_same_name_is_replaced(client):
    client.post("/api/presets/", json={"name": "Mine", "settings": {"pitch_shift": 1}})
    client.post("/api/presets/", json={"name": "Mine", "settings": {"pitch_shift": 5}})

    user = client.get("/api/presets/").json()["user"]
    assert [p["settings"]["pitch_shift"] for p in user] == [5.0]


def test_presets_with_different_names_never_overwrite_each_other(client):
    for name in ["My Voice", "my voice!", "MY  VOICE", "???", "!!!"]:
        assert client.post("/api/presets/", json={"name": name, "settings": {}}).status_code == 200

    user = client.get("/api/presets/").json()["user"]
    assert sorted(p["name"] for p in user) == sorted(["My Voice", "my voice!", "MY  VOICE", "???", "!!!"])
    assert len({p["id"] for p in user}) == 5


@pytest.mark.parametrize(
    "payload, status",
    [
        ({"name": "", "settings": {}}, 422),
        ({"name": "x" * 41, "settings": {}}, 422),
        ({"name": "ok", "settings": "not an object"}, 422),
        ({"name": "ok"}, 422),
        ({"name": "   ", "settings": {}}, 400),
        ({"name": "ok", "settings": {"pitch_shift": "high"}}, 400),
        ({"name": "ok", "settings": {"pitch_shift": [1]}}, 400),
    ],
)
def test_invalid_preset_is_rejected(client, payload, status):
    assert client.post("/api/presets/", json=payload).status_code == status
    assert client.get("/api/presets/").json()["user"] == []


@pytest.mark.parametrize(
    "body",
    [
        '{"name": "bad", "settings": {"pitch_shift": NaN}}',
        '{"name": "bad", "settings": {"formant_shift": Infinity}}',
        '{"name": "bad", "settings": {"effects": {"eq": {"low": NaN}}}}',
    ],
)
def test_preset_with_non_finite_number_is_rejected_and_the_list_survives(client, body):
    response = client.post("/api/presets/", content=body, headers=JSON)

    assert response.status_code == 400
    assert client.get("/api/presets/").status_code == 200


def test_one_malformed_entry_in_the_presets_file_does_not_hide_the_rest(app_paths):
    from backend.main import app

    path = Path(settings.PRESETS_PATH)
    path.parent.mkdir(parents=True)
    good = {"id": "user-good", "name": "Good", "emoji": "⭐", "settings": {"pitch_shift": 1}}
    path.write_text(json.dumps([{"id": ["bad"], "settings": {}}, 7, {"id": "no-settings"}, good]))

    with TestClient(app) as client:
        user = client.get("/api/presets/").json()["user"]

    assert [p["id"] for p in user] == ["user-good"]


@pytest.mark.parametrize("content", ["{not json", "", "null", "{}", '"text"', "[[]]"])
def test_unreadable_presets_file_starts_empty(app_paths, content):
    from backend.main import app

    path = Path(settings.PRESETS_PATH)
    path.parent.mkdir(parents=True)
    path.write_text(content)

    with TestClient(app) as client:
        assert client.get("/api/presets/").json()["user"] == []
        assert client.post("/api/presets/", json={"name": "New", "settings": {}}).status_code == 200


# --- profiles -----------------------------------------------------------------


def test_latency_modes(client):
    modes = client.get("/api/profiles/latency-modes").json()

    assert [m["id"] for m in modes] == ["ultra", "balanced", "quality"]
    assert all(m["chunk_size"] % 256 == 0 for m in modes)


def test_profile_save_list_delete_round_trip(client):
    snapshot = {"pitch_shift": 2, "effects": {"vibrato": {"enabled": True}}, "sample_rate": 48000}
    first = client.post("/api/profiles/", json={"name": "Stream", "settings": snapshot}).json()
    second = client.post("/api/profiles/", json={"name": "Stream", "settings": snapshot}).json()

    assert first["settings"] == snapshot
    assert first["id"] != second["id"]  # same name twice gives two profiles
    assert [p["id"] for p in client.get("/api/profiles/").json()] == [first["id"], second["id"]]
    with restart(client) as again:
        assert len(again.get("/api/profiles/").json()) == 2

    assert client.delete(f"/api/profiles/{first['id']}").status_code == 200
    assert client.delete(f"/api/profiles/{first['id']}").status_code == 404
    assert [p["id"] for p in client.get("/api/profiles/").json()] == [second["id"]]


def test_profile_limit(client):
    for i in range(40):
        assert client.post("/api/profiles/", json={"name": f"p{i}", "settings": {}}).status_code == 200

    assert client.post("/api/profiles/", json={"name": "one too many", "settings": {}}).status_code == 400


def test_profile_with_non_finite_number_is_rejected_and_the_list_survives(client):
    body = '{"name": "bad", "settings": {"extras": {"vadThresholdDb": NaN}}}'

    assert client.post("/api/profiles/", content=body, headers=JSON).status_code == 400
    assert client.get("/api/profiles/").json() == []


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        "[]",
        '{"profiles": "abc"}',
        '{"profiles": [1, "two", null]}',
        '{"profiles": {"id": "x"}}',
        '{"profiles": [{"id": 5, "name": "numeric id", "settings": {}}]}',
    ],
)
def test_malformed_profiles_file_does_not_break_the_api(app_paths, content):
    from backend.main import app

    path = Path(settings.PROFILES_PATH)
    path.parent.mkdir(parents=True)
    path.write_text(content)

    with TestClient(app) as client:
        assert client.get("/api/profiles/").json() == []
        saved = client.post("/api/profiles/", json={"name": "New", "settings": {}}).json()
        assert client.delete(f"/api/profiles/{saved['id']}").status_code == 200


# --- model slots --------------------------------------------------------------


def test_slots_start_empty(client):
    slots = client.get("/api/slots/").json()

    assert [s["index"] for s in slots] == [0, 1, 2, 3, 4]
    assert all(s["name"] is None and s["active"] is False for s in slots)


def test_slot_bind_unbind_and_persist(client):
    upload(client, "voice.onnx")

    bound = client.put("/api/slots/2", json={"name": "voice.onnx", "label": "Main"})
    assert bound.status_code == 200
    assert bound.json() == {"index": 2, "name": "voice.onnx", "label": "Main"}
    with restart(client) as again:
        assert again.get("/api/slots/").json()[2]["name"] == "voice.onnx"

    assert client.put("/api/slots/2", json={"name": None}).json()["name"] is None
    assert client.get("/api/slots/").json()[2]["name"] is None


@pytest.mark.parametrize(
    "index, body, status",
    [
        (0, {"name": "missing.onnx"}, 404),
        (5, {"name": None}, 400),
        (-1, {"name": None}, 400),
        (0, {"name": None, "label": "x" * 49}, 422),
    ],
)
def test_invalid_slot_binding_is_rejected(client, index, body, status):
    assert client.put(f"/api/slots/{index}", json=body).status_code == status


def test_activating_an_empty_slot_is_a_client_error(client):
    assert client.post("/api/slots/0/activate").status_code == 400
    assert client.post("/api/slots/9/activate").status_code == 400


def test_slot_activation_loads_the_bound_model(client, fake_onnx):
    upload(client, "voice.onnx")
    client.put("/api/slots/1", json={"name": "voice.onnx"})

    assert client.post("/api/slots/1/activate").json()["name"] == "voice.onnx"
    slots = client.get("/api/slots/").json()
    assert [s["active"] for s in slots] == [False, True, False, False, False]


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        "[]",
        '{"slots": "abc"}',
        '{"slots": [1, null]}',
        '{"slots": [{"index": 0, "name": {"a": 1}, "label": ["x"]}]}',
        '{"slots": [{"index": "zero", "name": "a.onnx"}]}',
    ],
)
def test_malformed_slots_file_does_not_break_the_api(app_paths, content):
    from backend.main import app

    path = Path(settings.SLOTS_PATH)
    path.parent.mkdir(parents=True)
    path.write_text(content)

    with TestClient(app) as client:
        slots = client.get("/api/slots/").json()
        assert [s["index"] for s in slots] == [0, 1, 2, 3, 4]
        assert all(s["name"] is None for s in slots)
        assert all(isinstance(s["label"], str) for s in slots)
        assert client.post("/api/slots/0/activate").status_code == 400


# --- models -------------------------------------------------------------------


def test_models_start_empty(client):
    assert client.get("/api/models/").json() == []
    assert client.get("/api/models/active").json() == {"active": False}
    assert client.post("/api/models/deactivate").status_code == 200


def test_model_upload_list_delete_round_trip(client, app_paths):
    response = upload(client, "voice.onnx", b"\x08\x07onnx-bytes")

    assert response.status_code == 200
    assert response.json()["name"] == "voice.onnx"
    assert response.json()["type"] == "onnx"
    assert (app_paths / "models" / "voice.onnx").read_bytes() == b"\x08\x07onnx-bytes"
    listed = client.get("/api/models/").json()
    assert [(m["name"], m["type"], m["size_bytes"], m["active"]) for m in listed] == [
        ("voice.onnx", "onnx", 12, False)
    ]

    assert client.delete("/api/models/voice.onnx").status_code == 200
    assert not (app_paths / "models" / "voice.onnx").exists()
    assert client.get("/api/models/").json() == []
    assert client.delete("/api/models/voice.onnx").status_code == 404


@pytest.mark.parametrize("name", ["notes.txt", "model.pth.exe", "model", ".pth", "archive.zip"])
def test_upload_with_unsupported_extension_is_rejected(client, app_paths, name):
    assert upload(client, name).status_code == 400
    assert list((app_paths / "models").iterdir()) == []


@pytest.mark.parametrize(
    "name",
    ["../../evil.onnx", "..\\..\\evil.onnx", "/etc/cron.d/evil.onnx", "a/b/../../../evil.onnx", "C:\\evil.onnx"],
)
def test_upload_cannot_write_outside_the_models_directory(client, app_paths, name):
    response = upload(client, name)

    assert response.status_code == 200
    stored = response.json()["name"]
    assert "/" not in stored and "\\" not in stored
    models_dir = app_paths / "models"
    assert [p.name for p in models_dir.iterdir()] == [stored]
    assert sorted(p.name for p in app_paths.iterdir()) == ["data", "models"]  # nothing escaped


def test_upload_with_uppercase_extension_is_a_usable_model(client):
    response = upload(client, "Voice.PTH")

    assert response.status_code == 200
    assert response.json()["type"] == "rvc"
    with restart(client) as again:  # still there after a restart
        assert [m["type"] for m in again.get("/api/models/").json()] == ["rvc"]


def test_upload_with_overlong_name_is_a_client_error(client):
    assert upload(client, "a" * 300 + ".onnx").status_code == 400


def test_upload_replaces_a_model_of_the_same_name(client, app_paths):
    upload(client, "voice.onnx", b"first version")
    upload(client, "voice.onnx", b"second")

    assert (app_paths / "models" / "voice.onnx").read_bytes() == b"second"
    assert [m["size_bytes"] for m in client.get("/api/models/").json()] == [6]


def test_rejected_upload_leaves_the_existing_model_intact(client, app_paths, monkeypatch):
    upload(client, "voice.onnx", b"the good model")
    monkeypatch.setattr(model_manager_module, "MAX_MODEL_SIZE", 20)

    response = upload(client, "voice.onnx", b"x" * 500)

    assert response.status_code == 400
    assert (app_paths / "models" / "voice.onnx").read_bytes() == b"the good model"
    assert [p.name for p in (app_paths / "models").iterdir()] == ["voice.onnx"]  # no leftovers
    assert [m["name"] for m in client.get("/api/models/").json()] == ["voice.onnx"]


def test_index_file_is_attached_to_and_deleted_with_its_model(client, app_paths):
    upload(client, "voice.pth")
    assert client.get("/api/models/").json()[0]["has_index"] is False

    assert upload(client, "voice.index").json()["type"] == "index"
    assert [(m["name"], m["has_index"]) for m in client.get("/api/models/").json()] == [("voice.pth", True)]

    client.delete("/api/models/voice.pth")
    assert list((app_paths / "models").iterdir()) == []


def test_index_file_survives_while_another_model_still_uses_it(client, app_paths):
    upload(client, "voice.pth")
    upload(client, "voice.pt")
    upload(client, "voice.index")

    client.delete("/api/models/voice.pth")

    assert sorted(p.name for p in (app_paths / "models").iterdir()) == ["voice.index", "voice.pt"]


def test_activating_an_unknown_model_is_404(client):
    assert client.post("/api/models/nope.onnx/activate").status_code == 404


def test_activate_use_and_deactivate_a_model(client, fake_onnx):
    upload(client, "voice.onnx")

    activated = client.post("/api/models/voice.onnx/activate")
    assert activated.status_code == 200
    assert activated.json() == {
        "name": "voice.onnx", "type": "onnx", "status": "active", "details": {"engine": "fake"},
    }  # fmt: skip
    assert client.get("/api/models/active").json()["name"] == "voice.onnx"
    assert [m["active"] for m in client.get("/api/models/").json()] == [True]

    assert client.post("/api/models/deactivate").status_code == 200
    assert client.get("/api/models/active").json() == {"active": False}
    assert fake_onnx.alive == []


def test_switching_models_unloads_the_previous_one(client, fake_onnx):
    upload(client, "a.onnx")
    upload(client, "b.onnx")

    client.post("/api/models/a.onnx/activate")
    client.post("/api/models/b.onnx/activate")

    assert [Path(p.model_path).name for p in fake_onnx.alive] == ["b.onnx"]


def test_deleting_the_active_model_unloads_it(client, fake_onnx):
    upload(client, "voice.onnx")
    client.post("/api/models/voice.onnx/activate")

    assert client.delete("/api/models/voice.onnx").status_code == 200
    assert client.get("/api/models/active").json() == {"active": False}
    assert fake_onnx.alive == []


def test_onnx_model_without_onnxruntime_fails_with_a_clear_message(client, monkeypatch):
    monkeypatch.setattr(onnx_processor, "ort", None)  # as on a machine without onnxruntime
    upload(client, "voice.onnx")

    response = client.post("/api/models/voice.onnx/activate")

    assert response.status_code == 500
    assert "onnxruntime" in response.json()["detail"]
    assert client.get("/api/models/active").json() == {"active": False}


def test_rvc_model_without_hubert_fails_with_a_clear_message(client, monkeypatch, app_paths):
    monkeypatch.setattr(settings, "HUBERT_PATH", str(app_paths / "missing-hubert.pt"))
    upload(client, "voice.pth")

    response = client.post("/api/models/voice.pth/activate")

    assert response.status_code == 500
    assert "SHIFTBOOTH_HUBERT_PATH" in response.json()["detail"]


def test_server_stays_responsive_while_a_model_loads(client, fake_onnx):
    fake_onnx.load_seconds = 1.0
    upload(client, "slow.onnx")
    activation = threading.Thread(target=client.post, args=("/api/models/slow.onnx/activate",))
    activation.start()
    assert fake_onnx.loading.wait(timeout=5)

    started = time.perf_counter()
    health = client.get("/health")
    active = client.get("/api/models/active")
    slots = client.get("/api/slots/")
    waited = time.perf_counter() - started
    activation.join()

    assert (health.status_code, active.status_code, slots.status_code) == (200, 200, 200)
    assert active.json() == {"active": False}  # still loading
    assert waited < 0.5, "requests were stuck behind the model load"
    assert client.get("/api/models/active").json()["name"] == "slow.onnx"


def _saved_preset(client) -> str:
    return client.post("/api/presets/", json={"name": "Old", "settings": {}}).json()["id"]


def _saved_profile(client) -> str:
    return client.post("/api/profiles/", json={"name": "Old", "settings": {}}).json()["id"]


@pytest.mark.parametrize(
    "request_for",
    [
        lambda c: ("POST", "/api/presets/", {"json": {"name": "New", "settings": {}}}),
        lambda c: ("DELETE", f"/api/presets/{_saved_preset(c)}", {}),
        lambda c: ("POST", "/api/profiles/", {"json": {"name": "New", "settings": {}}}),
        lambda c: ("DELETE", f"/api/profiles/{_saved_profile(c)}", {}),
        lambda c: ("PUT", "/api/slots/0", {"json": {"name": None, "label": "New"}}),
    ],
    ids=["save-preset", "delete-preset", "save-profile", "delete-profile", "bind-slot"],
)
def test_server_stays_responsive_while_settings_are_written_to_a_slow_disk(
    client, monkeypatch, request_for
):
    method, path, kwargs = request_for(client)
    writing = threading.Event()
    real_replace = Path.replace

    def slow_replace(self, target):  # a busy or sleeping disk
        writing.set()
        time.sleep(0.8)
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", slow_replace)
    outcome = {}
    worker = threading.Thread(
        target=lambda: outcome.update(status=client.request(method, path, **kwargs).status_code)
    )
    worker.start()
    assert writing.wait(timeout=5)

    started = time.perf_counter()
    assert client.get("/health").status_code == 200
    waited = time.perf_counter() - started
    worker.join()

    assert outcome["status"] == 200
    assert waited < 0.4, "the audio event loop was stuck behind a settings file write"


@pytest.mark.parametrize(
    "save, list_path",
    [
        (("POST", "/api/presets/", {"json": {"name": "New", "settings": {}}}), "/api/presets/"),
        (("POST", "/api/profiles/", {"json": {"name": "New", "settings": {}}}), "/api/profiles/"),
        (("PUT", "/api/slots/0", {"json": {"name": None, "label": "New"}}), "/api/slots/"),
    ],
    ids=["presets", "profiles", "slots"],
)
def test_listing_during_a_slow_save_does_not_stall_the_server(client, monkeypatch, save, list_path):
    method, path, kwargs = save
    writing = threading.Event()
    real_replace = Path.replace

    def slow_replace(self, target):
        writing.set()
        time.sleep(0.8)
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", slow_replace)
    saver = threading.Thread(target=client.request, args=(method, path), kwargs=kwargs)
    saver.start()
    assert writing.wait(timeout=5)
    lister = threading.Thread(target=client.get, args=(list_path,))  # waits for the save
    lister.start()
    time.sleep(0.1)  # let the list request reach the store

    started = time.perf_counter()
    assert client.get("/health").status_code == 200
    waited = time.perf_counter() - started
    saver.join()
    lister.join()

    assert waited < 0.4, "the audio event loop was stuck behind a settings file write"


# --- offline file convert -----------------------------------------------------


def test_convert_renders_a_wav_through_the_effect_chain(client):
    x = voice(SR)
    effects = {
        "robot": {"enabled": True, "freq": 90, "mix": 0.75},
        "vibrato": {"enabled": True, "rate": 5.5},  # browser-only: ignored here
    }

    response = convert(client, audio_bytes(x), pitch_shift="3", effects=json.dumps(effects))

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert 'filename="take_converted.wav"' in response.headers["content-disposition"]
    y, sr = decode(response)
    assert sr == SR
    assert y.shape == x.shape
    assert not np.allclose(y, x, atol=1e-2)
    assert 0.2 < rms(y) / rms(x) < 2.0


def test_convert_without_settings_returns_the_same_audio(client):
    x = voice(SR // 2)

    y, _ = decode(convert(client, audio_bytes(x)))

    np.testing.assert_allclose(y, x, atol=1e-4)  # 16-bit round trip


def test_convert_downmixes_stereo(client):
    stereo = np.stack([voice(SR // 2), np.zeros(SR // 2, dtype=np.float32)], axis=1)

    y, _ = decode(convert(client, audio_bytes(stereo)))

    assert y.ndim == 1
    np.testing.assert_allclose(y, stereo.mean(axis=1), atol=1e-4)


def test_convert_runs_the_active_model(client, fake_onnx):
    upload(client, "voice.onnx")
    client.post("/api/models/voice.onnx/activate")
    x = voice(SR // 2)

    y, _ = decode(convert(client, audio_bytes(x), use_model="true"))

    np.testing.assert_allclose(y, x * 0.5, atol=1e-4)


def test_each_conversion_uses_and_releases_its_own_model_stream(client):
    class RecordingModels:
        def __init__(self):
            self.used, self.released = [], []

        def get_active_model(self):
            return {"name": "voice.pth", "type": "rvc"}

        def process_audio(self, audio, settings):
            self.used.append(settings["stream_id"])
            return audio

        def release_stream(self, stream_id):
            self.released.append(stream_id)

    models = RecordingModels()
    client.app.state.model_manager = models

    for _ in range(2):
        assert convert(client, audio_bytes(voice(2000)), use_model="true").status_code == 200

    # A shared id would let one job's audio become the model context of another.
    assert len(set(models.used)) == 2
    assert models.released == models.used


@pytest.mark.parametrize(
    "audio_file, fields, status",
    [
        (b"", {}, 400),
        (b"this is not audio at all", {}, 400),
        (audio_bytes(np.zeros(100, dtype=np.float32)), {"effects": "{not json"}, 400),
        (audio_bytes(np.zeros(100, dtype=np.float32)), {"pitch_shift": "high"}, 422),
        (audio_bytes(np.zeros(0, dtype=np.float32)), {}, 400),
    ],
    ids=["empty", "not-audio", "bad-effects-json", "bad-pitch", "no-samples"],
)
def test_invalid_convert_request_is_rejected(client, audio_file, fields, status):
    assert convert(client, audio_file, **fields).status_code == status


@pytest.mark.parametrize("junk", ["nan", "inf", "-inf", "1e30"])
def test_convert_with_garbage_shift_values_still_renders(client, junk):
    response = convert(client, audio_bytes(voice(SR // 4)), pitch_shift=junk, formant_shift=junk)

    assert response.status_code == 200
    assert np.all(np.isfinite(decode(response)[0]))


def test_convert_rejects_audio_longer_than_the_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "MAX_CONVERT_SECONDS", 1)

    assert convert(client, audio_bytes(voice(2 * SR))).status_code == 413


def test_overlong_compressed_upload_is_rejected_without_decoding_it(client):
    # 20 minutes of silence is a small FLAC file but ~77 MB once decoded.
    flac = audio_bytes(np.zeros(20 * 60 * 16000, dtype=np.int16), sr=16000, fmt="FLAC")
    assert len(flac) < 2_000_000

    tracemalloc.start()
    try:
        response = convert(client, flac, filename="silence.flac")
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()

    assert response.status_code == 413
    assert peak < 20 * 1024 * 1024, f"decoded {peak / 1e6:.0f} MB before rejecting the file"


@pytest.mark.parametrize("sample_rate", [100, 400_000])
def test_convert_rejects_unsupported_sample_rates(client, sample_rate):
    # Delay lines are sized from the file's sample rate; a header claiming
    # gigahertz would otherwise ask for gigabytes.
    response = convert(client, audio_bytes(voice(2000), sr=sample_rate))

    assert response.status_code == 400
    assert "sample rate" in response.json()["detail"].lower()


@pytest.mark.parametrize("filename", ["आवाज़.wav", "голос.wav", "🎤 take.wav", 'my "best" take.wav'])
def test_convert_accepts_any_upload_filename(client, filename):
    response = convert(client, audio_bytes(voice(2000)), filename=filename)

    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="')
    assert disposition.count('"') == 2  # one quoted ASCII name, nothing breaking out of it
    assert "filename*=UTF-8''" in disposition


def test_formats_soundfile_cannot_read_are_decoded_from_a_real_file(client, monkeypatch):
    # m4a and friends go through librosa, which can only use its audioread
    # backends when given a path on disk. librosa is not in the light install,
    # so a stand-in records what it was asked to load.
    seen = {}

    def load(path, sr=None, mono=True, **kwargs):
        seen["was_file"] = Path(path).is_file()
        seen["suffix"] = Path(path).suffix
        seen["bytes"] = Path(path).read_bytes()
        seen["path"] = Path(path)
        return voice(4000), 22050

    monkeypatch.setitem(sys.modules, "librosa", types.SimpleNamespace(load=load))
    not_wav = b"\x00\x00\x00\x20ftypM4A fake container"

    response = convert(client, not_wav, filename="memo.m4a")

    assert response.status_code == 200
    assert seen["was_file"] and seen["suffix"] == ".m4a" and seen["bytes"] == not_wav
    assert not seen["path"].exists()  # temp file cleaned up
    y, sr = decode(response)
    assert sr == 22050 and len(y) == 4000
