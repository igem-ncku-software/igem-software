"""
ESP32 感測器數據 API
--------------------
用來接收 ESP32 傳來的「數值型」感測數據（例如螢光強度讀值），
並提供給前端輪詢，畫成即時折線圖。

跟 esp32/upload.py（圖片 + 文字紀錄）是分開的兩支 API，
互不影響：
    POST /esp32/data        -> ESP32 上傳一筆數值
    GET  /esp32/data        -> 前端讀取最近的數值（預設回傳最近 100 筆）
    DELETE /esp32/data      -> 清空目前暫存的數據（測試用）
"""

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/esp32", tags=["esp32-data"])

# 記憶體暫存最近的數據。
# 目前先用記憶體陣列，服務重啟就會清空；
# 之後如果需要長期保存，可以改成寫入資料庫或 CSV 檔案。
_MAX_RECORDS = 500
_data_records: List["SensorReading"] = []


class SensorDataIn(BaseModel):
    """ESP32 傳來的原始數據格式（POST body）。"""

    value: float
    sensor: Optional[str] = "fluorescence"
    unit: Optional[str] = None


class SensorReading(BaseModel):
    """儲存在後端、回傳給前端使用的數據格式。"""

    value: float
    sensor: str
    unit: Optional[str] = None
    timestamp: str


@router.post("/data")
def receive_sensor_data(payload: SensorDataIn) -> dict:
    """
    接收 ESP32 傳來的感測數據。

    ESP32 端範例（HTTP POST，Content-Type: application/json）：

        POST /esp32/data
        {
            "value": 123.45,
            "sensor": "fluorescence",
            "unit": "a.u."
        }
    """
    reading = SensorReading(
        value=payload.value,
        sensor=payload.sensor or "fluorescence",
        unit=payload.unit,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )

    _data_records.append(reading)

    # 避免記憶體無限累積，只保留最近 N 筆
    if len(_data_records) > _MAX_RECORDS:
        del _data_records[: len(_data_records) - _MAX_RECORDS]

    return {"status": "ok", "received": reading}


@router.get("/data", response_model=List[SensorReading])
def get_sensor_data(limit: int = 100) -> List[SensorReading]:
    """
    回傳最近的感測數據，給前端輪詢使用。

    limit: 回傳最近幾筆，預設 100。
    """
    if limit <= 0:
        return []
    return _data_records[-limit:]


@router.delete("/data")
def clear_sensor_data() -> dict:
    """清空目前暫存的數據（測試 / 重新開始一組實驗時使用）。"""
    _data_records.clear()
    return {"status": "cleared"}
