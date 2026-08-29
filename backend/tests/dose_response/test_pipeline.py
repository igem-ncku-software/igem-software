from pathlib import Path

import pytest

from app.dose_response.pipeline import run_pipeline

FIXTURE = Path(__file__).parent / "fixtures" / "simulated_spectramax_export.txt"

# Built into the simulated fixture (approximate - the pipeline's own fitted
# values are ~100.1/288.1/50.4 nM; this integration test only checks the
# whole pipeline lands in the right ballpark end-to-end, not exact recovery
# - that precision is already covered by test_doseresponse.py's unit tests).
TRUE_EC50_NM = {"TOP10": 100.0, "DH5α": 300.0, "BL21": 50.0}


def test_run_pipeline_recovers_known_ec50s_end_to_end():
    results = run_pipeline(FIXTURE)

    assert set(results) == set(TRUE_EC50_NM)

    for strain, true_ec50 in TRUE_EC50_NM.items():
        result = results[strain]
        assert result.responsive
        assert result.ec50_nM == pytest.approx(true_ec50, rel=0.20)


def test_run_pipeline_result_shape_is_sane_for_every_strain():
    results = run_pipeline(FIXTURE)

    for result in results.values():
        assert 0.5 <= result.n <= 4.0
        assert result.top > result.bottom
        assert result.r_squared > 0.99
        assert result.ec50_nM_ci95 is not None
        lo, hi = result.ec50_nM_ci95
        assert lo < result.ec50_nM < hi
        assert result.lod_nM is not None
        assert result.loq_nM is not None
        assert result.loq_nM >= result.lod_nM
