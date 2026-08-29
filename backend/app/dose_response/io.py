"""Reader-export parsing and tidy-table assembly (spec docs/dose_response_model_spec.md §4).

Adapter pattern (§4.2): load_reader_export() is the only function that knows
the SpectraMax ASCII export's line-by-line syntax. Everything downstream
(to_tidy() and later modules) works on well/time_h/RFU/OD600 rows, so a
future second instrument only needs its own load_*_export() parser.
"""

import re
from pathlib import Path

import numpy as np
import pandas as pd

from app.dose_response.config import ExperimentConfig, load_config

_TIME_RE = re.compile(r"^Time\s+(\d+):(\d+):(\d+)")
_ROW_LETTERS = {"A", "B", "C", "D", "E", "F", "G", "H"}

# The file's own block labels ("Plate:\t<label>\t...") don't match the tidy
# schema's column names (§4.1), so map them explicitly. This is specific to
# the SpectraMax export's own vocabulary, not an experiment-design setting,
# so it stays a code constant rather than moving to experiment.yaml.
_PLATE_LABEL_TO_MEASUREMENT = {
    "GFP_fluorescence": "RFU",
    "OD600": "OD600",
}

# Design v.1 plate map (§1): row -> AHL concentration, column -> strain.
# Loaded from config/experiment.yaml (§7) - see load_plate_map().
_CONFIG = load_config()


def load_reader_export(path: str | Path) -> pd.DataFrame:
    """Parse one SpectraMax M2/M2e ASCII export (§4.2).

    Format: 1+ "Plate:" blocks (one per measurement type), each a series of
    "Time HH:MM:SS" 8x12 matrices (row letter x column number), terminated by
    "~End". Empty cells (unused wells, e.g. columns 10-12 in the design v.1
    layout) are dropped rather than turned into NaN rows.

    Returns one row per populated well x time_h, columns: well, time_h, and
    one column per measurement type found in the file (e.g. RFU, OD600).
    """
    lines = Path(path).read_text(encoding="utf-8").splitlines()

    long_rows: list[tuple[str, float, str, float]] = []
    measurement: str | None = None
    time_h: float | None = None

    for line in lines:
        stripped = line.strip()

        if stripped.startswith("Plate:"):
            fields = line.split("\t")
            label = fields[1].strip() if len(fields) > 1 else ""
            measurement = _PLATE_LABEL_TO_MEASUREMENT.get(label, label)
            continue

        if stripped == "~End":
            measurement = None
            time_h = None
            continue

        time_match = _TIME_RE.match(stripped)
        if time_match:
            hh, mm, ss = (int(group) for group in time_match.groups())
            time_h = hh + mm / 60 + ss / 3600
            continue

        if not stripped or measurement is None or time_h is None:
            continue

        cells = line.split("\t")
        row_letter = cells[0].strip()
        if row_letter not in _ROW_LETTERS:
            continue  # not a data row (e.g. the "\t1\t2\t...\t12" column header)

        for col_idx, raw_value in enumerate(cells[1:13], start=1):
            raw_value = raw_value.strip()
            if not raw_value:
                continue
            well = f"{row_letter}{col_idx}"
            long_rows.append((well, time_h, measurement, float(raw_value)))

    long_df = pd.DataFrame(long_rows, columns=["well", "time_h", "measurement", "value"])
    wide = long_df.pivot(index=["well", "time_h"], columns="measurement", values="value")
    wide = wide.reset_index()
    wide.columns.name = None
    return wide


def load_plate_map(config: ExperimentConfig | None = None) -> dict[str, dict]:
    """Design v.1 plate map (spec §1 / §7's experiment.yaml), expanded to a
    per-well lookup table.

    config defaults to this module's own load_config() call (the shipped
    config/experiment.yaml) - pass one explicitly (e.g. from pipeline.py) to
    run against a different plate layout without touching this file.
    """
    config = config or _CONFIG
    strain_columns = config.strains
    col_to_strain = {col: strain for strain, cols in strain_columns.items() for col in cols}
    plate_map: dict[str, dict] = {}

    for row_letter, concentration_M in config.concentrations_M.items():
        for col, strain in col_to_strain.items():
            well = f"{row_letter}{col}"
            plate_map[well] = {
                "strain": strain,
                "concentration_M": concentration_M,
                "replicate": strain_columns[strain].index(col) + 1,
                "role": "sample",
            }

    for col, strain in col_to_strain.items():
        well = f"{config.roles.blank_row}{col}"
        plate_map[well] = {
            "strain": strain,
            "concentration_M": np.nan,
            "replicate": strain_columns[strain].index(col) + 1,
            "role": "blank",
        }

    for replicate, well in enumerate(config.roles.positive_wells, start=1):
        plate_map[well] = {
            "strain": None,
            "concentration_M": np.nan,
            "replicate": replicate,
            "role": "positive",
        }

    return plate_map


def to_tidy(raw: pd.DataFrame, plate_map: dict[str, dict]) -> pd.DataFrame:
    """Attach plate-map metadata to parsed reader data to build the §4.1 tidy table.

    raw: output of load_reader_export() - one row per well x time_h.
    plate_map: well -> {strain, concentration_M, replicate, role}, e.g. from
    load_plate_map(). Wells present in raw but absent from plate_map (not
    part of the experimental design) are dropped.
    """
    records = []
    for row in raw.itertuples(index=False):
        meta = plate_map.get(row.well)
        if meta is None:
            continue
        records.append(
            {
                "strain": meta["strain"],
                "concentration_M": meta["concentration_M"],
                "replicate": meta["replicate"],
                "time_h": row.time_h,
                "RFU": getattr(row, "RFU", np.nan),
                "OD600": getattr(row, "OD600", np.nan),
                "well": row.well,
                "role": meta["role"],
            }
        )

    columns = ["strain", "concentration_M", "replicate", "time_h", "RFU", "OD600", "well", "role"]
    return pd.DataFrame.from_records(records, columns=columns)
