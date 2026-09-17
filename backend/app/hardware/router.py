"""HTTP and WebSocket routes for CAPTURE-Screen. hub.py explains how they connect.

The browser side of the live spectrum is app.live.router, which shares device_hub.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, WebSocket

from app.config import settings
from app.hardware.hub import DeviceBusy, DeviceError, DeviceHub, DeviceOffline, DeviceTimeout
from app.hardware.models import DeviceMeasurement, HardwareStatusResponse

router = APIRouter(prefix="/api/hardware", tags=["hardware"])

device_hub = DeviceHub(
    online_timeout_s=settings.HARDWARE_ONLINE_TIMEOUT_SECONDS,
    read_timeout_s=settings.HARDWARE_READ_TIMEOUT_SECONDS,
)


@router.get("/status", response_model=HardwareStatusResponse)
async def hardware_status() -> HardwareStatusResponse:
    """Whether CAPTURE-Screen is connected, and the last status it reported."""
    return device_hub.snapshot()


@router.post("/read", response_model=DeviceMeasurement, response_model_exclude_none=True)
async def hardware_read() -> dict:
    """Run one dark/light/dark measurement and return the device's raw frames."""
    try:
        return await device_hub.read()
    except DeviceOffline as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except DeviceBusy as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except DeviceTimeout as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except DeviceError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.websocket("/device")
async def hardware_device(websocket: WebSocket) -> None:
    """The ESP32's own outbound connection (firmware/as7341/as7341.ino).

    Device -> server: status, live frames, measurements, errors.
    Server -> device: {"cmd": "live_start"}, {"cmd": "live_stop"},
    {"cmd": "read", "request_id": "..."}.

    No authentication yet: anyone who can reach this URL can pose as the device.
    """
    # arduinoWebSockets requests the "arduino" subprotocol by default; echo it so the handshake can't be refused.
    subprotocol = "arduino" if "arduino" in websocket.scope.get("subprotocols", []) else None
    await websocket.accept(subprotocol=subprotocol)
    await device_hub.attach_device(websocket)
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            text = message.get("text")
            if text is None and message.get("bytes") is not None:
                text = message["bytes"].decode("utf-8", errors="replace")
            if text is not None:
                await device_hub.handle_device_message(websocket, text)
    finally:
        await device_hub.detach_device(websocket)
