"""FastAPI router for the Swarming Assay: one plate photo in, the notebook's measurements out.

Nothing is stored: the photo is read, analysed and dropped. The `detail` of every error is shown
to the user verbatim (the page prints "Analysis failed: ..."), so it is worded for them.
"""

from __future__ import annotations

import base64
import logging
import threading

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.swarming.analysis import ACTUAL_DISH_DIAMETER_MM, PhotoUnreadable, analyze, decode_photo
from app.swarming.models import SwarmingResult

router = APIRouter(prefix="/api/swarming", tags=["swarming"])
logger = logging.getLogger(__name__)

# A phone photo is a few MB; this bounds one upload's memory on Render's free tier.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# One analysis at a time: a 12-megapixel photo holds several float copies of itself in memory
# at once, and two at the same moment could exceed Render's free-tier memory.
_analysis_lock = threading.Lock()


@router.post("/analyze", response_model=SwarmingResult)
def swarming_analyze(
    file: UploadFile = File(...),
    dish_diameter_mm: float = Form(ACTUAL_DISH_DIAMETER_MM, gt=0, le=1000),
) -> dict:
    """Find the plate and the colonies in one photo and measure each colony."""
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The photo is larger than 20 MB.")
    try:
        img = decode_photo(data)
    except PhotoUnreadable as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    with _analysis_lock:
        try:
            result = analyze(img, dish_diameter_mm)
        except Exception as error:  # an OpenCV error on an odd photo, worded for the user
            logger.exception("swarming analysis failed")
            raise HTTPException(
                status_code=422,
                detail="This photo could not be analysed. Check that the plate is in the photo.",
            ) from error

    result["annotated_png"] = base64.b64encode(result["annotated_png"]).decode("ascii")
    return result
