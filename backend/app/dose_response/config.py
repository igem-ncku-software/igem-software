"""Loads config/experiment.yaml: the plate map and tunable thresholds (spec §7).

io.py/normalize.py/timeseries.py/doseresponse.py each load this once at
import time and use it for the default values that used to be hardcoded
literals - see the module-level _CONFIG in each of those files.
"""

from dataclasses import dataclass
from pathlib import Path

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).parent / "config" / "experiment.yaml"


@dataclass
class FluorescenceConfig:
    ex_nm: float
    em_nm: float


@dataclass
class RolesConfig:
    blank_row: str
    positive_wells: tuple[str, ...]


@dataclass
class ThresholdsConfig:
    od_min: float
    onset_k_sd: float
    cv_max: float
    growth_inhibition_frac: float


@dataclass
class HillConfig:
    n_bounds: tuple[float, float]


@dataclass
class ExperimentConfig:
    fluorescence: FluorescenceConfig
    read_interval_h: float
    concentrations_M: dict[str, float]
    strains: dict[str, tuple[int, ...]]
    roles: RolesConfig
    thresholds: ThresholdsConfig
    hill: HillConfig


def load_config(path: str | Path = DEFAULT_CONFIG_PATH) -> ExperimentConfig:
    """Parse experiment.yaml into an ExperimentConfig. Defaults to the file
    shipped alongside this module (config/experiment.yaml)."""
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    return ExperimentConfig(
        fluorescence=FluorescenceConfig(**raw["fluorescence"]),
        read_interval_h=raw["read_interval_h"],
        concentrations_M=dict(raw["concentrations_M"]),
        strains={strain: tuple(cols) for strain, cols in raw["strains"].items()},
        roles=RolesConfig(
            blank_row=raw["roles"]["blank_row"],
            positive_wells=tuple(raw["roles"]["positive_wells"]),
        ),
        thresholds=ThresholdsConfig(**raw["thresholds"]),
        hill=HillConfig(n_bounds=tuple(raw["hill"]["n_bounds"])),
    )
