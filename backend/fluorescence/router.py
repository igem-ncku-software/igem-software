from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, File, HTTPException, UploadFile

from .analysis import analyze_fluorescence_csv


router = APIRouter(
    prefix="/api/fluorescence",
    tags=["Fluorescence"],
)


@router.post("/analyze")
async def analyze_fluorescence(
    file: UploadFile = File(...),
) -> dict:
    """
    接收使用者上傳的 fluorescence CSV，
    執行 GFP / OD600 與 inhibition rate 分析。
    """

    if not file.filename:
        raise HTTPException(
            status_code=400,
            detail="No file was uploaded.",
        )

    file_suffix = Path(file.filename).suffix.lower()

    if file_suffix != ".csv":
        raise HTTPException(
            status_code=400,
            detail="Only CSV files are supported.",
        )

    temporary_file_path: Path | None = None

    try:
        file_content = await file.read()

        if not file_content:
            raise HTTPException(
                status_code=400,
                detail="The uploaded file is empty.",
            )

        with NamedTemporaryFile(
            mode="wb",
            suffix=".csv",
            delete=False,
        ) as temporary_file:
            temporary_file.write(file_content)
            temporary_file_path = Path(
                temporary_file.name
            )

        result = analyze_fluorescence_csv(
            temporary_file_path
        )

        result["summary"]["original_file_name"] = (
            file.filename
        )

        return result

    except HTTPException:
        raise

    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred "
            "while analyzing the CSV file.",
        ) from error

    finally:
        await file.close()

        if (
            temporary_file_path is not None
            and temporary_file_path.exists()
        ):
            temporary_file_path.unlink()
