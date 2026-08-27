"""Build Chart.js-friendly data from a dose-response fit.

Kept separate from the fitting math so the frontend payload shape can
change without touching fit_dose_response.
"""

import numpy as np

from app.dose_response.fitting import FitResult


def to_chart_data(
    concentrations: list[float] | np.ndarray,
    responses: list[float] | np.ndarray,
    fit_result: FitResult,
    *,
    n_curve_points: int = 100,
) -> dict:
    """Return raw scatter points, a smooth fitted curve, and the EC50 marker.

    The curve is sampled log-spaced across the observed concentration range
    (plus x=0, evaluated separately since log(0) is undefined) so it renders
    smoothly on a log-x axis.
    """

    x = np.asarray(concentrations, dtype=float)
    y = np.asarray(responses, dtype=float)

    scatter = [{"x": float(xi), "y": float(yi)} for xi, yi in zip(x, y)]

    positive_x = x[x > 0]
    curve: list[dict[str, float]] = [{"x": 0.0, "y": float(fit_result.predict(0.0))}]

    if positive_x.size > 0:
        log_min, log_max = np.log10(positive_x.min()), np.log10(positive_x.max())
        curve_x = np.logspace(log_min, log_max, n_curve_points)
        curve_y = fit_result.predict(curve_x)
        curve.extend({"x": float(xi), "y": float(yi)} for xi, yi in zip(curve_x, curve_y))

    return {
        "scatter": scatter,
        "curve": curve,
        "ec50": fit_result.params["ec50"],
        "params": fit_result.params,
        "r_squared": fit_result.r_squared,
        "converged": fit_result.converged,
        "warnings": fit_result.warnings,
    }
