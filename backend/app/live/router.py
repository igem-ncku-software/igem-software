"""WebSocket route for the live spectrum. hub.py explains how it reaches the device."""

from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import settings
from app.hardware.hub import DeviceOffline
from app.hardware.router import device_hub
from app.live.hub import LiveHub

router = APIRouter(prefix="/api/live", tags=["live"])

live_hub = LiveHub(device_hub)

# One coroutine both waits for browser commands and drains the viewer's outbox, checking the outbox this often.
VIEWER_POLL_SECONDS = 0.1
# Each command a browser may send: which switch it flips, and to what.
VIEWER_COMMANDS = {
    "live_start": ("live", True),
    "live_stop": ("live", False),
    "led_on": ("led", True),
    "led_off": ("led", False),
}


def _origin_allowed(origin: str | None) -> bool:
    """Browsers always send Origin, so a request without one is not one: only "*" admits it."""
    if "*" in settings.CORS_ORIGINS:
        return True
    return origin is not None and origin in settings.CORS_ORIGINS


def _viewer_command(text: str) -> tuple[str, bool] | None:
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
    fields, including the device's live_on) on connect, whenever the device reports
    or disconnects, at least every LiveHub.PRESENCE_HEARTBEAT_SECONDS as a keepalive,
    and when the device goes quiet past the online timeout; {"mode": "live", ...}
    every frame the device streams; {"mode": "error", "error": "unknown_cmd" |
    "device_offline" | "origin_not_allowed"} for a command this doesn't know, a
    command with no device to take it, and a browser this won't serve.
    Browser -> server: {"cmd": "live_start" | "live_stop" | "led_on" | "led_off"},
    relayed to the device as is. There is no ack: the device's next status (live_on,
    led_on) is the answer.
    """
    await websocket.accept()
    # CORSMiddleware covers HTTP only; without this check any website could switch the LED on.
    # Rejected after accepting rather than before: a handshake refused outright reaches the
    # browser as a bare connection failure, indistinguishable from a sleeping backend, and
    # device_live.js would retry forever without ever being able to say why.
    if not _origin_allowed(websocket.headers.get("origin")):
        # Same guard as the loop below: a client that vanishes mid-rejection isn't an error.
        with contextlib.suppress(WebSocketDisconnect, RuntimeError):
            await websocket.send_json({"mode": "error", "error": "origin_not_allowed"})
            await websocket.close(code=1008, reason="Origin not allowed")
        return

    viewer = live_hub.add_viewer()
    try:
        while True:
            try:
                text = await asyncio.wait_for(websocket.receive_text(), timeout=VIEWER_POLL_SECONDS)
            except asyncio.TimeoutError:
                text = None

            if text is not None:
                command = _viewer_command(text)
                if command is None:
                    await websocket.send_json({"mode": "error", "error": "unknown_cmd"})
                else:
                    switch, on = command
                    try:
                        await (live_hub.set_live(on) if switch == "live" else live_hub.set_led(on))
                    except DeviceOffline:
                        await websocket.send_json({"mode": "error", "error": "device_offline"})

            live_hub.check_presence()
            while viewer.outbox:
                await websocket.send_text(viewer.outbox.popleft()[1])
    # RuntimeError is what starlette raises for a send on a socket that closed since the
    # last receive; letting it escape would put a traceback in the log for a browser
    # that simply went away.
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        live_hub.remove_viewer(viewer)
