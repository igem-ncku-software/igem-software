import numpy as np
import pytest

from app.dose_response.model import four_pl
from app.dose_response.simulate import DEFAULT_CONCENTRATIONS_NM, simulate_dose_response


PARAMS = dict(top=100.0, bottom=5.0, ec50=50.0, hill_slope=1.5)


def test_default_concentrations_used_when_none_given():
    x, y = simulate_dose_response(**PARAMS, seed=0)
    assert list(x) == DEFAULT_CONCENTRATIONS_NM


def test_no_noise_matches_four_pl_exactly():
    concentrations = [0.0, 10.0, 50.0, 1000.0]
    x, y = simulate_dose_response(concentrations, **PARAMS, noise_sd=0.0)

    expected = four_pl(np.array(concentrations), **PARAMS)
    np.testing.assert_allclose(y, expected)


def test_replicates_expand_concentration_array():
    concentrations = [0.0, 10.0, 100.0]
    x, y = simulate_dose_response(concentrations, **PARAMS, n_replicates=3, seed=1)

    assert len(x) == len(concentrations) * 3
    assert sorted(x) == sorted(concentrations * 3)


def test_seed_is_reproducible():
    x1, y1 = simulate_dose_response(**PARAMS, noise_sd=2.0, n_replicates=3, seed=42)
    x2, y2 = simulate_dose_response(**PARAMS, noise_sd=2.0, n_replicates=3, seed=42)

    np.testing.assert_array_equal(y1, y2)


def test_different_seeds_differ():
    x1, y1 = simulate_dose_response(**PARAMS, noise_sd=2.0, n_replicates=3, seed=1)
    x2, y2 = simulate_dose_response(**PARAMS, noise_sd=2.0, n_replicates=3, seed=2)

    assert not np.allclose(y1, y2)


def test_invalid_replicates_raises():
    with pytest.raises(ValueError):
        simulate_dose_response(**PARAMS, n_replicates=0)
