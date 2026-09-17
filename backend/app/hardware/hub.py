"""The relay between the one CAPTURE-Screen device and every browser.

The ESP32 dials out to WS /api/hardware/device and keeps that connection
open, because the backend (on Render) cannot dial into a device behind a
home or lab router. Browsers never reach the device directly: they read
status and request measurements over HTTP, and this hub carries both
directions. The live spectrum is its own feature (app.live), which subscribes
to this hub as a DeviceListener instead of reaching into the device socket.

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

from app.hardware.models import DeviceMeasurement, DeviceStatus, HardwareStatusResponse


class Connection(Protocol):
    async def send_text(self, data: str) -> None: ...

    async def close(self, code: int = 1000) -> None: ...


class DeviceListener(Protocol):
    """Another feature that follows the device (app.live.hub.LiveHub)."""

    def on_device_changed(self) -> None:
        """Presence changed: the device reported its status or disconnected."""

    def on_live(self, message: dict[str, Any]) -> None:
        """The device sent a mode "live" frame, not yet validated."""

    async def on_device_attached(self) -> None:
        """A new device connection was attached."""


class DeviceOffline(Exception):
    pass


class DeviceBusy(Exception):
    pass


class DeviceTimeout(Exception):
    pass


class DeviceError(Exception):
    pass


class DeviceHub:
    def __init__(self, online_timeout_s: float, read_timeout_s: float) -> None:
        self.online_timeout_s = online_timeout_s
        self.read_timeout_s = read_timeout_s
        # Subscribed once at import time, so reset() leaves them in place.
        self._listeners: list[DeviceListener] = []
        self.reset()

    def subscribe(self, listener: DeviceListener) -> None:
        self._listeners.append(listener)

    def reset(self) -> None:
        self._device: Connection | None = None
        self._status: dict[str, Any] | None = None
        self._last_seen: datetime | None = None
        self._last_seen_monotonic = 0.0
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

    @property
    def connected(self) -> bool:
        """A device socket is attached, whether or not it has reported yet."""
        return self._device is not None

    def snapshot(self) -> HardwareStatusResponse:
        """GET /status's body; app.live's presence messages carry the same fields."""
        return HardwareStatusResponse(online=self.online, last_seen=self.last_seen, device=self.status)

    # ---- the device's connection ---------------------------------------

    async def attach_device(self, conn: Connection) -> None:
        previous, self._device = self._device, conn
        # A new session: don't vouch for it until it reports its own status.
        self._status = None
        self._fail_pending(DeviceOffline("CAPTURE-Screen reconnected before answering."))
        if previous is not None:
            with contextlib.suppress(Exception):
                await previous.close(code=4000)
        for listener in self._listeners:
            await listener.on_device_attached()

    async def detach_device(self, conn: Connection) -> None:
        if conn is not self._device:
            return
        self._device = None
        self._fail_pending(DeviceOffline("CAPTURE-Screen disconnected during the read."))
        self._notify_changed()

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
            for listener in self._listeners:
                listener.on_live(message)
        elif mode == "measurement":
            self._on_measurement(message)
        elif mode == "error":
            self._on_error(message)

    def _on_status(self, message: dict[str, Any]) -> None:
        try:
            self._status = DeviceStatus.model_validate(message).model_dump(mode="json")
        except ValidationError:
            return
        self._notify_changed()

    def _notify_changed(self) -> None:
        for listener in self._listeners:
            listener.on_device_changed()

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

    async def command(self, command: dict[str, Any]) -> None:
        """Send one command down the device socket; DeviceOffline if there is none or it fails."""
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
                await self.command({"cmd": "read", "request_id": request_id})
                return await asyncio.wait_for(future, self.read_timeout_s)
            except asyncio.TimeoutError:
                raise DeviceTimeout("CAPTURE-Screen did not answer in time.") from None
            finally:
                self._pending.pop(request_id, None)
                if future.done() and not future.cancelled():
                    future.exception()  # mark it retrieved when _command failed after the future was already failed
