import os

from dotenv import load_dotenv

# 讀取 backend/.env（本機開發用）。
# 在 Render 等正式環境上，環境變數會直接由平台注入，
# load_dotenv() 找不到 .env 檔時不會報錯，只會略過。
load_dotenv()


class Settings:
    """集中管理所有環境變數，避免設定值散落在各個檔案裡。"""

    # 允許呼叫後端 API 的前端來源。
    # 正式環境（GitHub Pages）與本機開發用的 origin 都列在這裡，
    # 用逗號分隔，可透過 .env 覆寫，不需要改程式碼。
    CORS_ORIGINS: list[str] = [
        origin.strip()
        for origin in os.getenv(
            "CORS_ORIGINS",
            "https://igem-ncku-software.github.io,"
            "http://localhost:5500,"
            "http://127.0.0.1:5500,"
            "http://localhost:8000,"
            "http://127.0.0.1:8000",
        ).split(",")
    ]


settings = Settings()
