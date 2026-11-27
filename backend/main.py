import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.websockets import WebSocketClose

from backend.config import settings
from backend.routers import convert, models, presets, profiles, slots, websocket
from backend.services import model_manager
from backend.services.model_manager import ModelManager
from backend.services.preset_store import PresetStore
from backend.services.profile_store import LATENCY_MODES, ProfileStore
from backend.services.slot_manager import SlotManager

_onnx_available = False
_torch_available = False
_onnxruntime = None
_torch = None
try:
    import onnxruntime as _onnxruntime

    _onnx_available = True
except ImportError:
    pass
try:
    import torch as _torch

    _torch_available = True
except ImportError:
    pass

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def _get_onnx_runtime_info() -> dict:
    providers: list[str] = []
    if _onnx_available and _onnxruntime is not None:
        try:
            providers = list(_onnxruntime.get_available_providers())
        except Exception:
            logger.exception("Failed to inspect ONNX Runtime providers")

    active_provider = None
    selected_providers: list[str] = []
    gpu_enabled = False
    if "CUDAExecutionProvider" in providers:
        active_provider = "CUDAExecutionProvider"
        selected_providers = ["CUDAExecutionProvider"]
        if "CPUExecutionProvider" in providers:
            selected_providers.append("CPUExecutionProvider")
        gpu_enabled = True
    elif "CPUExecutionProvider" in providers:
        active_provider = "CPUExecutionProvider"
        selected_providers = ["CPUExecutionProvider"]
    elif providers:
        active_provider = providers[0]
        selected_providers = [providers[0]]

    return {
        "available": _onnx_available,
        "activeProvider": active_provider,
        "selectedProviders": selected_providers,
        "availableProviders": providers,
        "gpuEnabled": gpu_enabled,
    }


def _get_torch_runtime_info() -> dict:
    info = {
        "available": _torch_available,
        "device": "unavailable",
        "gpuName": None,
        "cudaAvailable": False,
        "cudaVersion": None,
    }

    if not _torch_available or _torch is None:
        return info

    try:
        if hasattr(_torch, "xpu") and _torch.xpu.is_available():
            info["device"] = "xpu:0"
            get_device_name = getattr(_torch.xpu, "get_device_name", None)
            info["gpuName"] = get_device_name(0) if callable(get_device_name) else "Intel XPU"
        elif _torch.cuda.is_available():
            info["device"] = "cuda:0"
            info["gpuName"] = _torch.cuda.get_device_name(0)
            info["cudaAvailable"] = True
            info["cudaVersion"] = _torch.version.cuda
        elif hasattr(_torch.backends, "mps") and _torch.backends.mps.is_available():
            info["device"] = "mps"
            info["gpuName"] = "Apple GPU"
        else:
            info["device"] = "cpu"
            info["gpuName"] = "CPU only"
    except Exception:
        logger.exception("Failed to inspect PyTorch runtime")

    return info


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Shiftbooth backend")
    logger.info("Models directory: %s", settings.MODELS_DIR)
    logger.info("ONNX Runtime: %s", "available" if _onnx_available else "missing")
    logger.info("PyTorch: %s", "available" if _torch_available else "missing")

    manager = ModelManager(settings.MODELS_DIR)
    app.state.model_manager = manager
    app.state.preset_store = PresetStore(settings.PRESETS_PATH)
    app.state.slot_manager = SlotManager(settings.SLOTS_PATH, manager)
    app.state.profile_store = ProfileStore(settings.PROFILES_PATH)

    # No address here: under the uvicorn CLI the bound host/port are uvicorn's,
    # not settings.HOST/PORT, and uvicorn logs the real one itself.
    logger.info("Ready")
    yield

    logger.info("Shutting down")
    manager.deactivate_model()


app = FastAPI(
    title="Shiftbooth",
    description="Realtime AI voice changer — RVC/ONNX + DSP rack",
    version="3.0.0",
    lifespan=lifespan,
)

LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}
MAX_JSON_BODY = 1024 * 1024  # settings payloads are a few kB
FORM_OVERHEAD = 1024 * 1024  # multipart boundaries and the small form fields


