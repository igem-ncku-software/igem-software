from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from esp32.data import router as esp32_data_router

# 如果你的 fluorescence 資料夾還在，就保留這行；
# 如果暫時也想拿掉先求後端能跑起來，把這兩行註解掉即可。
from fluorescence.router import router as fluorescence_router


app = FastAPI(
    title="iGEM Analyzer API",
    description="Backend API for ESP32 sensor data and fluorescence analysis.",
    version="1.2.0",
)

# CORS：
# - GitHub Pages：正式前端
# - localhost：本機開發測試
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://igem-ncku-software.github.io",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ESP32 感測數值 API（最小可跑測試用）
# POST /esp32/data   -> ESP32 上傳一筆數值
# GET  /esp32/data   -> 讀取最近數值，確認有沒有收到
app.include_router(esp32_data_router)

# Fluorescence CSV 分析 API（保留原功能）
app.include_router(fluorescence_router)


@app.get("/")
def root() -> dict:
    """API 根目錄，順便列出目前有哪些 endpoint 可以測試。"""
    return {
        "message": "iGEM Analyzer API is running.",
        "docs": "/docs",
        "health": "/health",
        "esp32_data_post": "POST /esp32/data",
        "esp32_data_get": "GET /esp32/data",
    }


@app.get("/health")
def health_check() -> dict:
    """給前端與 Render 用來檢查後端是否正常運作。"""
    return {"status": "ok", "service": "iGEM Analyzer API"}


# 本機測試：
# 1. 進入 backend 資料夾
# 2. 執行 python main.py
#
# 或使用：
# uvicorn main:app --reload
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
