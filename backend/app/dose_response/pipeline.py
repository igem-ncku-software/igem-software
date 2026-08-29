"""End-to-end orchestrator: reader export -> per-strain dose-response results.

Runs io -> normalize -> timeseries -> doseresponse in sequence (spec §3's
"pipeline.py # 串起 end-to-end"). Doesn't introduce any new computation -
every step here is a direct call into an already-tested function from the
other four modules.
"""

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.dose_response.config import ExperimentConfig, load_config
from app.dose_response.doseresponse import fit_hill, flatness_test, lod_loq
from app.dose_response.io import load_plate_map, load_reader_export, to_tidy
from app.dose_response.models import hill
from app.dose_response.normalize import blank_subtract, normalize_fluorescence
from app.dose_response.timeseries import aggregate_by_condition, plateau

FIT_CURVE_POINTS = 50


@dataclass
class StrainResult:
    strain: str
    ec50_nM: float | None  # None when not responsive (spec §5.4: don't report a fake EC50)
    ec50_nM_ci95: tuple[float, float] | None
    n: float
    top: float
    bottom: float
    r_squared: float
    responsive: bool
    p_value: float
    lod_nM: float | None
    loq_nM: float | None
    plateau_points: list[tuple[float, float]]  # (concentration_nM, plateau), every tested concentration incl. 0
    fit_curve: list[tuple[float, float]] | None  # (concentration_nM, predicted F); None when not responsive


def run_pipeline(export_path: str | Path, config: ExperimentConfig | None = None) -> dict[str, StrainResult]:
    """Run the full dose-response pipeline on one reader export file.

    config defaults to config/experiment.yaml (load_config()); pass one
    explicitly to run against a different plate layout/thresholds without
    editing that file. Returns one StrainResult per strain found in the
    tidy table's role=="sample" rows.
    """
    config = config or load_config()

    raw = load_reader_export(export_path)
    plate_map = load_plate_map(config)
    tidy = to_tidy(raw, plate_map)
    blank_subtracted = blank_subtract(tidy)
    normalized = normalize_fluorescence(blank_subtracted, od_min=config.thresholds.od_min)

    sample = normalized[normalized["role"] == "sample"]
    strains = sorted(sample["strain"].dropna().unique())
    concentrations_M = sorted(sample["concentration_M"].dropna().unique())

    results: dict[str, StrainResult] = {}
    for strain in strains:
        plateaus = []
        for conc in concentrations_M:
            agg = aggregate_by_condition(normalized, strain, conc)
            value, _ = plateau(agg["time_h"].to_numpy(), agg["F_mean"].to_numpy())
            plateaus.append(value)

        conc_arr = np.array(concentrations_M)
        plateau_arr = np.array(plateaus)
        positive_mask = conc_arr > 0

        fit = fit_hill(conc_arr, plateau_arr)
        flat = flatness_test(fit, plateau_arr[positive_mask])
        lod = lod_loq(normalized, strain)

        ec50_nM = fit.ec50_M * 1e9 if flat.responsive else None
        ci95_nM = None
        if flat.responsive and fit.ec50_M_ci95 is not None:
            ci95_nM = (fit.ec50_M_ci95[0] * 1e9, fit.ec50_M_ci95[1] * 1e9)

        plateau_points = [(float(c) * 1e9, float(p)) for c, p in zip(conc_arr, plateau_arr)]

        fit_curve = None
        if flat.responsive and positive_mask.any():
            x_M = np.logspace(np.log10(conc_arr[positive_mask].min()), np.log10(conc_arr[positive_mask].max()), FIT_CURVE_POINTS)
            y = hill(x_M, fit.bottom, fit.top, fit.ec50_M, fit.n)
            fit_curve = [(float(x) * 1e9, float(v)) for x, v in zip(x_M, y)]

        results[strain] = StrainResult(
            strain=strain,
            ec50_nM=ec50_nM,
            ec50_nM_ci95=ci95_nM,
            n=fit.n,
            top=fit.top,
            bottom=fit.bottom,
            r_squared=fit.r_squared,
            responsive=flat.responsive,
            p_value=flat.p_value,
            lod_nM=lod.lod_nM,
            loq_nM=lod.loq_nM,
            plateau_points=plateau_points,
            fit_curve=fit_curve,
        )

    return results
