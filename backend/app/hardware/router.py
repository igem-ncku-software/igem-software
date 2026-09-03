"""FastAPI router for the ESP32 + AS7341 spectral sensor.

AS7341 is an 11-channel spectral sensor: 8 visible-light channels F1-F8
(415-680nm) plus Clear (unfiltered) and NIR. The ESP32 posts raw ADC
counts (uint16, straight out of Adafruit_AS7341's readAllChannels())
for these 10 channels every 1-5s.

Thin HTTP adapter over a single in-memory "latest reading" - no
history/database. POST /upload overwrites it, GET /latest reads it
back. Restarting the server (or a second ESP32 uploading) loses/
overwrites the previous reading; that's an accepted tradeoff for now.
"""

from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/hardware", tags=["hardware"])


class SpectralChannels(BaseModel):
    f1: int  # 415nm, violet
    f2: int  # 445nm, blue
    f3: int  # 480nm, cyan
    f4: int  # 515nm, green
    f5: int  # 555nm, yellow-green
    f6: int  # 590nm, orange
    f7: int  # 630nm, red
    f8: int  # 680nm, deep red
    clear: int  # unfiltered
    nir: int  # near-infrared


class SensorReading(BaseModel):
    channels: SpectralChannels


class LatestReading(BaseModel):
    channels: SpectralChannels | None
    timestamp: str | None  # ISO 8601 UTC, set by the server on upload


_latest = LatestReading(channels=None, timestamp=None)


@router.post("/upload", response_model=LatestReading)
async def upload(reading: SensorReading) -> LatestReading:
    global _latest
    _latest = LatestReading(
        channels=reading.channels,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    return _latest


@router.get("/latest", response_model=LatestReading)
async def latest() -> LatestReading:
    return _latest
