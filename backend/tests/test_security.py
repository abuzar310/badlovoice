"""Front-door checks: cross-site requests, CORS, bind address, body-size caps."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

from backend.config import Settings, settings
from backend.services import model_manager as model_manager_module

from .conftest import SR, audio_bytes
from .test_dsp_effects import voice
from .test_websocket import CHUNK, exchange

REPO_ROOT = Path(__file__).resolve().parents[2]
EVIL = "https://evil.example"
MODEL_FILE = {"file": ("voice.onnx", b"model-bytes", "application/octet-stream")}


# --- defaults -----------------------------------------------------------------


def test_default_bind_address_is_loopback(monkeypatch):
    monkeypatch.delenv("SHIFTBOOTH_HOST", raising=False)

    assert Settings(_env_file=None).HOST == "127.0.0.1"


# --- cross-site requests --------------------------------------------------------


@pytest.mark.parametrize(
    "method, path, kwargs",
    [
        ("POST", "/api/models/upload", {"files": MODEL_FILE}),
        ("POST", "/api/models/voice.onnx/activate", {}),
        ("POST", "/api/models/deactivate", {}),
        ("DELETE", "/api/models/voice.onnx", {}),
        ("POST", "/api/presets/", {"json": {"name": "planted", "settings": {}}}),
        ("POST", "/api/profiles/", {"json": {"name": "planted", "settings": {}}}),
        ("PUT", "/api/slots/0", {"json": {"name": None, "label": "planted"}}),
        ("POST", "/api/slots/0/activate", {}),
        ("POST", "/api/convert/", {"files": {"file": ("a.wav", audio_bytes(voice(2000)), "audio/wav")}}),
        ("GET", "/api/models/", {}),
        ("GET", "/api/config", {}),
    ],
    ids=lambda value: value if isinstance(value, str) else "",
)
def test_request_from_another_site_is_refused(client, method, path, kwargs):
    client.post("/api/models/upload", files=MODEL_FILE)  # something worth attacking

    response = client.request(method, path, headers={"Origin": EVIL}, **kwargs)

    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers
    # ... and nothing happened behind the refusal.
    assert [m["name"] for m in client.get("/api/models/").json()] == ["voice.onnx"]
    assert client.get("/api/presets/").json()["user"] == []
    assert client.get("/api/profiles/").json() == []
    assert client.get("/api/slots/").json()[0]["label"] == "Slot 1"


def test_cors_preflight_from_another_site_is_not_approved(client):
    response = client.options(
        "/api/presets/",
        headers={
            "Origin": EVIL,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code in (400, 403)
    assert "access-control-allow-origin" not in response.headers
    assert "access-control-allow-credentials" not in response.headers


@pytest.mark.parametrize(
    "origin",
    [
        "http://testserver",  # the page was served by this server
        "http://localhost:5173",  # Vite dev server proxying to the backend
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8000",
        "http://[::1]:5173",
        "https://localhost",  # Capacitor WebView
        "capacitor://localhost",
    ],
)
def test_same_host_and_local_pages_are_served(client, origin):
    assert client.post("/api/models/deactivate", headers={"Origin": origin}).status_code == 200


def test_requests_without_an_origin_are_served(client):
    assert client.post("/api/models/deactivate").status_code == 200  # curl, scripts


@pytest.mark.parametrize(
    "origin",
    [
        "null",  # sandboxed iframe, file:// page
        "",
        "http://localhost.evil.example",
        "http://127.0.0.1.evil.example:5173",
        "http://testserver.evil.example",
        "http://evil.example/?http://localhost:5173",
        "http://evil.example@localhost:5173",
        "http://[::1",
        "localhost",
    ],
)
def test_lookalike_origins_are_refused(client, origin):
    assert client.post("/api/models/deactivate", headers={"Origin": origin}).status_code == 403


def test_websocket_from_another_site_is_refused(client):
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/ws/audio", headers={"Origin": EVIL}):
            pass

    assert refused.value.code == 1008


def test_websocket_from_a_local_page_is_accepted(client):
    with client.websocket_connect("/ws/audio", headers={"Origin": "http://localhost:5173"}) as ws:
        ws.send_text(json.dumps({"sample_rate": SR, "chunk_size": CHUNK}))
        assert exchange(ws, 0, voice(CHUNK)).shape == (CHUNK,)


def _probe_with_cors_setting(value: str) -> dict:
    """Start the app in a fresh interpreter with SHIFTBOOTH_CORS_ORIGINS set."""
    code = """
