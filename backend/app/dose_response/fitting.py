"""Nonlinear least-squares fitting of the 4PL dose-response model."""

import warnings as warnings_module
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import OptimizeWarning, curve_fit
from scipy.stats import ConstantInputWarning as SpearmanRConstantInputWarning
from scipy.stats import spearmanr
from scipy.stats import t as t_dist

from app.dose_response.model import four_pl

MIN_DISTINCT_CONCENTRATIONS = 4
EC50_CI_ORDERS_OF_MAGNITUDE_WARNING_THRESHOLD = 1.0


@dataclass
class FitResult:
    params: dict[str, float]
    param_stderr: dict[str, float] | None
    param_ci95: dict[str, tuple[float, float]] | None
    r_squared: float
    converged: bool
    warnings: list[str] = field(default_factory=list)

    def predict(self, x: np.ndarray | float) -> np.ndarray | float:
        return four_pl(
            x,
            top=self.params["top"],
            bottom=self.params["bottom"],
            ec50=self.params["ec50"],
            hill_slope=self.params["hill_slope"],
        )


def _initial_guess(
    concentrations: np.ndarray,
    responses: np.ndarray,
    fix_bottom: float | None,
) -> dict[str, float]:
    lowest = concentrations == concentrations.min()
    highest = concentrations == concentrations.max()

    bottom = fix_bottom if fix_bottom is not None else float(responses[lowest].mean())
    top = float(responses[highest].mean())

    positive = concentrations[concentrations > 0]
    if positive.size > 0:
        ec50 = float(np.sqrt(positive.min() * positive.max()))
    else:
        ec50 = 1.0

    return {"top": top, "bottom": bottom, "ec50": ec50, "hill_slope": 1.0}


def _check_increasing_trend(concentrations: np.ndarray, responses: np.ndarray) -> bool:
    """Check the *overall* concentration-response trend is positive.

    Uses Spearman correlation across all individual points rather than
    comparing adjacent group means: with few replicates, ordinary noise
    routinely makes one group's mean dip below the previous group's,
    especially near the flat Bottom of the curve — that's not signal
    quenching, and flagging it on every noisy-but-fine dataset would make
    the warning meaningless.
    """

    if np.unique(concentrations).size < 2:
        return True

    with warnings_module.catch_warnings():
        warnings_module.simplefilter("ignore", SpearmanRConstantInputWarning)
        rho, _ = spearmanr(concentrations, responses)

    return bool(rho > 0)


def fit_dose_response(
    concentrations: list[float] | np.ndarray,
    responses: list[float] | np.ndarray,
    *,
    fix_bottom: float | None = None,
    initial_guess: dict[str, float] | None = None,
) -> FitResult:
    x = np.asarray(concentrations, dtype=float)
    y = np.asarray(responses, dtype=float)

    if x.shape != y.shape:
        raise ValueError("concentrations and responses must have the same length")

    warning_messages: list[str] = []

    n_distinct = np.unique(x).size
    if n_distinct < MIN_DISTINCT_CONCENTRATIONS:
        warning_messages.append(
            f"Only {n_distinct} distinct concentration(s); at least "
            f"{MIN_DISTINCT_CONCENTRATIONS} are recommended to constrain 4 parameters."
        )

    if not _check_increasing_trend(x, y):
        warning_messages.append(
            "Response does not show an overall increasing trend with "
            "concentration (possible signal quenching / metabolic "
            "inhibition) - fit results below may not be meaningful."
        )

    guess = _initial_guess(x, y, fix_bottom)
    if initial_guess:
        guess.update(initial_guess)

    if fix_bottom is not None:

        def model(x_val, top, ec50, hill_slope):
            return four_pl(x_val, top, fix_bottom, ec50, hill_slope)

        p0 = [guess["top"], guess["ec50"], guess["hill_slope"]]
        param_names = ["top", "ec50", "hill_slope"]
    else:

        def model(x_val, top, bottom, ec50, hill_slope):
            return four_pl(x_val, top, bottom, ec50, hill_slope)

        p0 = [guess["top"], guess["bottom"], guess["ec50"], guess["hill_slope"]]
        param_names = ["top", "bottom", "ec50", "hill_slope"]

    if x.size < len(p0):
        warning_messages.append(
            f"Only {x.size} data point(s) for {len(p0)} free parameters; "
            "not enough data to attempt a fit."
        )
        return FitResult(
            params={**dict(zip(param_names, p0)), **({"bottom": fix_bottom} if fix_bottom is not None else {})},
            param_stderr=None,
            param_ci95=None,
            r_squared=float("nan"),
            converged=False,
            warnings=warning_messages,
        )

    try:
        with warnings_module.catch_warnings():
            warnings_module.simplefilter("ignore", OptimizeWarning)
            popt, pcov = curve_fit(model, x, y, p0=p0, maxfev=10_000)
        converged = True
    except RuntimeError as error:
        warning_messages.append(f"Fit did not converge: {error}")
        return FitResult(
            params={**dict(zip(param_names, p0)), **({"bottom": fix_bottom} if fix_bottom is not None else {})},
            param_stderr=None,
            param_ci95=None,
            r_squared=float("nan"),
            converged=False,
            warnings=warning_messages,
        )

    params = dict(zip(param_names, popt))
    if fix_bottom is not None:
        params["bottom"] = fix_bottom

    n_params_fit = len(popt)
    dof = max(len(x) - n_params_fit, 1)
    perr = np.sqrt(np.diag(pcov))

    if np.all(np.isfinite(perr)):
        t_value = t_dist.ppf(0.975, dof)

        param_stderr = dict(zip(param_names, perr))
        param_ci95 = {
            name: (float(value - t_value * err), float(value + t_value * err))
            for name, value, err in zip(param_names, popt, perr)
        }
        if fix_bottom is not None:
            param_stderr["bottom"] = 0.0
            param_ci95["bottom"] = (fix_bottom, fix_bottom)

        ec50_ci = param_ci95["ec50"]
        if ec50_ci[0] > 0 and ec50_ci[1] > 0:
            ci_span_orders = np.log10(ec50_ci[1] / ec50_ci[0])
            if ci_span_orders > EC50_CI_ORDERS_OF_MAGNITUDE_WARNING_THRESHOLD:
                warning_messages.append(
                    "EC50 95% CI spans more than one order of magnitude - the "
                    "concentration gradient likely does not cover the curve's "
                    "transition region. Consider testing intermediate concentrations."
                )
    else:
        param_stderr = None
        param_ci95 = None
        warning_messages.append(
            "Parameter uncertainty could not be estimated (covariance matrix "
            "is singular) - treat this fit as underdetermined."
        )

    y_pred = model(x, *popt)
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")

    return FitResult(
        params={name: float(value) for name, value in params.items()},
        param_stderr=(
            {name: float(value) for name, value in param_stderr.items()}
            if param_stderr is not None
            else None
        ),
        param_ci95=param_ci95,
        r_squared=r_squared,
        converged=converged,
        warnings=warning_messages,
    )
