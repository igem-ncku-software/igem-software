import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.main import app


client = TestClient(app)


def test_hardware_status_in_mock_mode(monkeypatch):
    monkeypatch.setattr(settings, "HARDWARE_MODE", "mock")

    response = client.get("/api/hardware/status")

    assert response.status_code == 200
    body = response.json()
    assert body["online"] is True
    assert body["source"] == "mock"
    assert body["device"]["state"] == "IDLE"
    assert body["device"]["config"]["gain"] == 16


def test_hardware_live_mock_start_frame_and_stop(monkeypatch):
    monkeypatch.setattr(settings, "HARDWARE_MODE", "mock")
    monkeypatch.setattr(settings, "HARDWARE_LIVE_INTERVAL_MS", 50)

    with client.websocket_connect("/api/hardware/live") as websocket:
        assert websocket.receive_json() == {"mode": "state", "state": "IDLE"}

        websocket.send_json({"cmd": "live_start"})
        assert websocket.receive_json() == {"mode": "state", "state": "LIVE"}
        frame = websocket.receive_json()
        assert frame["mode"] == "live"
        assert frame["seq"] == 1
        assert set(frame["raw"]) == {
            "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "CLR", "NIR"
        }

        websocket.send_json({"cmd": "live_stop"})
        assert websocket.receive_json() == {"mode": "state", "state": "IDLE"}


def test_hardware_live_rejects_unknown_command(monkeypatch):
    monkeypatch.setattr(settings, "HARDWARE_MODE", "mock")

    with client.websocket_connect("/api/hardware/live") as websocket:
        websocket.receive_json()
        websocket.send_json({"cmd": "erase"})
        assert websocket.receive_json() == {"error": "unknown_cmd"}


def test_hardware_live_rejects_untrusted_browser_origin(monkeypatch):
    monkeypatch.setattr(settings, "HARDWARE_MODE", "mock")

    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(
            "/api/hardware/live", headers={"origin": "https://untrusted.example"}
        ):
            pass

    assert error.value.code == 1008
