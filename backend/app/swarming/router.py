"""FastAPI router for the Swarming Assay: one plate photo in, the notebook's measurements out.

Nothing is stored: the photo is read, analysed and dropped. The `detail` of every error is shown
to the user verbatim (the page prints "Analysis failed: ..."), so it is worded for them.
"""

from __future__ import annotations

import base64
import logging
import threading

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.swarming.analysis import (
    ACTUAL_DISH_DIAMETER_MM,
    PhotoTooLarge,
    PhotoUnreadable,
    analyze,
    decode_photo,
)
from app.swarming.models import SwarmingResult

router = APIRouter(prefix="/api/swarming", tags=["swarming"])
logger = logging.getLogger(__name__)

# A phone photo is a few MB; this bounds one upload's memory on Render's free tier.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# The one step the notebook doesn't have, so the analysis fits Render's free tier (512 MB):
# a photo is shrunk so its longest side is at most this before it is analysed. The notebook's
# background blur grows with the cube of the width, and a 12-MP phone photo peaked at 860 MB
# and 30 s. Measured on a real swarming photo (IMG_7255, 4032 x 3024, 2026-10-08): at 2000 px
# the peak was 256 MB and 2 s, and the swarm measured within 2.5 % of the full-size analysis
# (longest span 47.9 vs 46.9 mm, area 1420 vs 1366 mm²); two 1-2 mm specks the full size
# counted were below MIN_AREA_PX at this size. Accepted by the user that day.
MAX_ANALYSIS_SIDE_PX = 2000

# One analysis at a time: each holds several float copies of the photo in memory, and two at
# the same moment could still exceed the free tier.
_analysis_lock = threading.Lock()


def shrink_for_analysis(img: np.ndarray) -> np.ndarray:
    """The photo with its longest side at most MAX_ANALYSIS_SIDE_PX (area averaging); a smaller
    photo is returned unchanged."""
    h, w = img.shape[:2]
    if max(h, w) <= MAX_ANALYSIS_SIDE_PX:
        return img
    f = MAX_ANALYSIS_SIDE_PX / max(h, w)
    size = (max(1, round(w * f)), max(1, round(h * f)))
    return cv2.resize(img, size, interpolation=cv2.INTER_AREA)


@router.post("/analyze", response_model=SwarmingResult)
def swarming_analyze(
    file: UploadFile = File(...),
    dish_diameter_mm: float = Form(ACTUAL_DISH_DIAMETER_MM, gt=0, le=1000),
) -> dict:
    """Find the plate and the colonies in one photo and measure each colony."""
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The photo is larger than 20 MB.")

    with _analysis_lock:
        try:
            img = decode_photo(data)
        except PhotoTooLarge as error:
            raise HTTPException(status_code=413, detail=str(error)) from error
        except PhotoUnreadable as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        del data
        original = {"width_px": int(img.shape[1]), "height_px": int(img.shape[0])}
        img = shrink_for_analysis(img)

        try:
            result = analyze(img, dish_diameter_mm)
        except Exception as error:  # an OpenCV error on an odd photo, worded for the user
            logger.exception("swarming analysis failed")
            raise HTTPException(
                status_code=422,
                detail="This photo could not be analysed. Check that the plate is in the photo.",
            ) from error

    # `image` is what was analysed (the plate's pixel position and radius are in it);
    # `original` is the photo as uploaded.
    result["original"] = original
    result["annotated_png"] = base64.b64encode(result["annotated_png"]).decode("ascii")
    return result
