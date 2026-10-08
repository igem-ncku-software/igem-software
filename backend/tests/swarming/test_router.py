import struct
import zlib

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


PNG_SIGNATURE = bytes([0x89]) + b"PNG" + bytes([0x0D, 0x0A, 0x1A, 0x0A])


def png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def png_header(width: int, height: int) -> bytes:
    """A PNG that claims a size but holds no pixel data: OpenCV reads the size, then the cap
    must refuse it before any decoding."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (PNG_SIGNATURE + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", zlib.compress(b""))
            + png_chunk(b"IEND", b""))


def test_a_photo_over_the_pixel_cap_is_refused_from_its_header():
    # 64 MP: OpenCV must refuse it before decoding, which only works if the cap was set
    # before cv2 loaded (app/swarming/__init__.py).
    res = post(png_header(8000, 8000))
    assert res.status_code == 413
    assert res.json()["detail"] == "The photo has more than 50 megapixels."


def test_the_plate_diameter_must_be_positive():
    assert post(b"not an image", dish_diameter_mm="0").status_code == 422


def test_a_missing_file_is_refused():
    assert client.post("/api/swarming/analyze").status_code == 422
