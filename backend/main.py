from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from esp32.upload import router as esp32_router
from fluorescence.router import router as fluorescence_router


app = FastAPI(
    title="iGEM Analyzer API",
    description="Backend API for ESP32 image upload and fluorescence data analysis.",
    version="1.0.0",
)


# CORS：
# - GitHub Pages：正式前端
# - localhost / 127.0.0.1：本機開發測試
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


# ESP32 API
# 例如：
# /esp32/upload
# /esp32/records
# /esp32/uploads/{filename}
app.include_router(esp32_router)


# Fluorescence analysis API
# POST /api/fluorescence/analyze
app.include_router(fluorescence_router)


@app.get("/")
def root() -> dict:
    """API 根目錄。"""
    return {
        "message": "iGEM Analyzer API is running.",
        "docs": "/docs",
        "health": "/health",
        "fluorescence_analysis": "/api/fluorescence/analyze",
    }


@app.get("/health")
def health_check() -> dict:
    """給前端與 Render 用來檢查後端是否正常運作。"""
    return {
        "status": "ok",
        "service": "iGEM Analyzer API",
    }


@app.post("/api/analyze")
async def analyze(
    text: Optional[str] = Form(default=""),
    image: Optional[UploadFile] = File(default=None),
) -> dict:
    """
    接收前端送來的文字與可選圖片。

    這個 endpoint 保留原本的示範功能。
    螢光 CSV 分析請使用：
    POST /api/fluorescence/analyze
    """

    result: dict = {}

    cleaned_text = text.strip() if text else ""

    if cleaned_text:
        result["text_analysis"] = {
            "original_text": cleaned_text,
            "length": len(cleaned_text),
            "word_count": len(cleaned_text.split()),
        }

    if image is not None:
        try:
            contents = await image.read()

            result["image_analysis"] = {
                "filename": image.filename,
                "content_type": image.content_type,
                "size_bytes": len(contents),
            }
        finally:
            await image.close()

    if not result:
        result["message"] = "沒有收到任何文字或圖片。"

    return result


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
