from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.plate_assay.router import router as plate_assay_router
from app.hardware.router import router as hardware_router
from app.live.router import router as live_router
from app.swarming.router import router as swarming_router


app = FastAPI(
    title="LasReader API",
    description="Backend API for LasReader: plate reader assay, CAPTURE-Screen hardware, and the swarming assay.",
    version="1.3.0",
)

# CORS origin list is centralized in app/config.py (overridable via .env)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Plate reader assay API (being rebuilt; no endpoints yet)
app.include_router(plate_assay_router)
app.include_router(hardware_router)
app.include_router(live_router)
# Swarming Assay: one plate photo in, the colony measurements out
app.include_router(swarming_router)


@app.get("/")
def root() -> dict:
    """API root; also lists which endpoints are currently available to try."""
    return {
        "message": "LasReader API is running.",
        "docs": "/docs",
        "health": "/health",
        "hardware_status": "GET /api/hardware/status",
        "hardware_read": "POST /api/hardware/read",
        "hardware_device": "WS /api/hardware/device",
        "live_spectrum": "WS /api/live/spectrum",
        "swarming_analyze": "POST /api/swarming/analyze",
    }


@app.get("/health")
def health_check() -> dict:
    """Used by the frontend and Render to check whether the backend is healthy."""
    return {"status": "ok", "service": "LasReader API"}


# Local testing:
# 1. cd into the backend folder
# 2. Run uvicorn app.main:app --reload
#
# Note: because main.py is now a module inside the app package,
# it can no longer be run directly with `python main.py` or `uvicorn main:app` —
# always use the `app.main:app` path.
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
