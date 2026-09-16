"""The live frame the firmware streams (firmware/as7341/as7341.ino, mode "live").

Field names match that JSON and frontend/js/device_live.js. Renaming one
means changing all three.
"""

from typing import Literal

from pydantic import BaseModel, Field

from app.hardware.models import ChannelFrame


class LiveFrame(BaseModel):
    """Display-only: never stored, never turned into a Measurement."""

    mode: Literal["live"]
    seq: int = Field(ge=0)
    t_ms: int = Field(ge=0)
    raw: ChannelFrame
