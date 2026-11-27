"""Voice preset definitions and user preset persistence.

A preset bundles the tunable stream settings (pitch, formant, effect rack
state) into one named payload the client can apply in a single click.
Built-in presets ship with the app; user presets are stored as JSON on disk.
"""

import json
import logging
import re
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_USER_PRESETS = 100

def _natural(pitch: float, formant: float, low: float = 0, high: float = 0) -> dict:
    return {
        "pitch_shift": pitch,
        "formant_shift": formant,
        "effects": {
            "robot": {"enabled": False, "freq": 90},
            "eq": {"enabled": True, "low": low, "high": high},
        },
    }


BUILTIN_PRESETS = [
    # --- Age / gender (primary) ---
    {
        "id": "male",
        "name": "Male",
        "emoji": "♂",
        "description": "Young adult man",
        "settings": _natural(-1, -1.5, 2, -1),
    },
    {
        "id": "female",
        "name": "Female",
        "emoji": "♀",
        "description": "Young adult woman",
        "settings": _natural(5, 3.5, -1, 3),
    },
    {
        "id": "mid-man",
        "name": "Mid-age man",
        "emoji": "🧔",
        "description": "Deeper, warmer man",
        "settings": _natural(-4, -3, 4, -3),
    },
    {
        "id": "mid-woman",
        "name": "Mid-age woman",
        "emoji": "👩",
        "description": "Mature woman tone",
        "settings": _natural(3, 2, 1, 1),
    },
    {
        "id": "teen-boy",
        "name": "Teen boy",
        "emoji": "🧑",
        "description": "Teenage boy",
        "settings": _natural(2, 1, 0, 1),
    },
    {
        "id": "teen-girl",
        "name": "Teen girl",
        "emoji": "👧",
        "description": "Teenage girl",
        "settings": _natural(6, 4, -1, 4),
    },
    {
        "id": "boy",
        "name": "Boy",
        "emoji": "👦",
        "description": "Young boy",
        "settings": _natural(8, 5, -2, 5),
    },
    {
        "id": "girl",
        "name": "Girl",
        "emoji": "👧",
        "description": "Young girl",
        "settings": _natural(10, 6.5, -3, 6),
    },
    # --- Fun / FX ---
    {
        "id": "clean",
        "name": "Clean",
        "emoji": "🎙️",
        "description": "No coloration — raw model or mic output",
        "settings": {"pitch_shift": 0, "formant_shift": 0, "effects": {}},
    },
    {
        "id": "robot",
        "name": "Robot",
        "emoji": "🤖",
        "description": "Ring-mod metal voice with bit reduction",
        "settings": {
            "pitch_shift": 0,
            "formant_shift": 0,
            "effects": {
                "robot": {"enabled": True, "freq": 90},
                "bitcrush": {"enabled": True, "bits": 10, "down": 2},
            },
        },
    },
    {
        "id": "monster",
        "name": "Monster",
        "emoji": "👹",
        "description": "Growling low pitch with drive",
        "settings": {
            "pitch_shift": -9,
            "formant_shift": -5,
            "effects": {
                "distortion": {"enabled": True, "drive": 0.45},
                "reverb": {"enabled": True, "size": 0.35, "mix": 0.25},
            },
        },
    },
    {
        "id": "telephone",
        "name": "Telephone",
        "emoji": "📞",
        "description": "Narrowband landline call",
        "settings": {
            "pitch_shift": 0,
            "formant_shift": 0,
            "effects": {
                "telephone": {"enabled": True},
                "compressor": {"enabled": True, "threshold": -24, "ratio": 4},
            },
        },
    },
]


def _slugify(name: str) -> str:
    slug = re.sub(r"[^\w\-]+", "-", name.strip().lower()).strip("-")
    return slug[:48] or "preset"


class PresetStore:
    """Thread-safe JSON-file-backed store for user presets."""

    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._lock = threading.Lock()
        self._presets: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                # One malformed entry must not take the valid ones down with it.
                self._presets = {
                    p["id"]: p
                    for p in data
                    if isinstance(p, dict)
                    and isinstance(p.get("id"), str)
                    and isinstance(p.get("settings"), dict)
                }
            logger.info("Loaded %d user preset(s) from %s", len(self._presets), self._path)
        except Exception:
            logger.exception("Failed to load user presets from %s", self._path)

    def _flush_locked(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(list(self._presets.values()), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(self._path)

    def list_builtin(self) -> list[dict]:
        return [{**p, "builtin": True} for p in BUILTIN_PRESETS]

    def list_user(self) -> list[dict]:
        with self._lock:
            return [{**p, "builtin": False} for p in self._presets.values()]

    def save(self, name: str, settings: dict, emoji: str = "⭐") -> dict:
        name = name.strip()
        if not name:
            raise ValueError("Preset name is empty")
        if len(name) > 40:
            raise ValueError("Preset name is too long (max 40 characters)")
        if not isinstance(settings, dict):
            raise ValueError("Preset settings must be an object")

        try:
            pitch_shift = float(settings.get("pitch_shift", 0) or 0)
            formant_shift = float(settings.get("formant_shift", 0) or 0)
        except TypeError as exc:  # e.g. a list; a bad string is already a ValueError
            raise ValueError("pitch_shift and formant_shift must be numbers") from exc
        body = {
            "name": name,
            "emoji": (emoji or "⭐")[:4],
            "description": "Custom preset",
            "settings": {
                "pitch_shift": pitch_shift,
                "formant_shift": formant_shift,
                "effects": settings.get("effects") if isinstance(settings.get("effects"), dict) else {},
            },
        }
        # Raises ValueError for NaN / Infinity, which are not valid JSON and
        # would otherwise be written into the file.
        json.dumps(body, allow_nan=False)

        with self._lock:
            # Saving under the same name replaces that preset. A different
            # name that merely slugs the same ("My Voice" / "my voice!") gets
            # its own id instead of silently overwriting the other one.
            base = f"user-{_slugify(name)}"
            preset_id, n = base, 2
            while preset_id in self._presets and self._presets[preset_id].get("name") != name:
                preset_id, n = f"{base}-{n}", n + 1
            if preset_id not in self._presets and len(self._presets) >= MAX_USER_PRESETS:
                raise ValueError(f"Preset limit reached ({MAX_USER_PRESETS})")
            preset = {"id": preset_id, **body}
            self._presets[preset_id] = preset
            self._flush_locked()
        logger.info("Saved user preset: %s", preset_id)
        return {**preset, "builtin": False}

    def delete(self, preset_id: str) -> None:
        with self._lock:
            if preset_id not in self._presets:
                raise KeyError(preset_id)
            del self._presets[preset_id]
            self._flush_locked()
        logger.info("Deleted user preset: %s", preset_id)
