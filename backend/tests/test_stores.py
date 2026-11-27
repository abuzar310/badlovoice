"""Preset / profile / slot stores: crashes mid-save and concurrent writers."""

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from backend.services.preset_store import PresetStore
from backend.services.profile_store import ProfileStore
from backend.services.slot_manager import SlotManager


class Models:
    """The slice of ModelManager the slot manager uses."""

    def list_models(self):
        return [{"name": "voice.onnx"}, {"name": "other.pth"}]

    def get_active_model(self):
        return None


def crash_mid_write(monkeypatch) -> None:
    """Make every text write die halfway through, like a full disk or a killed process."""
    real_write_text = Path.write_text

    def torn_write(self, data, *args, **kwargs):
        real_write_text(self, data[: len(data) // 2], *args, **kwargs)
        raise OSError("No space left on device")

    monkeypatch.setattr(Path, "write_text", torn_write)


def test_presets_survive_a_crash_mid_save(tmp_path, monkeypatch):
    path = tmp_path / "presets.json"
    store = PresetStore(str(path))
    store.save("Keep me", {"pitch_shift": 2})

    with monkeypatch.context() as patch:
        crash_mid_write(patch)
        with pytest.raises(OSError):
            store.save("Lost", {})

    assert [p["name"] for p in PresetStore(str(path)).list_user()] == ["Keep me"]


def test_profiles_survive_a_crash_mid_save(tmp_path, monkeypatch):
    path = tmp_path / "profiles.json"
    store = ProfileStore(path)
    store.save_profile("Keep me", {"pitch_shift": 2})

    with monkeypatch.context() as patch:
        crash_mid_write(patch)
        with pytest.raises(OSError):
            store.save_profile("Lost", {})

    assert [p["name"] for p in ProfileStore(path).list_profiles()] == ["Keep me"]


def test_slots_survive_a_crash_mid_save(tmp_path, monkeypatch):
    path = tmp_path / "slots.json"
    slots = SlotManager(path, Models())
    slots.bind(0, "voice.onnx", "Main")

    with monkeypatch.context() as patch:
        crash_mid_write(patch)
        with pytest.raises(OSError):
            slots.bind(1, "other.pth")

    reloaded = SlotManager(path, Models()).list_slots()
    assert (reloaded[0]["name"], reloaded[0]["label"]) == ("voice.onnx", "Main")


def test_concurrent_preset_saves_are_all_kept(tmp_path):
    path = tmp_path / "presets.json"
    store = PresetStore(str(path))

    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(lambda i: store.save(f"Preset {i}", {"pitch_shift": i}), range(60)))

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert sorted(p["name"] for p in on_disk) == sorted(f"Preset {i}" for i in range(60))


def test_concurrent_profile_saves_are_all_kept_with_unique_ids(tmp_path):
    path = tmp_path / "profiles.json"
    store = ProfileStore(path)

    with ThreadPoolExecutor(max_workers=16) as pool:
        saved = list(pool.map(lambda i: store.save_profile("Same name", {"n": i}), range(40)))

    assert len({p["id"] for p in saved}) == 40
    on_disk = json.loads(path.read_text(encoding="utf-8"))["profiles"]
    assert sorted(p["settings"]["n"] for p in on_disk) == list(range(40))


def test_concurrent_slot_binds_are_all_kept(tmp_path):
    path = tmp_path / "slots.json"
    slots = SlotManager(path, Models())

    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(lambda i: slots.bind(i, "voice.onnx", f"Label {i}"), range(5)))

    on_disk = json.loads(path.read_text(encoding="utf-8"))["slots"]
    assert [s["label"] for s in on_disk] == [f"Label {i}" for i in range(5)]
