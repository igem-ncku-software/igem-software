"""Live data sources for CAPTURE-Screen.

The browser always connects to the FastAPI WebSocket.  In ``mock`` mode this
module generates firmware-shaped frames, while ``device`` mode relays the
ESP32's WebSocket without changing its messages.
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect


CHANNELS = ("F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "CLR", "NIR")
ALLOWED_COMMANDS = {"live_start", "live_stop"}


def mock_device_status() -> dict[str, Any]:
    """Return the same status shape as firmware/as7341 GET /status."""
    return {
        "device_id": "capture-screen-backend-mock",
        "build_id": "P1-PROTO-01",
        "firmware_version": "0.2.0-backend-mock",
        "state": "IDLE",
        "uptime_ms": int(time.monotonic() * 1000),
        "wifi_rssi": -55,
        "config": {
            "led_current_mA": 5.553,
            "gain": 16,
            "atime": 29,
            "astep": 599,
        },
    }


class MockLiveFrames:
    """Generate realistic-looking raw spectra using the firmware contract."""

    def __init__(self, seed: int | None = None) -> None:
        self._random = random.Random(seed)
        self._started_at = time.monotonic()
        self._seq = 0

    def next(self) -> dict[str, Any]:
        self._seq += 1
        elapsed = time.monotonic() - self._started_at
        # A slowly changing signal makes it obvious that the UI is live.  The
        # channel proportions mirror the frontend device mock and stay within
        # the AS7341 integration range used by the firmware.
        signal = 1450 + 850 * math.sin(elapsed / 3.5)
        scatter = 600 + 35 * math.sin(elapsed / 2.1)
        noise = lambda scale: self._random.gauss(0, scale)
        raw = {
            "F1": round(max(0, 14 + noise(3))),
            "F2": round(max(0, 22 + noise(4))),
            "F3": round(max(0, scatter + noise(12))),
            "F4": round(max(0, signal + 20 + noise(18))),
            "F5": round(max(0, signal * 0.6 + 16 + noise(14))),
            "F6": round(max(0, 18 + noise(4))),
            "F7": round(max(0, 12 + noise(3))),
            "F8": round(max(0, 9 + noise(3))),
            "CLR": round(max(0, 30 + signal * 0.08 + noise(5))),
            "NIR": round(max(0, 7 + noise(2))),
        }
        return {
            "mode": "live",
            "seq": self._seq,
            "t_ms": int(elapsed * 1000),
            "raw": raw,
        }


def parse_command(text: str) -> str | None:
    """Return a supported command, or ``None`` for malformed input."""
    try:
        message = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(message, dict) or message.get("cmd") not in ALLOWED_COMMANDS:
        return None
    return str(message["cmd"])


async def run_mock_session(websocket: WebSocket, interval_seconds: float) -> None:
    """Serve one browser using the same start/stop protocol as the ESP32."""
    frames = MockLiveFrames()
    streaming = False
    await websocket.send_json({"mode": "state", "state": "IDLE"})

    while True:
        try:
            if not streaming:
                command = parse_command(await websocket.receive_text())
                if command == "live_start":
                    streaming = True
                    await websocket.send_json({"mode": "state", "state": "LIVE"})
                elif command == "live_stop":
                    await websocket.send_json({"mode": "state", "state": "IDLE"})
                else:
                    await websocket.send_json({"error": "unknown_cmd"})
                continue

            try:
                text = await asyncio.wait_for(websocket.receive_text(), timeout=interval_seconds)
            except TimeoutError:
                await websocket.send_json(frames.next())
                continue

            command = parse_command(text)
            if command == "live_stop":
                streaming = False
                await websocket.send_json({"mode": "state", "state": "IDLE"})
            elif command == "live_start":
                await websocket.send_json({"mode": "state", "state": "LIVE"})
            else:
                await websocket.send_json({"error": "unknown_cmd"})
        except WebSocketDisconnect:
            return


async def _browser_to_device(websocket: WebSocket, upstream: Any) -> None:
    while True:
        text = await websocket.receive_text()
        command = parse_command(text)
        if command is None:
            await websocket.send_json({"error": "unknown_cmd"})
            continue
        await upstream.send(json.dumps({"cmd": command}))


async def _device_to_browser(websocket: WebSocket, upstream: AsyncIterator[Any]) -> None:
    async for message in upstream:
        if isinstance(message, bytes):
            message = message.decode("utf-8")
        # Reject non-JSON upstream messages instead of forwarding untrusted
        # device text into the browser protocol.
        try:
            json.loads(message)
        except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
            await websocket.send_json({"error": "unexpected_device_response"})
            continue
        await websocket.send_text(message)


async def run_device_session(websocket: WebSocket, device_base_url: str) -> None:
    """Relay messages between one browser and the ESP32 WebSocket."""
    # Import lazily so mock mode still starts if an installation intentionally
    # omits device support.
    import websockets

    upstream_url = f"{device_base_url.rstrip('/').replace('http://', 'ws://', 1).replace('https://', 'wss://', 1)}/live"
    try:
        async with websockets.connect(
            upstream_url,
            open_timeout=8,
            close_timeout=3,
            max_size=64 * 1024,
        ) as upstream:
            browser_task = asyncio.create_task(_browser_to_device(websocket, upstream))
            device_task = asyncio.create_task(_device_to_browser(websocket, upstream))
            done, pending = await asyncio.wait(
                {browser_task, device_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                task.result()
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await websocket.send_json({"error": "device_unreachable"})
            await websocket.close(code=1013, reason="Device unavailable")
        except Exception:
            pass
