from fastapi.testclient import TestClient

from app.main import app
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
