import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.hardware.router import device_hub
from app.live.router import live_hub
from app.main import app
from tests.hardware.payloads import LIVE, STATUS

client = TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def _shared_portal():
    # Tests below hold the device socket and a browser socket at once. Without
    # entering the client, each connection runs on its own anyio portal and event loop.
    with client:
        yield


@pytest.fixture(autouse=True)
def _fresh_hubs():
    device_hub.reset()
    live_hub.reset()
    yield
    device_hub.reset()
    live_hub.reset()


def wait_until_online():
    for _ in range(200):
        if client.get("/api/hardware/status").json()["online"]:
            return
        time.sleep(0.01)
    raise AssertionError("the device never came online")


def test_watching_switches_the_stream_and_relays_frames():
    with client.websocket_connect("/api/hardware/device") as device:
        device.send_json(STATUS)
        wait_until_online()

        with client.websocket_connect("/api/live/spectrum") as browser:
            assert browser.receive_json()["online"] is True

            browser.send_json({"cmd": "live_start"})
            assert device.receive_json() == {"cmd": "live_start"}
            assert browser.receive_json() == {"mode": "watching", "watching": True}

            device.send_json(LIVE)
            assert browser.receive_json() == LIVE

            browser.send_json({"cmd": "live_stop"})
            assert device.receive_json() == {"cmd": "live_stop"}
            assert browser.receive_json() == {"mode": "watching", "watching": False}


def test_presence_carries_the_same_fields_as_hardware_status():
    with client.websocket_connect("/api/hardware/device") as device:
        device.send_json(STATUS)
        wait_until_online()

        with client.websocket_connect("/api/live/spectrum") as browser:
            presence = browser.receive_json()

        assert presence.pop("mode") == "presence"
        assert presence == client.get("/api/hardware/status").json()


def test_live_rejects_unknown_commands():
    with client.websocket_connect("/api/live/spectrum") as browser:
        browser.receive_json()
        browser.send_json({"cmd": "erase"})
        assert browser.receive_json() == {"mode": "error", "error": "unknown_cmd"}


def test_live_rejects_an_untrusted_browser_origin():
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect("/api/live/spectrum", headers={"origin": "https://untrusted.example"}):
            pass

    assert error.value.code == 1008
