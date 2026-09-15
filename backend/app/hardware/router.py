"""FastAPI routes for CAPTURE-Screen status and live spectra."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, WebSocket
from pydantic import ValidationError

from app.config import settings
from app.hardware.live import mock_device_status, run_device_session, run_mock_session
from app.hardware.models import DeviceStatus, HardwareStatusResponse


router = APIRouter(prefix="/api/hardware", tags=["hardware"])


@router.get("/status", response_model=HardwareStatusResponse)
async def hardware_status() -> HardwareStatusResponse:
    """Report whether the configured live source is ready."""
    if settings.HARDWARE_MODE == "mock":
        return HardwareStatusResponse(
            online=True,
            source="mock",
            device=DeviceStatus(**mock_device_status()),
        )

    url = f"{settings.HARDWARE_DEVICE_BASE_URL.rstrip('/')}/status"
    try:
        async with httpx.AsyncClient(timeout=settings.HARDWARE_HTTP_TIMEOUT_SECONDS) as client:
            response = await client.get(url)
            response.raise_for_status()
            device = DeviceStatus(**response.json())
    except (httpx.HTTPError, ValueError, ValidationError) as error:
        raise HTTPException(status_code=503, detail="CAPTURE-Screen device is unavailable.") from error

    return HardwareStatusResponse(online=True, source="device", device=device)


@router.websocket("/live")
async def hardware_live(websocket: WebSocket) -> None:
    """Stream firmware-shaped AS7341 frames after ``live_start``."""
    # CORSMiddleware covers HTTP only.  Check WebSocket Origin explicitly so
    # an arbitrary website cannot make a device-mode backend turn on the LED.
    origin = websocket.headers.get("origin")
    if origin and "*" not in settings.CORS_ORIGINS and origin not in settings.CORS_ORIGINS:
        await websocket.close(code=1008, reason="Origin not allowed")
        return
    await websocket.accept()
    if settings.HARDWARE_MODE == "mock":
        await run_mock_session(websocket, settings.HARDWARE_LIVE_INTERVAL_MS / 1000)
        return
    await run_device_session(websocket, settings.HARDWARE_DEVICE_BASE_URL)
