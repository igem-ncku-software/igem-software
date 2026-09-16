import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.hardware.router import device_hub
from app.main import app
from tests.hardware.payloads import STATUS, measurement

client = TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def _shared_portal():
    # Tests below hold the device socket and a browser socket (or an HTTP call) at once. Without
    # entering the client, each connection runs on its own anyio portal and event loop.
    with client:
        yield


@pytest.fixture(autouse=True)
def _fresh_hub():
    device_hub.reset()
    yield
    device_hub.reset()


def wait_until_online():
    for _ in range(200):
        if client.get("/api/hardware/status").json()["online"]:
            return
        time.sleep(0.01)
    raise AssertionError("the device never came online")


def read_while_device_replies(device, reply):
    """POST /read from a worker thread while this thread plays the device."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.post, "/api/hardware/read")
        command = device.receive_json()
        assert command["cmd"] == "read"
        device.send_json(reply(command["request_id"]))
        return pending.result(timeout=5)


# --- GET /status ---


def test_status_before_any_device_connects():
    assert client.get("/api/hardware/status").json() == {"online": False, "last_seen": None, "device": None}


def test_status_reflects_the_connected_device():
    with client.websocket_connect("/api/hardware/device") as device:
        device.send_json(STATUS)
        wait_until_online()
        body = client.get("/api/hardware/status").json()

    assert body["device"]["build_id"] == "P1-PROTO-01"
    assert body["device"]["config"]["gain"] == 16
    assert body["last_seen"] is not None


def test_status_goes_offline_when_the_device_disconnects():
    with client.websocket_connect("/api/hardware/device") as device:
        device.send_json(STATUS)
        wait_until_online()

    body = client.get("/api/hardware/status").json()
    assert body["online"] is False
    assert body["device"]["device_id"] == "capture-screen-p1"


def test_device_handshake_echoes_the_arduino_subprotocol():
    with client.websocket_connect("/api/hardware/device", subprotocols=["arduino"]) as device:
        assert device.accepted_subprotocol == "arduino"


# --- POST /read ---


def test_read_round_trips_through_the_device_connection():
    with client.websocket_connect("/api/hardware/device") as device:
        device.send_json(STATUS)
        wait_until_online()
        response = read_while_device_replies(device, measurement)

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "measurement"
    assert body["light"]["F4"] == 900
    assert "request_id" not in body


def test_read_without_a_device_is_503():
    assert client.post("/api/hardware/read").status_code == 503


def test_read_on_a_busy_device_is_409():
    with client.websocket_connect("/api/hardware/device") as device:
        device.send_json(STATUS)
        wait_until_online()
        response = read_while_device_replies(
            device, lambda request_id: {"mode": "error", "request_id": request_id, "error": "busy"}
        )

    assert response.status_code == 409