import json
from fastapi.testclient import TestClient
from backend.main import app

out = {}
with TestClient(app) as client:
    for label, origin in [("studio", "https://studio.example"), ("evil", "https://evil.example")]:
        r = client.post("/api/models/deactivate", headers={"Origin": origin})
        out[label] = {
            "status": r.status_code,
            "allow_origin": r.headers.get("access-control-allow-origin"),
            "allow_credentials": r.headers.get("access-control-allow-credentials"),
        }
print(json.dumps(out))
"""
    env = {**os.environ, "SHIFTBOOTH_CORS_ORIGINS": value}
    result = subprocess.run(
        [sys.executable, "-W", "ignore", "-c", code],
        capture_output=True, text=True, cwd=REPO_ROOT, env=env, timeout=120,
    )  # fmt: skip
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_origin_listed_in_settings_is_allowed_with_cors_headers(app_paths, monkeypatch):
    for name in ("MODELS_DIR", "PRESETS_PATH", "SLOTS_PATH", "PROFILES_PATH"):
        monkeypatch.setenv(f"SHIFTBOOTH_{name}", getattr(settings, name))

    seen = _probe_with_cors_setting('["https://studio.example"]')

    assert seen["studio"] == {
        "status": 200, "allow_origin": "https://studio.example", "allow_credentials": None,
    }  # fmt: skip
    assert seen["evil"]["status"] == 403


def test_wildcard_origin_setting_opts_out_of_the_check(app_paths, monkeypatch):
    for name in ("MODELS_DIR", "PRESETS_PATH", "SLOTS_PATH", "PROFILES_PATH"):
        monkeypatch.setenv(f"SHIFTBOOTH_{name}", getattr(settings, name))

    seen = _probe_with_cors_setting('["*"]')

    assert seen["evil"] == {"status": 200, "allow_origin": "*", "allow_credentials": None}


# --- body-size caps -------------------------------------------------------------


def _big_preset(megabytes: int) -> bytes:
    filler = "x" * (megabytes * 1024 * 1024)
    return json.dumps({"name": "big", "settings": {"effects": {"filler": filler}}}).encode()


def test_oversized_json_body_is_refused(client):
    response = client.post(
        "/api/presets/", content=_big_preset(2), headers={"content-type": "application/json"}
    )

    assert response.status_code == 413
    assert client.get("/api/presets/").json()["user"] == []


def test_oversized_body_sent_without_a_declared_length_is_refused(client):
    body = _big_preset(2)

    def chunks():  # an iterator makes the client use chunked transfer encoding
        for start in range(0, len(body), 64 * 1024):
            yield body[start : start + 64 * 1024]

    response = client.post(
        "/api/presets/", content=chunks(), headers={"content-type": "application/json"}
    )

    assert response.status_code == 413
    assert client.get("/api/presets/").json()["user"] == []


def test_upload_far_over_the_model_limit_is_refused_up_front(client, app_paths, monkeypatch):
    monkeypatch.setattr(model_manager_module, "MAX_MODEL_SIZE", 1000)
    huge = {"file": ("voice.onnx", b"x" * (3 * 1024 * 1024), "application/octet-stream")}

    response = client.post("/api/models/upload", files=huge)

    assert response.status_code == 413
    assert list((app_paths / "models").iterdir()) == []


def test_uploads_within_their_route_limits_are_not_capped(client):
    model = {"file": ("voice.onnx", b"x" * (3 * 1024 * 1024), "application/octet-stream")}
    wav = {"file": ("long.wav", audio_bytes(voice(40 * SR)), "audio/wav")}  # ~3.8 MB

    assert client.post("/api/models/upload", files=model).status_code == 200
    assert client.post("/api/convert/", files=wav, data={"use_model": "false"}).status_code == 200
