from fastapi import FastAPI, Form, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import base64

app = FastAPI(title="iGEM Analyzer API")

# CORS：先開放所有來源方便開發。
# 部署上線後，建議把 allow_origins 換成你實際的前端網址，例如：
# allow_origins=["https://<你的帳號>.github.io"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health_check():
    """給前端用來檢查後端是否活著"""
    return {"status": "ok"}


@app.post("/api/analyze")
async def analyze(
    text: Optional[str] = Form(default=""),
    image: Optional[UploadFile] = File(default=None),
):
    """
    接收前端送來的文字與(可選的)圖片，回傳分析結果。

    ⚠️ 這裡目前只是「範例邏輯」，你要把它換成你真正的 iGEM 分析程式，
    例如序列比對、影像辨識模型、生資分析等等。
    """
    result = {}

    if text:
        result["text_analysis"] = {
            "original_text": text,
            "length": len(text),
            "word_count": len(text.split()),
            # TODO: 換成你自己的分析邏輯，例如 DNA/蛋白質序列分析
        }

    if image is not None:
        contents = await image.read()
        result["image_analysis"] = {
            "filename": image.filename,
            "content_type": image.content_type,
            "size_bytes": len(contents),
            # TODO: 換成你自己的影像處理/模型推論邏輯
            # 範例：如果之後要把圖存起來或丟給模型，可以用 contents (bytes)
        }

    if not result:
        result["message"] = "沒有收到任何文字或圖片"

    return result


# 本機測試用：python main.py
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
