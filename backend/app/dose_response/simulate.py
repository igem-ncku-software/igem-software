"""Simulated dose-response data generator.

Used to build and test the fitting pipeline before real plate-reader
data is available. Downstream code should not care whether
(concentrations, responses) came from here or from a real CSV.
"""

import numpy as np

from app.dose_response.model import four_pl

# Team's planned concentration gradient: 0, 1nM, 10nM, 100nM, 1uM, 10uM.
DEFAULT_CONCENTRATIONS_NM = [0.0, 1.0, 10.0, 100.0, 1_000.0, 10_000.0]


def simulate_dose_response(
    concentrations: list[float] | None = None,
    *,
    top: float,
    bottom: float,
    ec50: float,
    hill_slope: float,
    noise_sd: float = 0.0,
    n_replicates: int = 1,
    seed: int | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Generate fake (concentrations, responses) data points from known 4PL params.

    Each concentration is repeated `n_replicates` times, and independent
    Gaussian noise (sd=noise_sd) is added to each replicate's response.
    """

    if concentrations is None:
        concentrations = DEFAULT_CONCENTRATIONS_NM

    if n_replicates < 1:
        raise ValueError("n_replicates must be at least 1")

    rng = np.random.default_rng(seed)

    x = np.repeat(np.asarray(concentrations, dtype=float), n_replicates)
    clean_response = four_pl(x, top, bottom, ec50, hill_slope)
    noise = rng.normal(loc=0.0, scale=noise_sd, size=x.shape) if noise_sd > 0 else 0.0

    return x, clean_response + noise