def _origin_allowed(origin: str, host: str) -> bool:
    """True when a browser request from `origin` may use this server."""
    if "*" in settings.CORS_ORIGINS or origin in settings.CORS_ORIGINS:
        return True
    try:
        parts = urlsplit(origin)
        hostname = parts.hostname
    except ValueError:
        return False
    if not parts.netloc or "@" in parts.netloc:
        return False  # "null", junk, or credentials no browser puts in an Origin
    # Served by this very server (same host:port), or by something running on
    # this machine such as the Vite dev server that proxies to us.
    return parts.netloc.lower() == host.lower() or hostname in LOCAL_HOSTNAMES


def _body_limit(path: str) -> int:
    """Largest request body a path accepts; read per request so limits stay in one place."""
    if path == "/api/models/upload":
        return model_manager.MAX_MODEL_SIZE + FORM_OVERHEAD
    if path.rstrip("/") == "/api/convert":
        return convert.MAX_UPLOAD_BYTES + FORM_OVERHEAD
    return MAX_JSON_BODY


class RequestGuard:
    """Front-door checks applied to every HTTP request and WebSocket handshake.

    * Requests from other sites are refused. The API has no login, so a web
      page the user merely has open must not be able to drive it (upload and
      load a model file, delete models, open the audio socket). Browsers label
      such requests with an Origin header; requests without one (curl, scripts,
      ordinary page loads) are not affected.
    * Request bodies are capped — by declared length and by bytes actually
      received — so the size limits hold before anything is buffered to disk
      or memory.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        origin = headers.get("origin")
        if origin is not None and not _origin_allowed(origin, headers.get("host", "")):
            logger.warning(
                "Refused cross-site %s request from origin %r "
                "(list it in SHIFTBOOTH_CORS_ORIGINS if it is yours)",
                scope["type"],
                origin,
            )
            if scope["type"] == "websocket":
                refusal = WebSocketClose(code=1008, reason="Cross-site connection refused")
            else:
                refusal = JSONResponse({"detail": "Cross-site request refused"}, status_code=403)
            await refusal(scope, receive, send)
            return

        if scope["type"] == "http":
            limit = _body_limit(scope["path"])
            declared = headers.get("content-length", "")
            if declared.isdigit() and int(declared) > limit:
                too_large = JSONResponse({"detail": "Request body too large"}, status_code=413)
                await too_large(scope, receive, send)
                return

            received = 0

            async def capped_receive():
                # Counts what actually arrives: a chunked body declares no length.
                nonlocal received
                message = await receive()
                if message["type"] == "http.request":
                    received += len(message.get("body", b""))
                    if received > limit:
                        raise HTTPException(status_code=413, detail="Request body too large")
                return message

            await self.app(scope, capped_receive, send)
            return

        await self.app(scope, receive, send)


# No allow_credentials: nothing here uses cookies, and combined with a wildcard
# origin it would let any site make credentialed calls.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestGuard)  # added last = outermost: runs before CORS


@app.get("/health")
async def health_check():
    return {"status": "ok", "product": "shiftbooth"}


@app.get("/api/config")
async def get_config():
    mode = LATENCY_MODES.get(settings.DEFAULT_LATENCY_MODE, LATENCY_MODES["balanced"])
    return {
        "version": app.version,
        "product": "shiftbooth",
        "sample_rate": settings.SAMPLE_RATE,
        "chunk_size": settings.CHUNK_SIZE,
        "latency_mode": mode,
        "latency_modes": list(LATENCY_MODES.values()),
        "features": {
            "model_slots": True,
            "profiles": True,
            "dsp_passthrough": True,
            "vad_gate": True,
            "offline_convert": True,
            "sola_crossfade": True,
            "virtual_cable_guide": True,
        },
        "onnx_available": _onnx_available,
        "torch_available": _torch_available,
        "runtime": {
            "onnx": _get_onnx_runtime_info(),
            "torch": _get_torch_runtime_info(),
        },
    }


app.include_router(models.router)
app.include_router(presets.router)
app.include_router(convert.router)
app.include_router(websocket.router)
app.include_router(slots.router)
app.include_router(profiles.router)

frontend_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="frontend")
    logger.info("Serving frontend from %s", frontend_dist)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=settings.HOST,
        port=settings.PORT,
        log_level=settings.LOG_LEVEL.lower(),
        reload=False,
    )
