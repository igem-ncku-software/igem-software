from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.fluorescence.router import router as fluorescence_router

# TODO: hardware（原 esp32）模組搬移到 app/hardware/ 之後，
# 取消下面這行註解，並把對應的 include_router 也打開。
# from app.hardware.router import router as esp32_data_router


app = FastAPI(
    title="iGEM Analyzer API",
    description="Backend API for ESP32 sensor data and fluorescence analysis.",
    version="1.2.0",
)

# CORS 來源清單統一從 app/config.py 讀取（可由 .env 覆寫）
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Fluorescence CSV 分析 API（保留原功能，搬到 app/fluorescence/）
app.include_router(fluorescence_router)

# ESP32 感測數值 API（等 hardware 模組搬移完成後再打開）
# app.include_router(esp32_data_router)


@app.get("/")
def root() -> dict:
    """API 根目錄，順便列出目前有哪些 endpoint 可以測試。"""
    return {
        "message": "iGEM Analyzer API is running.",
        "docs": "/docs",
        "health": "/health",
        "fluorescence_analyze": "POST /api/fluorescence/analyze",
    }


@app.get("/health")
def health_check() -> dict:
    """給前端與 Render 用來檢查後端是否正常運作。"""
    return {"status": "ok", "service": "iGEM Analyzer API"}


# 本機測試：
# 1. 進入 backend 資料夾
# 2. 執行 uvicorn app.main:app --reload
#
# 注意：因為 main.py 現在是 app 這個套件裡的模組，
# 不能再直接用 `python main.py` 或 `uvicorn main:app` 執行，
# 一律要用 `app.main:app` 這個路徑。
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
