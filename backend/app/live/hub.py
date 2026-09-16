"""Browsers watching CAPTURE-Screen's live spectrum.

The device's own connection belongs to app.hardware's DeviceHub; this hub
only subscribes to it. It hears when the device's presence changes and when
a live frame arrives, fans both out to the browsers on WS /api/live/spectrum,
and tells the device to start or stop streaming as the first browser starts
watching and the last one stops.

Everything is in memory, so this assumes one backend process, like DeviceHub.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from pydantic import ValidationError

from app.hardware.hub import DeviceHub, DeviceOffline
from app.live.models import LiveFrame

VIEWER_OUTBOX_SIZE = 8


class Viewer:
    """One browser on WS /spectrum. The hub fills its outbox; the route drains it."""

    def __init__(self) -> None:
        self.outbox: asyncio.Queue[str] = asyncio.Queue(maxsize=VIEWER_OUTBOX_SIZE)
        self.watching = False

    def post(self, text: str) -> None:
        # A slow browser loses its oldest message instead of holding up the device.
        if self.outbox.full():
            self.outbox.get_nowait()
        self.outbox.put_nowait(text)


class LiveHub:
    def __init__(self, device: DeviceHub) -> None:
        self.device = device
        device.subscribe(self)
        self.reset()

    def reset(self) -> None:
        self._viewers: set[Viewer] = set()

    def presence(self) -> dict[str, Any]:
        last_seen = self.device.last_seen
        return {
            "mode": "presence",
            "online": self.device.online,
            "last_seen": last_seen.isoformat() if last_seen else None,
            "device": self.device.status,
        }

    # ---- what DeviceHub tells us ---------------------------------------

    def on_device_changed(self) -> None:
        self._broadcast(json.dumps(self.presence()))

    def on_live(self, message: dict[str, Any]) -> None:
        try:
            text = LiveFrame.model_validate(message).model_dump_json()
        except ValidationError:
            return
        self._broadcast(text, watchers_only=True)

    async def on_device_attached(self) -> None:
        # A device that (re)connects while someone is already watching must start streaming.
        if self._watched():
            with contextlib.suppress(DeviceOffline):
                await self.device.command({"cmd": "live_start"})

    # ---- browsers ------------------------------------------------------

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
        if now_watched == was_watched or not self.device.connected:
            return
        with contextlib.suppress(DeviceOffline):
            await self.device.command({"cmd": "live_start" if now_watched else "live_stop"})

    def _broadcast(self, text: str, watchers_only: bool = False) -> None:
        for viewer in self._viewers:
            if viewer.watching or not watchers_only:
                viewer.post(text)
