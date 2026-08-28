"""Pure math for dose-response analysis (spec docs/dose_response_model_spec.md §5).

No data I/O or fitting here - these functions take/return plain arrays so
they can be unit-tested with synthetic data alone (§9).
"""

import numpy as np


def hill(
    A: np.ndarray | float,
    bottom: float,
    top: float,
    ec50: float,
    n: float,
) -> np.ndarray | float:
    """Activation Hill equation (spec §5.3): F([A]) = bottom + (top-bottom)*A^n/(EC50^n+A^n).

    A=0 needs no special-casing: A**n is 0 for n>0, so the fraction is
    exactly 0 and F(0) == bottom without any divide-by-zero.
    """
    A = np.asarray(A, dtype=float)
    A_n = A**n
    result = bottom + (top - bottom) * A_n / (ec50**n + A_n)
    return result if result.ndim else float(result)


def logistic_time(
    t: np.ndarray | float,
    f0: float,
    fmax: float,
    r: float,
    t0: float,
) -> np.ndarray | float:
    """Pseudo-time logistic (spec §5.2): F(t) = f0 + (fmax-f0)/(1+exp(-r*(t-t0)))."""
    t = np.asarray(t, dtype=float)
    with np.errstate(over="ignore"):
        result = f0 + (fmax - f0) / (1.0 + np.exp(-r * (t - t0)))
    return result if result.ndim else float(result)
