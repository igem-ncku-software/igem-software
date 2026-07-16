from fastapi import APIRouter, UploadFile, Form, File
from fastapi.responses import FileResponse
import time
import uuid
import os

from .config import UPLOAD_DIR
from .storage import load_records, save_records

router = APIRouter(prefix="/esp32", tags=["esp32"])

@router.post("/upload")
async def upload(text: str = Form(""), image: UploadFile = File(None)):
    image_filename = None
    if image:
        ext = os.path.splitext(image.filename)[1] or ".jpg"
        image_filename = f"{uuid.uuid4().hex}{ext}"
        file_path = os.path.join(UPLOAD_DIR, image_filename)
        with open(file_path, "wb") as f:
            f.write(await image.read())

    record = {
        "id": uuid.uuid4().hex,
        "text": text,
        "image": image_filename,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    records = load_records()
    records.insert(0, record)
    save_records(records)

    return {"status": "ok", "record": record}

@router.get("/records")
def get_records():
    return load_records()

@router.get("/uploads/{filename}")
def get_image(filename: str):
    return FileResponse(os.path.join(UPLOAD_DIR, filename))
