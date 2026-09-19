"""Browsers watching CAPTURE-Screen's live spectrum.

The device's own connection belongs to app.hardware's DeviceHub; this hub
only subscribes to it. It hears when the device's presence changes and when
a live frame arrives, fans both out to the browsers on WS /api/live/spectrum,
and tells the device to start or stop streaming as the first browser starts
watching and the last one stops.

Everything is in memory, so this assumes one backend process, like DeviceHub.
"""

from __future__ import annotations

import contextlib
import json
import time
from collections import deque
from typing import Any

from pydantic import ValidationError

from app.hardware.hub import DeviceHub, DeviceOffline
from app.live.models import LiveFrame

VIEWER_OUTBOX_SIZE = 8
# Presence is the only thing a browser hears while no device is attached, so it doubles as
# the keepalive that proves the socket (and every proxy on the way) is still there. Shorter
# than device_live.js's staleness timeout, so one missed beat isn't enough to trip it.
PRESENCE_HEARTBEAT_SECONDS = 10.0


class Viewer:
    """One browser on WS /spectrum. The hub fills its outbox; the route drains it in order.

    A deque rather than a Queue: the route polls the outbox on its own tick and never
    awaits on it.
    """

    def __init__(self) -> None:
        self.outbox: deque[tuple[bool, str]] = deque()  # (is a live frame, text)
        self.watching = False

    def post_presence(self, text: str) -> None:
        self._post(False, text)

    def post_frame(self, text: str) -> None:
        self._post(True, text)

    def _post(self, is_frame: bool, text: str) -> None:
        """Queue one message; a browser that falls behind loses its oldest live frame.

        Presence is never dropped for a frame: check_presence() only resends while the
        online flag still disagrees, so a lost presence message would leave that one
        browser showing a device state nothing ever corrects. Order is kept either way,
        so an offline presence can't overtake the frames that came before it.
        """
        if len(self.outbox) >= VIEWER_OUTBOX_SIZE and not self._drop_oldest_frame():
            if is_frame:
                return  # nothing droppable left, and a frame is the disposable one
            self.outbox.popleft()
        self.outbox.append((is_frame, text))

    def _drop_oldest_frame(self) -> bool:
        for index, (is_frame, _) in enumerate(self.outbox):
            if is_frame:
                del self.outbox[index]
                return True
        return False


class LiveHub:
    def __init__(self, device: DeviceHub) -> None:
        self.device = device
        device.subscribe(self)
        self.reset()

    def reset(self) -> None:
        self._viewers: set[Viewer] = set()
        self._told_online = False
        self._told_at = time.monotonic()

    def presence(self) -> dict[str, Any]:
        return {"mode": "presence", **self.device.snapshot().model_dump(mode="json")}

    def check_presence(self) -> None:
        """Broadcast presence if it changed unannounced, and at least every heartbeat.

        A device that just goes quiet (Wi-Fi lost, no socket close) turns
        DeviceHub.online false after HARDWARE_ONLINE_TIMEOUT_SECONDS without
        telling anyone, so WS /spectrum calls this on every poll tick. The same
        call carries the keepalive: a device reporting every 5 s is its own
        heartbeat, but with none attached this is all a browser ever hears.
        """
        if (
            self.device.online != self._told_online
            or time.monotonic() - self._told_at >= PRESENCE_HEARTBEAT_SECONDS
        ):
            self._broadcast_presence()

    # ---- what DeviceHub tells us ---------------------------------------

    def on_device_changed(self) -> None:
        self._broadcast_presence()

    def on_live(self, message: dict[str, Any]) -> None:
        try:
            text = LiveFrame.model_validate(message).model_dump_json()
        except ValidationError:
            return
        for viewer in self._viewers:
            if viewer.watching:
                viewer.post_frame(text)

    async def on_device_attached(self) -> None:
        # A device that (re)connects while someone is already watching must start streaming.
        if self._watched():
            with contextlib.suppress(DeviceOffline):
                await self.device.command({"cmd": "live_start"})

    # ---- browsers ------------------------------------------------------

    def add_viewer(self) -> Viewer:
        viewer = Viewer()
        self._viewers.add(viewer)
        viewer.post_presence(json.dumps(self.presence()))
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

    def _broadcast_presence(self) -> None:
        presence = self.presence()
        self._told_online = presence["online"]
        self._told_at = time.monotonic()
        text = json.dumps(presence)
        for viewer in self._viewers:
            viewer.post_presence(text)
