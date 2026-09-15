"""HTTP and WebSocket routes for CAPTURE-Screen. hub.py explains how they connect."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.config import settings
from app.hardware.hub import DeviceBusy, DeviceError, DeviceHub, DeviceOffline, DeviceTimeout
from app.hardware.models import DeviceMeasurement, HardwareStatusResponse

router = APIRouter(prefix="/api/hardware", tags=["hardware"])

device_hub = DeviceHub(
    online_timeout_s=settings.HARDWARE_ONLINE_TIMEOUT_SECONDS,
    read_timeout_s=settings.HARDWARE_READ_TIMEOUT_SECONDS,
)

# One coroutine both waits for browser commands and drains the viewer's outbox, checking the outbox this often.
VIEWER_POLL_SECONDS = 0.1
VIEWER_COMMANDS = {"live_start": True, "live_stop": False}


@router.get("/status", response_model=HardwareStatusResponse)
async def hardware_status() -> HardwareStatusResponse:
    """Whether CAPTURE-Screen is connected, and the last status it reported."""
    return HardwareStatusResponse(online=device_hub.online, last_seen=device_hub.last_seen, device=device_hub.status)


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


def _viewer_command(text: str) -> bool | None:
    try:
        message = json.loads(text)
    except json.JSONDecodeError:
        return None
    command = message.get("cmd") if isinstance(message, dict) else None
    return VIEWER_COMMANDS.get(command) if isinstance(command, str) else None


@router.websocket("/live")
async def hardware_live(websocket: WebSocket) -> None:
    """Browser side of the live spectrum.

    Server -> browser: {"mode": "presence", ...} on connect and whenever the
    device reports; {"mode": "live", ...} frames while watching;
    {"mode": "watching", "watching": bool} after each command.
    Browser -> server: {"cmd": "live_start"} / {"cmd": "live_stop"}.
    """
    # CORSMiddleware covers HTTP only; without this check any website could switch the LED on.
    origin = websocket.headers.get("origin")
    if origin and "*" not in settings.CORS_ORIGINS and origin not in settings.CORS_ORIGINS:
        await websocket.close(code=1008, reason="Origin not allowed")
        return

    await websocket.accept()
    viewer = device_hub.add_viewer()
    try:
        while True:
            try:
                text = await asyncio.wait_for(websocket.receive_text(), timeout=VIEWER_POLL_SECONDS)
            except asyncio.TimeoutError:
                text = None

            if text is not None:
                watching = _viewer_command(text)
                if watching is None:
                    await websocket.send_json({"mode": "error", "error": "unknown_cmd"})
                else:
                    await device_hub.set_watching(viewer, watching)
                    await websocket.send_json({"mode": "watching", "watching": watching})

            while not viewer.outbox.empty():
                await websocket.send_text(viewer.outbox.get_nowait())
    except WebSocketDisconnect:
        pass
    finally:
        await device_hub.remove_viewer(viewer)


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
