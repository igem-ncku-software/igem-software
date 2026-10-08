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


class PhotoSize(BaseModel):
    width_px: int
    height_px: int


class Colony(BaseModel):
    index: int
    feret_mm: float
    eq_diameter_mm: float
    area_mm2: float


class SwarmingResult(BaseModel):
    dish: Dish                # pixel values are in `image`, the photo as analysed
    mm_per_px: float          # likewise
    image: PhotoSize          # as analysed: shrunk to router.MAX_ANALYSIS_SIDE_PX if larger
    original: PhotoSize       # as uploaded
    colonies: list[Colony]
    annotated_png: str  # base64
