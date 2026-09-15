from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.dose_response.router import router as dose_response_router
from app.hardware.router import router as hardware_router


app = FastAPI(
    title="LasReader API",
    description="Backend API for LasReader: AHL dose-response analysis and hardware sensor data.",
    version="1.3.0",
)

# CORS 來源清單統一從 app/config.py 讀取（可由 .env 覆寫）
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# AHL dose-response 分析 API
app.include_router(dose_response_router)
app.include_router(hardware_router)


@app.get("/")
def root() -> dict:
    """API 根目錄，順便列出目前有哪些 endpoint 可以測試。"""
    return {
        "message": "LasReader API is running.",
        "docs": "/docs",
        "health": "/health",
        "dose_response_analyze": "POST /api/dose_response/analyze",
        "dose_response_predict": "POST /api/dose_response/predict",
        "hardware_status": "GET /api/hardware/status",
        "hardware_live": "WS /api/hardware/live",
    }


@app.get("/health")
def health_check() -> dict:
    """給前端與 Render 用來檢查後端是否正常運作。"""
    return {"status": "ok", "service": "LasReader API"}


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
