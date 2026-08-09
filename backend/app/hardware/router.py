from fastapi import APIRouter
from pydantic import BaseModel
from datetime import datetime

# 這個 router 的路徑要跟 main.py 裡宣告的一致：
#   POST /api/hardware/upload
#   GET  /api/hardware/latest
router = APIRouter(prefix="/api/hardware", tags=["hardware"])

# 先用記憶體變數存最新資料（之後要接資料庫/歷史紀錄再換成 DB）
latest_data: dict = {
    "device_id": None,
    "value": None,
    "unit": None,
    "received_at": None,
}


class SensorPayload(BaseModel):
    device_id: str
    value: float
    unit: str = "a.u."


@router.post("/upload")
async def upload_data(payload: SensorPayload):
    """ESP32 打這支 API 上傳模擬感測數值"""
    latest_data["device_id"] = payload.device_id
    latest_data["value"] = payload.value
    latest_data["unit"] = payload.unit
    latest_data["received_at"] = datetime.utcnow().isoformat() + "Z"

    print(f"[hardware] 收到資料: {latest_data}")
    return {"status": "ok", "received": latest_data}


@router.get("/latest")
async def get_latest_data():
    """前端打這支 API 拿最新數值"""
    return latest_data
