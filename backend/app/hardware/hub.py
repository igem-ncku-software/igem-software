"""The relay between the one CAPTURE-Screen device and every browser.

The ESP32 dials out to WS /api/hardware/device and keeps that connection
open, because the backend (on Render) cannot dial into a device behind a
home or lab router. Browsers never reach the device directly: they read
status and request measurements over HTTP and watch the live spectrum over
WS /api/hardware/live, and this hub carries both directions.

Everything is in memory, so this assumes one backend process (true on
Render's free tier). Nothing the device sends is kept except its latest status.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Protocol

from pydantic import ValidationError

from app.hardware.models import DeviceMeasurement, DeviceStatus, LiveFrame

VIEWER_OUTBOX_SIZE = 8


class Connection(Protocol):
    async def send_text(self, data: str) -> None: ...

    async def close(self, code: int = 1000) -> None: ...


class DeviceOffline(Exception):
    pass


class DeviceBusy(Exception):
    pass


class DeviceTimeout(Exception):
    pass


class DeviceError(Exception):
    pass


class Viewer:
    """One browser on WS /live. The hub fills its outbox; the route drains it."""

    def __init__(self) -> None:
        self.outbox: asyncio.Queue[str] = asyncio.Queue(maxsize=VIEWER_OUTBOX_SIZE)
        self.watching = False

    def post(self, text: str) -> None:
        # A slow browser loses its oldest message instead of holding up the device.
        if self.outbox.full():
            self.outbox.get_nowait()
        self.outbox.put_nowait(text)


class DeviceHub:
    def __init__(self, online_timeout_s: float, read_timeout_s: float) -> None:
        self.online_timeout_s = online_timeout_s
        self.read_timeout_s = read_timeout_s
        self.reset()

    def reset(self) -> None:
        self._device: Connection | None = None
        self._status: dict[str, Any] | None = None
        self._last_seen: datetime | None = None
        self._last_seen_monotonic = 0.0
        self._viewers: set[Viewer] = set()
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._read_lock = asyncio.Lock()

    # ---- what GET /status reports --------------------------------------

    @property
    def online(self) -> bool:
        return (
            self._device is not None
            and self._status is not None
            and time.monotonic() - self._last_seen_monotonic < self.online_timeout_s
        )

    @property
    def status(self) -> dict[str, Any] | None:
        return self._status

    @property
    def last_seen(self) -> datetime | None:
        return self._last_seen

    def presence(self) -> dict[str, Any]:
        return {
            "mode": "presence",
            "online": self.online,
            "last_seen": self._last_seen.isoformat() if self._last_seen else None,
            "device": self._status,
        }

    # ---- the device's connection ---------------------------------------

    async def attach_device(self, conn: Connection) -> None:
        previous, self._device = self._device, conn
        # A new session: don't vouch for it until it reports its own status.
        self._status = None
        self._fail_pending(DeviceOffline("CAPTURE-Screen reconnected before answering."))
        if previous is not None:
            with contextlib.suppress(Exception):
                await previous.close(code=4000)
        if self._watched():
            with contextlib.suppress(DeviceOffline):
                await self._command({"cmd": "live_start"})

    async def detach_device(self, conn: Connection) -> None:
        if conn is not self._device:
            return
        self._device = None
        self._fail_pending(DeviceOffline("CAPTURE-Screen disconnected during the read."))
        self._broadcast(json.dumps(self.presence()))

    async def handle_device_message(self, conn: Connection, text: str) -> None:
        if conn is not self._device:
            return
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            return
        if not isinstance(message, dict):
            return

        # Whole seconds: browsers parse "…T12:00:00Z" everywhere, six fractional digits only by convention.
        self._last_seen = datetime.now(timezone.utc).replace(microsecond=0)
        self._last_seen_monotonic = time.monotonic()

        mode = message.get("mode")
        if mode == "status":
            self._on_status(message)
        elif mode == "live":
            self._on_live(message)
        elif mode == "measurement":
            self._on_measurement(message)
        elif mode == "error":
            self._on_error(message)

    def _on_status(self, message: dict[str, Any]) -> None:
        try:
            self._status = DeviceStatus.model_validate(message).model_dump(mode="json")
        except ValidationError:
            return
        self._broadcast(json.dumps(self.presence()))

    def _on_live(self, message: dict[str, Any]) -> None:
        try:
            text = LiveFrame.model_validate(message).model_dump_json()
        except ValidationError:
            return
        self._broadcast(text, watchers_only=True)

    def _on_measurement(self, message: dict[str, Any]) -> None:
        future = self._pending.get(str(message.get("request_id")))
        if future is None or future.done():
            return
        try:
            future.set_result(DeviceMeasurement.model_validate(message).model_dump(mode="json", exclude_none=True))
        except ValidationError:
            future.set_exception(DeviceError("CAPTURE-Screen sent a malformed measurement."))

    def _on_error(self, message: dict[str, Any]) -> None:
        future = self._pending.get(str(message.get("request_id")))
        if future is None or future.done():
            return
        if message.get("error") == "busy":
            future.set_exception(DeviceBusy("CAPTURE-Screen is busy, try again."))
        else:
            future.set_exception(DeviceError(f"CAPTURE-Screen rejected the read: {str(message.get('error'))[:80]}"))

    def _fail_pending(self, error: Exception) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)

    async def _command(self, command: dict[str, Any]) -> None:
        device = self._device
        if device is None:
            raise DeviceOffline("CAPTURE-Screen is offline.")
        try:
            await device.send_text(json.dumps(command))
        except Exception as error:
            await self.detach_device(device)
            raise DeviceOffline("CAPTURE-Screen is offline.") from error

    # ---- measurements (POST /read) -------------------------------------

    async def read(self) -> dict[str, Any]:
        """Run one dark/light/dark measurement on the device and wait for its frames."""
        async with self._read_lock:
            if not self.online:
                raise DeviceOffline("CAPTURE-Screen is offline.")
            request_id = uuid.uuid4().hex
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self._pending[request_id] = future
            try:
                await self._command({"cmd": "read", "request_id": request_id})
                return await asyncio.wait_for(future, self.read_timeout_s)
            except asyncio.TimeoutError:
                raise DeviceTimeout("CAPTURE-Screen did not answer in time.") from None
            finally:
                self._pending.pop(request_id, None)
                if future.done() and not future.cancelled():
                    future.exception()  # mark it retrieved when _command failed after the future was already failed

    # ---- browsers on WS /live ------------------------------------------

    def add_viewer(self) -> Viewer:
        viewer = Viewer()
        self._viewers.add(viewer)
        viewer.post(json.dumps(self.presence()))
        return viewer

    async def set_watching(self, viewer: Viewer, watching: bool) -> None:
        was_watched = self._watched()
        viewer.watching = watching
        await self._sync_live(was_watched)

    async def remove_viewer(self, viewer: Viewer) -> None:
        was_watched = self._watched()
        self._viewers.discard(viewer)
        await self._sync_live(was_watched)

    def _watched(self) -> bool:
        return any(viewer.watching for viewer in self._viewers)

    async def _sync_live(self, was_watched: bool) -> None:
        # The LED is on only while someone is watching: it heats and bleaches the sample in the cuvette.
        now_watched = self._watched()
        if now_watched == was_watched or self._device is None:
            return
        with contextlib.suppress(DeviceOffline):
            await self._command({"cmd": "live_start" if now_watched else "live_stop"})

    def _broadcast(self, text: str, watchers_only: bool = False) -> None:
        for viewer in self._viewers:
            if viewer.watching or not watchers_only:
                viewer.post(text)
