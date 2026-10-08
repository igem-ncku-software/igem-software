"""The response of POST /api/swarming/analyze: the contract with frontend/js/swarming.js."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class Dish(BaseModel):
    x_px: int
    y_px: int
    radius_px: int
    diameter_mm: float
    # "hough": circle detection found it. "contour": the notebook's fallback, the largest bright
    # region's enclosing circle, where it printed "Hough found no plate" - the scale is less sure.
    method: Literal["hough", "contour"]


class Threshold(BaseModel):
    """The thresholds of the mode that ran (the notebook's `thr_label`); the other mode's are None."""

    # Normal mode, on the background-corrected gray scaled to 0-255.
    otsu: float | None = None
    loose: float | None = None
    core: float | None = None
    # UV mode, on the blurred G/B ratio.
    uv_base: float | None = None
    uv_peak: float | None = None
    uv_thr: float | None = None


class PhotoSize(BaseModel):
    width_px: int
    height_px: int


class Colony(BaseModel):
    index: int
    feret_mm: float
    eq_diameter_mm: float
    area_mm2: float


class SwarmingResult(BaseModel):
    dish: Dish
    mm_per_px: float
    # "uv": blue-purple pixels are over UV_FRAC_THRESHOLD of the photo, so colonies are found by
    # their G/B ratio; "normal": Otsu with the core filter.
    mode: Literal["normal", "uv"]
    purple_fraction: float
    threshold: Threshold
    image: PhotoSize
    colonies: list[Colony]
    annotated_png: str  # base64
