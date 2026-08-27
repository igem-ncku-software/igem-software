"""4-parameter logistic (4PL) dose-response model."""

import numpy as np


def four_pl(
    x: np.ndarray | float,
    top: float,
    bottom: float,
    ec50: float,
    hill_slope: float,
) -> np.ndarray | float:
    """F(x) = Bottom + (Top - Bottom) / (1 + (EC50 / x) ** HillSlope)

    x=0 is not special-cased: EC50/0 -> inf (via numpy's float division),
    which drives the fraction to 0, so F(0) naturally converges to Bottom
    as long as ec50 > 0 and hill_slope > 0.
    """

    x = np.asarray(x, dtype=float)

    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = (ec50 / x) ** hill_slope
        result = bottom + (top - bottom) / (1 + ratio)

    result = np.where(x == 0, bottom, result)

    return result if result.ndim else float(result)
