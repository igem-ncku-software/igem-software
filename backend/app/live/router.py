"""WebSocket route for the live spectrum. hub.py explains how it reaches the device."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import settings
from app.hardware.router import device_hub
from app.live.hub import LiveHub

router = APIRouter(prefix="/api/live", tags=["live"])

live_hub = LiveHub(device_hub)

# One coroutine both waits for browser commands and drains the viewer's outbox, checking the outbox this often.
VIEWER_POLL_SECONDS = 0.1
VIEWER_COMMANDS = {"live_start": True, "live_stop": False}


def _viewer_command(text: str) -> bool | None:
    try:
        message = json.loads(text)
    except json.JSONDecodeError:
        return None
    command = message.get("cmd") if isinstance(message, dict) else None
    return VIEWER_COMMANDS.get(command) if isinstance(command, str) else None


@router.websocket("/spectrum")
async def live_spectrum(websocket: WebSocket) -> None:
    """Browser side of the live spectrum.

    Server -> browser: {"mode": "presence", ...} (GET /api/hardware/status's
    fields) on connect, whenever the device reports or disconnects, and when it
    goes quiet past the online timeout; {"mode": "live", ...} frames while watching;
    {"mode": "watching", "watching": bool} after each command.
    Browser -> server: {"cmd": "live_start"} / {"cmd": "live_stop"}.
    """
    # CORSMiddleware covers HTTP only; without this check any website could switch the LED on.
    origin = websocket.headers.get("origin")
    if origin and "*" not in settings.CORS_ORIGINS and origin not in settings.CORS_ORIGINS:
        await websocket.close(code=1008, reason="Origin not allowed")
        return

    await websocket.accept()
    viewer = live_hub.add_viewer()
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
                    await live_hub.set_watching(viewer, watching)
                    await websocket.send_json({"mode": "watching", "watching": watching})

            live_hub.check_presence()
            while not viewer.outbox.empty():
                await websocket.send_text(viewer.outbox.get_nowait())
    except WebSocketDisconnect:
        pass
    finally:
        await live_hub.remove_viewer(viewer)
