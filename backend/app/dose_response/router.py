import math

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.dose_response.chart_data import to_chart_data
from app.dose_response.fitting import fit_dose_response
from app.dose_response.simulate import simulate_dose_response

router = APIRouter(prefix="/api/dose_response", tags=["dose_response"])


class FitRequest(BaseModel):
    concentrations: list[float]
    responses: list[float]
    fix_bottom: float | None = None


class SimulateRequest(BaseModel):
    concentrations: list[float] | None = None
    top: float
    bottom: float
    ec50: float
    hill_slope: float
    noise_sd: float = 0.0
    n_replicates: int = 1
    seed: int | None = None


def _json_safe(value):
    """Replace NaN with None so the response is valid JSON (FastAPI's
    default encoder rejects NaN outright)."""

    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, dict):
        return {key: _json_safe(v) for key, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


@router.post("/fit")
async def analyze_fit(payload: FitRequest) -> dict:
    """擬合 4PL 劑量反應曲線，回傳參數與 Chart.js 用的資料。"""

    if not payload.concentrations:
        raise HTTPException(status_code=400, detail="No data points provided.")

    try:
        result = fit_dose_response(
            payload.concentrations,
            payload.responses,
            fix_bottom=payload.fix_bottom,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    chart = to_chart_data(payload.concentrations, payload.responses, result)

    return _json_safe(
        {
            "params": result.params,
            "param_stderr": result.param_stderr,
            "param_ci95": result.param_ci95,
            "r_squared": result.r_squared,
            "converged": result.converged,
            "warnings": result.warnings,
            "chart_data": chart,
        }
    )


@router.post("/simulate")
async def generate_simulated_data(payload: SimulateRequest) -> dict:
    """產生模擬濃度-螢光資料，供真實資料尚未到位時測試分析流程。"""

    try:
        concentrations, responses = simulate_dose_response(
            payload.concentrations,
            top=payload.top,
            bottom=payload.bottom,
            ec50=payload.ec50,
            hill_slope=payload.hill_slope,
            noise_sd=payload.noise_sd,
            n_replicates=payload.n_replicates,
            seed=payload.seed,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return {
        "concentrations": concentrations.tolist(),
        "responses": responses.tolist(),
    }
