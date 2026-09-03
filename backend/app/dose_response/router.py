"""FastAPI router for the dose-response pipeline (spec docs/dose_response_model_spec.md).

Thin HTTP adapter only - every computation is a direct call into
pipeline.py/doseresponse.py; no fitting/statistics logic lives here.
"""

import math
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.dose_response.doseresponse import predict_concentration
from app.dose_response.pipeline import run_pipeline

router = APIRouter(prefix="/api/dose_response", tags=["dose_response"])


def _json_safe(value):
    """Replace non-finite floats (NaN/Infinity) with None so the response is
    valid JSON - same role as the pre-rewrite router's _json_safe(). Python's
    json encoder happily emits a literal NaN/Infinity token by default, which
    most strict JSON parsers (including the browser's JSON.parse) reject.
    """
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _json_safe(v) for key, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


# --- POST /analyze ---


class StrainAnalysis(BaseModel):
    strain: str
    ec50_nM: float | None
    ec50_nM_ci95: tuple[float, float] | None
    n: float | None
    top: float | None
    bottom: float | None
    r_squared: float | None
    responsive: bool
    p_value: float
    lod_nM: float | None
    loq_nM: float | None
    plateau_points: list[tuple[float, float]]  # (concentration_nM, plateau), every tested concentration incl. 0
    fit_curve: list[tuple[float, float]] | None  # (concentration_nM, predicted F); None when not responsive


class AnalyzeResponse(BaseModel):
    strains: dict[str, StrainAnalysis]


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze(file: UploadFile = File(...)):
    """Run the full pipeline (io -> normalize -> timeseries -> doseresponse)
    on an uploaded raw plate-reader export and return every strain's fitted
    dose-response results plus chart-ready data points.
    """
    contents = await file.read()

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir) / (file.filename or "upload.txt")
        tmp_path.write_bytes(contents)
        try:
            results = run_pipeline(tmp_path)
        except Exception as error:
            raise HTTPException(status_code=400, detail=f"Failed to analyze upload: {error}") from error

    if not results:
        raise HTTPException(status_code=400, detail="No strains found in the uploaded file.")

    payload = {
        "strains": {
            strain: {
                "strain": result.strain,
                "ec50_nM": result.ec50_nM,
                "ec50_nM_ci95": result.ec50_nM_ci95,
                "n": result.n,
                "top": result.top,
                "bottom": result.bottom,
                "r_squared": result.r_squared,
                "responsive": result.responsive,
                "p_value": result.p_value,
                "lod_nM": result.lod_nM,
                "loq_nM": result.loq_nM,
                "plateau_points": result.plateau_points,
                "fit_curve": result.fit_curve,
            }
            for strain, result in results.items()
        }
    }
    return _json_safe(payload)


# --- POST /predict ---


class HillParams(BaseModel):
    bottom: float
    top: float
    ec50_nM: float
    n: float
    ec50_nM_ci95: tuple[float, float] | None = None


class PredictRequest(BaseModel):
    strain: str
    fluorescence: float
    hill_params: HillParams


class PredictResponse(BaseModel):
    strain: str
    fluorescence: float
    concentration_nM: float | None
    concentration_nM_ci95: tuple[float, float] | None
    in_range: bool
    message: str | None


@router.post("/predict", response_model=PredictResponse)
async def predict(payload: PredictRequest):
    """Back-calculate [AHL] from a normalized fluorescence reading, given a
    strain's already-fitted Hill parameters (typically copied straight from
    a prior /analyze response).

    Stateless by design, like /analyze: the client resends the fitted
    parameters rather than the server remembering a prior analysis by a
    session id. There's no session/result-storage mechanism anywhere in
    this backend (hardware_gy302/'s in-memory latest reading is the only
    precedent, and that's one global value, not per-session), so building
    one just for this endpoint would be new infrastructure beyond what was
    asked.
    """
    hp = payload.hill_params
    ec50_M = hp.ec50_nM * 1e-9
    ec50_M_ci95 = (hp.ec50_nM_ci95[0] * 1e-9, hp.ec50_nM_ci95[1] * 1e-9) if hp.ec50_nM_ci95 else None

    result = predict_concentration(payload.fluorescence, hp.bottom, hp.top, ec50_M, hp.n, ec50_M_ci95=ec50_M_ci95)

    concentration_nM = result.concentration_M * 1e9 if result.concentration_M is not None else None
    ci95_nM = None
    if result.concentration_M_ci95 is not None:
        ci95_nM = (result.concentration_M_ci95[0] * 1e9, result.concentration_M_ci95[1] * 1e9)

    payload_out = {
        "strain": payload.strain,
        "fluorescence": payload.fluorescence,
        "concentration_nM": concentration_nM,
        "concentration_nM_ci95": ci95_nM,
        "in_range": result.in_range,
        "message": result.message,
    }
    return _json_safe(payload_out)
