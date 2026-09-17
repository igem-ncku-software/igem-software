import os

from dotenv import load_dotenv

# Loads backend/.env (for local development).
# On production platforms like Render, environment variables are injected directly by
# the platform; load_dotenv() silently no-ops when it can't find a .env file.
load_dotenv()


class Settings:
    """Centralizes all environment variables so config values don't end up scattered across files."""

    # Frontend origins allowed to call the backend API.
    # Both the production origin (GitHub Pages) and local dev origins are listed here,
    # comma-separated, and can be overridden via .env without touching code.
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

    # CAPTURE-Screen dials into WS /api/hardware/device itself (see app/hardware/hub.py).
    # The firmware reports status every 5 s; going longer than this without any message counts as offline.
    HARDWARE_ONLINE_TIMEOUT_SECONDS: float = float(os.getenv("HARDWARE_ONLINE_TIMEOUT_SECONDS", "15"))
    # Upper bound for POST /api/hardware/read to wait on the device's result; one measurement itself takes about 3 s.
    HARDWARE_READ_TIMEOUT_SECONDS: float = float(os.getenv("HARDWARE_READ_TIMEOUT_SECONDS", "10"))

    if HARDWARE_ONLINE_TIMEOUT_SECONDS <= 0 or HARDWARE_READ_TIMEOUT_SECONDS <= 0:
        raise ValueError("HARDWARE_ONLINE_TIMEOUT_SECONDS and HARDWARE_READ_TIMEOUT_SECONDS must be positive.")


settings = Settings()
