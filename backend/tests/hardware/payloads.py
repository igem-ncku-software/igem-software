"""Messages shaped exactly like firmware/as7341/as7341.ino's, shared by the hardware tests."""

STATUS = {
    "mode": "status",
    "device_id": "capture-screen-p1",
    "build_id": "P1-PROTO-01",
    "firmware_version": "0.3.0",
    "state": "IDLE",
    "uptime_ms": 1234,
    "wifi_rssi": -47,
    "config": {"led_current_mA": 5.553, "gain": 16, "atime": 29, "astep": 599},
}

FRAME = {"F1": 1, "F2": 2, "F3": 3, "F4": 4, "F5": 5, "F6": 6, "F7": 7, "F8": 8, "CLR": 9, "NIR": 10}

LIVE = {"mode": "live", "seq": 1, "t_ms": 42, "raw": FRAME}


def measurement(request_id: str) -> dict:
    return {
        "mode": "measurement",
        "request_id": request_id,
        "device_id": STATUS["device_id"],
        "build_id": STATUS["build_id"],
        "firmware_version": STATUS["firmware_version"],
        "uptime_ms": 2000,
        "read_time_ms": 612,
        "config": STATUS["config"],
        "dark_1": FRAME,
        "light": {**FRAME, "F4": 900},
        "dark_2": FRAME,
        "clear_nir_mode2": {"CLR": 9, "NIR": 10},
    }
