"""Model slots — w-okada VC Client pattern.

Five quick-switch slots bind a model name so the user can hot-swap voices
without browsing the full model list.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

SLOT_COUNT = 5


class SlotManager:
    def __init__(self, path: str | Path, model_manager) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._model_manager = model_manager
        self._lock = threading.Lock()
        self._slots: list[dict] = [
            {"index": i, "name": None, "label": f"Slot {i + 1}"} for i in range(SLOT_COUNT)
        ]
        self._load()

    def _load(self) -> None:
        if not self._path.is_file():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            slots = data.get("slots", [])
            for item in slots:
                idx = int(item.get("index", -1))
                name, label = item.get("name"), item.get("label")
                if 0 <= idx < SLOT_COUNT:
                    self._slots[idx] = {
                        "index": idx,
                        "name": name if isinstance(name, str) and name else None,
                        "label": label if isinstance(label, str) and label else f"Slot {idx + 1}",
                    }
        except Exception:
            logger.exception("Failed to load slots from %s", self._path)

    def _save(self) -> None:
        # Write beside the file and swap it in, so a crash mid-write cannot
        # leave a truncated file behind.
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"slots": self._slots}, indent=2), encoding="utf-8")
        tmp.replace(self._path)

    def list_slots(self) -> list[dict]:
        with self._lock:
            active = None
            try:
                am = self._model_manager.get_active_model()
                active = am["name"] if am else None
            except Exception:
                active = None
            out = []
            for s in self._slots:
                out.append({**s, "active": bool(s["name"] and s["name"] == active)})
            return out

    def bind(self, index: int, name: str | None, label: str | None = None) -> dict:
        if not (0 <= index < SLOT_COUNT):
            raise ValueError(f"Slot index must be 0–{SLOT_COUNT - 1}")
        with self._lock:
            if name:
                known = {m["name"] for m in self._model_manager.list_models()}
                if name not in known:
                    raise FileNotFoundError(f"Model not found: {name}")
            self._slots[index]["name"] = name
            if label:
                self._slots[index]["label"] = label
            self._save()
            return {**self._slots[index]}

    def activate(self, index: int) -> dict:
        with self._lock:
            if not (0 <= index < SLOT_COUNT):
                raise ValueError(f"Slot index must be 0–{SLOT_COUNT - 1}")
            name = self._slots[index]["name"]
            if not name:
                raise RuntimeError(f"Slot {index + 1} is empty")
        return self._model_manager.activate_model(name)
