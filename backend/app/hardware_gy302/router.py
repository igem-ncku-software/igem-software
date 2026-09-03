"""FastAPI router for the ESP32 + GY-302 (BH1750) ambient light sensor.

GY-302 is a breakout board for the BH1750FVI digital ambient light sensor
(I2C). It reports illuminance directly in lux (no raw-channel conversion
needed on this side, unlike the AS7341 module).

Thin HTTP adapter over a single in-memory "latest reading" - no
history/database, same tradeoff as app/hardware: POST /upload overwrites
it, GET /latest reads it back. Restarting the server (or a second ESP32
uploading) loses/overwrites the previous reading.
"""

from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/hardware_gy302", tags=["hardware_gy302"])


class SensorReading(BaseModel):
    lux: float = Field(ge=0)


class LatestReading(BaseModel):
    lux: float | None
    timestamp: str | None  # ISO 8601 UTC, set by the server on upload


_latest = LatestReading(lux=None, timestamp=None)


@router.post("/upload", response_model=LatestReading)
async def upload(reading: SensorReading) -> LatestReading:
    global _latest
    _latest = LatestReading(
        lux=reading.lux,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    return _latest


@router.get("/latest", response_model=LatestReading)
async def latest() -> LatestReading:
    return _latest
