"""FastAPI router for dose-response analysis: being rebuilt, so it has no endpoints yet.

main.py already mounts it, so a new endpoint only needs to be added here.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/dose_response", tags=["dose_response"])
