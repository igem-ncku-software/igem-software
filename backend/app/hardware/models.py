"""Data contracts between the CAPTURE-Screen firmware, this backend, and the browser.

Field names match the JSON that firmware/as7341/as7341.ino sends and the
validators in frontend/js/hardware_processing.js. Renaming one means
changing all three.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

Counts = Annotated[int, Field(ge=0)]


class ChannelFrame(BaseModel):
    """One AS7341 read: raw ADC counts per channel, no processing."""

    F1: Counts
    F2: Counts
    F3: Counts
    F4: Counts
    F5: Counts
    F6: Counts
    F7: Counts
    F8: Counts
    CLR: Counts
    NIR: Counts


class ClearNirFrame(BaseModel):
    CLR: Counts
    NIR: Counts


class DeviceConfig(BaseModel):
    led_current_mA: float
    gain: float = Field(gt=0)
    atime: int = Field(ge=0)
    astep: int = Field(ge=0)


class DeviceIdentity(BaseModel):
    device_id: str
    build_id: str
    firmware_version: str


class DeviceStatus(DeviceIdentity):
    state: Literal["IDLE", "LIVE", "MEASURING"]
    uptime_ms: int = Field(ge=0)
    wifi_rssi: int
    config: DeviceConfig


class LiveFrame(BaseModel):
    """Display-only: never stored, never turned into a Measurement."""

    mode: Literal["live"]
    seq: int = Field(ge=0)
    t_ms: int = Field(ge=0)
    raw: ChannelFrame


class DeviceMeasurement(DeviceIdentity):
    """Result of one read: dark_1 -> light -> dark_2. Dark subtraction and
    normalization happen in the browser (hardware_processing.js)."""

    mode: Literal["measurement"]
    uptime_ms: int = Field(ge=0)
    read_time_ms: int = Field(ge=0)
    config: DeviceConfig
    dark_1: ChannelFrame | None = None
    light: ChannelFrame
    dark_2: ChannelFrame | None = None
    clear_nir_mode2: ClearNirFrame | None = None


class HardwareStatusResponse(BaseModel):
    online: bool
    last_seen: datetime | None
    # The last status the device reported; kept after it disconnects so pages can say what went offline.
    device: DeviceStatus | None
