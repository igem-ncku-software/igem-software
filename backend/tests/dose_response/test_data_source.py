import numpy as np

from app.dose_response.data_source import DoseResponseDataSource, SimulatedDataSource
from app.dose_response.fitting import fit_dose_response
from app.dose_response.simulate import DEFAULT_CONCENTRATIONS_NM, simulate_dose_response


TRUE_PARAMS = dict(top=100.0, bottom=5.0, ec50=50.0, hill_slope=1.5)


def test_load_matches_simulate_dose_response_directly():
    source = SimulatedDataSource(
        DEFAULT_CONCENTRATIONS_NM, **TRUE_PARAMS, noise_sd=1.0, n_replicates=2, seed=7
    )
    x1, y1 = source.load()
    x2, y2 = simulate_dose_response(
        DEFAULT_CONCENTRATIONS_NM, **TRUE_PARAMS, noise_sd=1.0, n_replicates=2, seed=7
    )

    np.testing.assert_array_equal(x1, x2)
    np.testing.assert_array_equal(y1, y2)


def test_satisfies_data_source_protocol():
    source: DoseResponseDataSource = SimulatedDataSource(**TRUE_PARAMS, seed=1)
    assert isinstance(source, DoseResponseDataSource)


def test_load_output_feeds_directly_into_fit_dose_response():
    source = SimulatedDataSource(
        DEFAULT_CONCENTRATIONS_NM, **TRUE_PARAMS, noise_sd=0.5, n_replicates=4, seed=3
    )
    x, y = source.load()

    result = fit_dose_response(x, y)

    assert result.converged
