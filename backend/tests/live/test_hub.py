import asyncio
import json

from app.hardware.hub import DeviceHub
from app.live.hub import LiveHub
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
    messages = []
    while not viewer.outbox.empty():
        messages.append(json.loads(viewer.outbox.get_nowait()))
    return messages


def test_led_stream_follows_the_first_and_last_watcher():
    async def scenario():
        _, live, device = await connected_hubs()
        first, second = live.add_viewer(), live.add_viewer()

        await live.set_watching(first, True)
        await live.set_watching(second, True)
        assert device.sent == [{"cmd": "live_start"}]

        await live.set_watching(first, False)
        assert device.sent == [{"cmd": "live_start"}]

        await live.remove_viewer(second)
        assert device.sent == [{"cmd": "live_start"}, {"cmd": "live_stop"}]

    asyncio.run(scenario())


def test_live_frames_reach_watchers_only():
    async def scenario():
        hub, live, device = await connected_hubs()
        watcher, bystander = live.add_viewer(), live.add_viewer()
        await live.set_watching(watcher, True)
        drain(watcher)
        drain(bystander)

        await hub.handle_device_message(device, json.dumps(LIVE))

        assert drain(watcher) == [LIVE]
        assert drain(bystander) == []

    asyncio.run(scenario())


def test_malformed_live_frames_are_dropped():
    async def scenario():
        hub, live, device = await connected_hubs()
        viewer = live.add_viewer()
        await live.set_watching(viewer, True)
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


def test_a_device_that_connects_while_someone_watches_starts_streaming():
    async def scenario():
        hub, live = make_hubs()
        viewer = live.add_viewer()
        await live.set_watching(viewer, True)  # no device yet: nothing to tell, no error

        device = FakeConnection()
        await hub.attach_device(device)

        assert device.sent == [{"cmd": "live_start"}]

    asyncio.run(scenario())
