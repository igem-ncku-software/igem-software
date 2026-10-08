import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app.swarming.analysis import ANALYSIS_MAX_WIDTH_PX, fit_width
from app.swarming.router import MAX_UPLOAD_BYTES

client = TestClient(app)


def post(data: bytes, **form):
    return client.post("/api/swarming/analyze", files={"file": ("plate.png", data, "image/png")}, data=form)


def test_a_file_that_is_not_an_image_says_so_in_words():
    res = post(b"not an image")
    assert res.status_code == 400
    assert res.json()["detail"] == "The file could not be read as an image."


def test_a_photo_over_the_limit_is_refused_before_decoding():
    res = post(b"\0" * (MAX_UPLOAD_BYTES + 1))
    assert res.status_code == 413
    assert res.json()["detail"] == "The photo is larger than 20 MB."


def test_the_plate_diameter_must_be_positive():
    assert post(b"not an image", dish_diameter_mm="0").status_code == 422


def test_a_missing_file_is_refused():
    assert client.post("/api/swarming/analyze").status_code == 422


def test_a_wide_photo_is_shrunk_to_the_analysis_width_keeping_its_shape():
    # Only the array's shape matters here: no photo, no analysis.
    shrunk = fit_width(np.zeros((4032, 3024, 3), np.uint8))
    assert shrunk.shape == (1600, ANALYSIS_MAX_WIDTH_PX, 3)


def test_a_photo_no_wider_than_the_analysis_width_is_left_as_it_is():
    img = np.zeros((900, ANALYSIS_MAX_WIDTH_PX, 3), np.uint8)
    assert fit_width(img) is img
