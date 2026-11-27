import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/slots", tags=["slots"])


def _get_slots(request: Request):
    mgr = getattr(request.app.state, "slot_manager", None)
    if mgr is None:
        raise HTTPException(status_code=503, detail="Slot manager not initialized")
    return mgr


class BindBody(BaseModel):
    name: str | None = None
    label: str | None = Field(default=None, max_length=48)


# Plain `def` throughout: FastAPI runs these on a worker thread. Binding writes
# a file, listing waits for a bind in progress, and activating loads a model
# for seconds; none of that may stall the event loop that is streaming audio.


@router.get("/")
def list_slots(request: Request) -> list[dict]:
    return _get_slots(request).list_slots()


@router.put("/{index}")
def bind_slot(request: Request, index: int, body: BindBody) -> dict:
    try:
        return _get_slots(request).bind(index, body.name, body.label)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{index}/activate")
def activate_slot(request: Request, index: int) -> dict:
    try:
        return _get_slots(request).activate(index)
    except ValueError as exc:  # slot index out of range
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Slot activate failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
