import asyncio
import json

import pytest

from app.hardware.hub import DeviceHub, DeviceOffline
from app.live import hub as live_hub_module
from app.live.hub import VIEWER_OUTBOX_SIZE, LiveHub
from tests.hardware.payloads import LIVE, STATUS


class FakeConnection:
    """Stands in for the device's WebSocket: records what the hub sends it."""

    def __init__(self):
        self.sent = []
        self.closed_with = None

    async def send_text(self, data):
        self.sent.append(json.loads(data))

    async def close(self, code=1000):
        self.closed_with = code


def make_hubs():
    device_hub = DeviceHub(online_timeout_s=15, read_timeout_s=2)
    return device_hub, LiveHub(device_hub)


async def connected_hubs():
    device_hub, live_hub = make_hubs()
    device = FakeConnection()
    await device_hub.attach_device(device)
    await device_hub.handle_device_message(device, json.dumps(STATUS))
    return device_hub, live_hub, device


def drain(viewer):
    messages = [json.loads(text) for _, text in viewer.outbox]
    viewer.outbox.clear()
    return messages


def test_the_live_switch_is_relayed_to_the_device_as_is():
    async def scenario():
        _, live, device = await connected_hubs()
        first, second = live.add_viewer(), live.add_viewer()

        await live.set_live(True)
        await live.set_live(True)  # one switch: the device, not the hub, decides it's already on
        await live.set_live(False)
        assert device.sent == [{"cmd": "live_start"}, {"cmd": "live_start"}, {"cmd": "live_stop"}]

        live.remove_viewer(first)  # leaving doesn't switch Live off; the device's auto-off does
        live.remove_viewer(second)
        assert device.sent[-1] == {"cmd": "live_stop"}
        assert len(device.sent) == 3

    asyncio.run(scenario())


def test_the_led_switch_is_relayed_to_the_device_as_is():
    async def scenario():
        hub, live, device = await connected_hubs()
        viewer = live.add_viewer()
        drain(viewer)

        await live.set_led(False)
        await live.set_led(True)
        assert device.sent == [{"cmd": "led_off"}, {"cmd": "led_on"}]

        # The device's status is the answer, and every page follows it.
        await hub.handle_device_message(device, json.dumps({**STATUS, "state": "LIVE", "live_on": True, "led_on": False}))
        assert drain(viewer)[-1]["device"]["led_on"] is False

    asyncio.run(scenario())


def test_dark_frames_say_so_and_older_frames_still_pass():
    async def scenario():
        hub, live, device = await connected_hubs()
        viewer = live.add_viewer()
        drain(viewer)

        await hub.handle_device_message(device, json.dumps({**LIVE, "led": False}))
        # Firmware before 7.1.0 sends no "led": the frame still reaches the page, marked unknown.
        await hub.handle_device_message(device, json.dumps({key: value for key, value in LIVE.items() if key != "led"}))

        assert [frame["led"] for frame in drain(viewer)] == [False, None]

    asyncio.run(scenario())


def test_the_live_switch_needs_a_device():
    async def scenario():
        _, live = make_hubs()
        with pytest.raises(DeviceOffline):
            await live.set_live(True)

    asyncio.run(scenario())


def test_live_frames_reach_every_viewer():
    async def scenario():
        hub, live, device = await connected_hubs()
        first, second = live.add_viewer(), live.add_viewer()
        drain(first)
        drain(second)

        await hub.handle_device_message(device, json.dumps(LIVE))

        assert drain(first) == [LIVE]
        assert drain(second) == [LIVE]

    asyncio.run(scenario())


def test_every_viewer_hears_the_device_switch_live():
    async def scenario():
        hub, live, device = await connected_hubs()
        viewer = live.add_viewer()
        drain(viewer)

        # The button was pressed: the device reports it, and every page follows.
        await hub.handle_device_message(device, json.dumps({**STATUS, "state": "LIVE", "live_on": True, "live_off_in_s": 600}))

        presence = drain(viewer)[-1]
        assert presence["device"]["live_on"] is True
        assert presence["device"]["live_off_in_s"] == 600

    asyncio.run(scenario())


def test_malformed_live_frames_are_dropped():
    async def scenario():
        hub, live, device = await connected_hubs()
        viewer = live.add_viewer()
        drain(viewer)

        await hub.handle_device_message(device, json.dumps({"mode": "live", "seq": 1}))

        assert drain(viewer) == []

    asyncio.run(scenario())


def test_viewers_hear_the_device_come_and_go():
    async def scenario():
        hub, live = make_hubs()
        viewer = live.add_viewer()
        assert drain(viewer) == [{"mode": "presence", "online": False, "last_seen": None, "device": None}]

        device = FakeConnection()
        await hub.attach_device(device)
        await hub.handle_device_message(device, json.dumps(STATUS))
        assert drain(viewer)[-1]["online"] is True

        await hub.detach_device(device)
        presence = drain(viewer)[-1]
        assert presence["online"] is False
        assert presence["device"]["build_id"] == "P1-PROTO-01"

    asyncio.run(scenario())


def test_viewers_hear_a_device_that_goes_quiet_without_closing_its_socket():
    async def scenario():
        hub = DeviceHub(online_timeout_s=0.1, read_timeout_s=2)
        live = LiveHub(hub)
        device = FakeConnection()
        await hub.attach_device(device)
        await hub.handle_device_message(device, json.dumps(STATUS))
        viewer = live.add_viewer()
        drain(viewer)

        live.check_presence()
        assert drain(viewer) == []

        await asyncio.sleep(0.2)
        live.check_presence()
        live.check_presence()  # every viewer's route calls it; the change goes out once
        assert [message["online"] for message in drain(viewer)] == [False]

    asyncio.run(scenario())


def test_a_browser_that_falls_behind_loses_frames_but_not_presence():
    async def scenario():
        hub, live, device = await connected_hubs()
        viewer = live.add_viewer()
        drain(viewer)

        for _ in range(VIEWER_OUTBOX_SIZE * 2):
            await hub.handle_device_message(device, json.dumps(LIVE))
        await hub.detach_device(device)  # the one message check_presence() would never resend

        messages = drain(viewer)
        assert len(messages) == VIEWER_OUTBOX_SIZE
        assert [message["mode"] for message in messages].count("live") == VIEWER_OUTBOX_SIZE - 1
        assert messages[-1]["mode"] == "presence" and messages[-1]["online"] is False

    asyncio.run(scenario())


def test_presence_repeats_as_a_keepalive_when_nothing_else_is_sent(monkeypatch):
    monkeypatch.setattr(live_hub_module, "PRESENCE_HEARTBEAT_SECONDS", 0.05)

    async def scenario():
        _, live = make_hubs()  # no device: presence is the only thing this browser ever hears
        viewer = live.add_viewer()
        drain(viewer)

        live.check_presence()
        assert drain(viewer) == []  # nothing changed and the heartbeat isn't due

        await asyncio.sleep(0.06)
        live.check_presence()
        assert [message["mode"] for message in drain(viewer)] == ["presence"]

    asyncio.run(scenario())
