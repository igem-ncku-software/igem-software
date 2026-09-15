import asyncio
import json

import pytest

from app.hardware.hub import DeviceBusy, DeviceError, DeviceHub, DeviceOffline, DeviceTimeout
from tests.hardware.payloads import LIVE, STATUS, measurement


class FakeConnection:
    """Stands in for the device's WebSocket: records what the hub sends it."""

    def __init__(self):
        self.sent = []
        self.closed_with = None

    async def send_text(self, data):
        self.sent.append(json.loads(data))

    async def close(self, code=1000):
        self.closed_with = code


def make_hub(online_timeout_s=15, read_timeout_s=2):
    return DeviceHub(online_timeout_s=online_timeout_s, read_timeout_s=read_timeout_s)


async def connected_hub(**timeouts):
    hub = make_hub(**timeouts)
    device = FakeConnection()
    await hub.attach_device(device)
    await hub.handle_device_message(device, json.dumps(STATUS))
    return hub, device


async def next_command(device):
    for _ in range(100):
        if device.sent:
            return device.sent.pop(0)
        await asyncio.sleep(0)
    raise AssertionError("the hub sent the device nothing")


def drain(viewer):
    messages = []
    while not viewer.outbox.empty():
        messages.append(json.loads(viewer.outbox.get_nowait()))
    return messages


# --- presence ---


def test_device_is_online_only_after_it_reports_its_status():
    async def scenario():
        hub = make_hub()
        device = FakeConnection()
        await hub.attach_device(device)
        assert not hub.online

        await hub.handle_device_message(device, json.dumps(STATUS))
        assert hub.online
        assert hub.status["wifi_rssi"] == -47

    asyncio.run(scenario())


def test_last_status_is_kept_after_the_device_disconnects():
    async def scenario():
        hub, device = await connected_hub()
        await hub.detach_device(device)

        assert not hub.online
        assert hub.status["device_id"] == "capture-screen-p1"
        assert hub.last_seen is not None

    asyncio.run(scenario())


def test_device_goes_offline_when_it_stops_reporting():
    async def scenario():
        hub, _ = await connected_hub(online_timeout_s=0.05)
        await asyncio.sleep(0.1)
        assert not hub.online

    asyncio.run(scenario())


def test_a_new_device_connection_replaces_the_old_one():
    async def scenario():
        hub, old = await connected_hub()
        new = FakeConnection()
        await hub.attach_device(new)
        assert old.closed_with == 4000

        await hub.handle_device_message(old, json.dumps(STATUS))
        assert not hub.online  # the replaced socket no longer counts

        await hub.detach_device(old)
        await hub.handle_device_message(new, json.dumps(STATUS))
        assert hub.online  # and its closing doesn't take the new one offline

    asyncio.run(scenario())


def test_malformed_device_messages_are_ignored():
    async def scenario():
        hub, device = await connected_hub()
        viewer = hub.add_viewer()
        await hub.set_watching(viewer, True)
        drain(viewer)
        device.sent.clear()

        for text in ["not json", "[1, 2]", json.dumps({"mode": "live", "seq": 1}), json.dumps({**STATUS, "state": "ON FIRE"})]:
            await hub.handle_device_message(device, text)

        assert drain(viewer) == []
        assert hub.status["state"] == "IDLE"

    asyncio.run(scenario())


# --- measurements ---


def test_read_sends_a_command_and_returns_the_devices_frames():
    async def scenario():
        hub, device = await connected_hub()
        read = asyncio.create_task(hub.read())
        command = await next_command(device)
        assert command["cmd"] == "read"

        await hub.handle_device_message(device, json.dumps(measurement("someone-else")))
        await hub.handle_device_message(device, json.dumps(measurement(command["request_id"])))
        result = await read

        assert result["light"]["F4"] == 900
        assert "request_id" not in result

    asyncio.run(scenario())


def test_read_without_a_device_fails_at_once():
    async def scenario():
        with pytest.raises(DeviceOffline):
            await make_hub().read()

    asyncio.run(scenario())


def test_read_reports_a_busy_device():
    async def scenario():
        hub, device = await connected_hub()
        read = asyncio.create_task(hub.read())
        command = await next_command(device)
        await hub.handle_device_message(
            device, json.dumps({"mode": "error", "request_id": command["request_id"], "error": "busy"})
        )
        with pytest.raises(DeviceBusy):
            await read

    asyncio.run(scenario())


def test_read_times_out_when_the_device_never_answers():
    async def scenario():
        hub, _ = await connected_hub(read_timeout_s=0.05)
        with pytest.raises(DeviceTimeout):
            await hub.read()

    asyncio.run(scenario())


def test_read_fails_at_once_when_the_device_disconnects_mid_read():
    async def scenario():
        hub, device = await connected_hub()
        read = asyncio.create_task(hub.read())
        await next_command(device)
        await hub.detach_device(device)
        with pytest.raises(DeviceOffline):
            await read

    asyncio.run(scenario())


def test_a_malformed_measurement_is_an_error_not_a_result():
    async def scenario():
        hub, device = await connected_hub()
        read = asyncio.create_task(hub.read())
        command = await next_command(device)
        broken = {**measurement(command["request_id"]), "light": {"F4": "bright"}}
        await hub.handle_device_message(device, json.dumps(broken))
        with pytest.raises(DeviceError):
            await read

    asyncio.run(scenario())


# --- live spectrum ---


def test_led_stream_follows_the_first_and_last_watcher():
    async def scenario():
        hub, device = await connected_hub()
        first, second = hub.add_viewer(), hub.add_viewer()

        await hub.set_watching(first, True)
        await hub.set_watching(second, True)
        assert device.sent == [{"cmd": "live_start"}]

        await hub.set_watching(first, False)
        assert device.sent == [{"cmd": "live_start"}]

        await hub.remove_viewer(second)
        assert device.sent == [{"cmd": "live_start"}, {"cmd": "live_stop"}]

    asyncio.run(scenario())


def test_live_frames_reach_watchers_only():
    async def scenario():
        hub, device = await connected_hub()
        watcher, bystander = hub.add_viewer(), hub.add_viewer()
        await hub.set_watching(watcher, True)
        drain(watcher)
        drain(bystander)

        await hub.handle_device_message(device, json.dumps(LIVE))

        assert drain(watcher) == [LIVE]
        assert drain(bystander) == []

    asyncio.run(scenario())


def test_viewers_hear_the_device_come_and_go():
    async def scenario():
        hub = make_hub()
        viewer = hub.add_viewer()
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


def test_a_device_that_connects_while_someone_watches_starts_streaming():
    async def scenario():
        hub = make_hub()
        viewer = hub.add_viewer()
        await hub.set_watching(viewer, True)  # no device yet: nothing to tell, no error

        device = FakeConnection()
        await hub.attach_device(device)

        assert device.sent == [{"cmd": "live_start"}]

    asyncio.run(scenario())
