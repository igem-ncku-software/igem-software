from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

# ---- 臨時驗證用邏輯，尚未放進 app/hardware ----
temp_app = FastAPI()

class PingData(BaseModel):
    device_id: str
    message: str

@temp_app.post("/api/hardware/ping")
async def receive_ping(data: PingData):
    print(f"收到來自 {data.device_id} 的訊號: {data.message}")
    return {"status": "ok", "message": "後端已收到訊號"}
# ---- 臨時驗證邏輯結束 ----

client = TestClient(temp_app)


def test_receive_ping_success():
    payload = {"device_id": "esp32-test", "message": "hello from esp32"}
    response = client.post("/api/hardware/ping", json=payload)
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_receive_ping_missing_field():
    payload = {"device_id": "esp32-test"}
    response = client.post("/api/hardware/ping", json=payload)
    assert response.status_code == 422
