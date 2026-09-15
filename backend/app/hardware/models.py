"""HTTP data contracts for the CAPTURE-Screen live backend."""

from typing import Literal

from pydantic import BaseModel


class DeviceConfig(BaseModel):
    led_current_mA: float
    gain: int
    atime: int
    astep: int


class DeviceStatus(BaseModel):
    device_id: str
    build_id: str
    firmware_version: str
    state: str
    uptime_ms: int
    wifi_rssi: int
    config: DeviceConfig


class HardwareStatusResponse(BaseModel):
    online: bool
    source: Literal["mock", "device"]
    device: DeviceStatus
