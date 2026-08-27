"""Data adaptation layer: decouples fit_dose_response from where
(concentrations, responses) come from.

Today only SimulatedDataSource exists. When real plate-reader CSVs are
ready, a CsvDataSource implementing the same load() -> (concentrations,
responses) contract slots in without changing fitting/chart code — the
returned arrays must already be standardized ((raw - blank) / OD600).
"""

from typing import Protocol, runtime_checkable

import numpy as np

from app.dose_response.simulate import simulate_dose_response


@runtime_checkable
class DoseResponseDataSource(Protocol):
    def load(self) -> tuple[np.ndarray, np.ndarray]:
        """Return (concentrations, responses), already standardized."""
        ...


class SimulatedDataSource:
    def __init__(
        self,
        concentrations: list[float] | None = None,
        *,
        top: float,
        bottom: float,
        ec50: float,
        hill_slope: float,
        noise_sd: float = 0.0,
        n_replicates: int = 1,
        seed: int | None = None,
    ) -> None:
        self._concentrations = concentrations
        self._top = top
        self._bottom = bottom
        self._ec50 = ec50
        self._hill_slope = hill_slope
        self._noise_sd = noise_sd
        self._n_replicates = n_replicates
        self._seed = seed

    def load(self) -> tuple[np.ndarray, np.ndarray]:
        return simulate_dose_response(
            self._concentrations,
            top=self._top,
            bottom=self._bottom,
            ec50=self._ec50,
            hill_slope=self._hill_slope,
            noise_sd=self._noise_sd,
            n_replicates=self._n_replicates,
            seed=self._seed,
        )
