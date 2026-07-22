from pathlib import Path
from typing import Any

import pandas as pd


REQUIRED_COLUMNS = {
    "sample",
    "aptamer",
    "concentration",
    "concentration_unit",
    "replicate",
    "gfp",
    "od600",
}


def analyze_fluorescence_csv(
    file_path: str | Path,
) -> dict[str, Any]:
    """
    分析 GFP fluorescence CSV 檔案。

    分析內容：
    1. normalized_gfp = gfp / od600
    2. 每組 normalized GFP 的平均值
    3. 每組 normalized GFP 的標準差
    4. 每組 replicate 數量
    5. 相對 Control 的 inhibition rate

    Parameters
    ----------
    file_path:
        CSV 檔案的路徑。

    Returns
    -------
    dict:
        包含 summary、results 與 raw_data。
    """

    file_path = Path(file_path)

    # 1. 檢查檔案是否存在
    if not file_path.exists():
        raise FileNotFoundError(
            f"File not found: {file_path}"
        )

    # 2. 檢查副檔名
    if file_path.suffix.lower() != ".csv":
        raise ValueError(
            "Only CSV files are supported."
        )

    # 3. 讀取 CSV
    #
    # keep_default_na=False 很重要。
    # pandas 預設會把 None、NA 等文字當成空值。
    # 但本專案使用 None 表示 Control 沒有 aptamer，
    # 因此必須保留 None 為一般文字。
    try:
        df = pd.read_csv(
            file_path,
            keep_default_na=False,
        )

    except pd.errors.EmptyDataError as error:
        raise ValueError(
            "The CSV file is empty."
        ) from error

    except pd.errors.ParserError as error:
        raise ValueError(
            "The CSV file format is invalid."
        ) from error

    except UnicodeDecodeError as error:
        raise ValueError(
            "The CSV encoding is invalid. "
            "Please save the file as UTF-8 CSV."
        ) from error

    # 4. 檢查 CSV 是否有資料
    if df.empty:
        raise ValueError(
            "The CSV file contains no data."
        )

    # 5. 清除欄位名稱前後空白
    df.columns = (
        df.columns
        .astype(str)
        .str.strip()
    )

    # 6. 檢查必要欄位
    missing_columns = (
        REQUIRED_COLUMNS - set(df.columns)
    )

    if missing_columns:
        missing_text = ", ".join(
            sorted(missing_columns)
        )

        raise ValueError(
            f"Missing required columns: {missing_text}"
        )

    # 7. 清理文字欄位
    text_columns = [
        "sample",
        "aptamer",
        "concentration_unit",
    ]

    for column in text_columns:
        df[column] = (
            df[column]
            .astype(str)
            .str.strip()
        )

    # 8. 檢查文字欄位是否有真正的空字串
    #
    # aptamer 欄位中的 None 是有效文字，
    # 不應被當成缺失值。
    for column in text_columns:
        invalid_text = (
            df[column]
            .astype(str)
            .str.strip()
            .eq("")
        )

        if invalid_text.any():
            invalid_rows = (
                df.index[invalid_text] + 2
            ).tolist()

            raise ValueError(
                f'Column "{column}" contains empty values '
                f"at CSV rows: {invalid_rows}"
            )

    # 9. 將數值欄位轉換成數字
    numeric_columns = [
        "concentration",
        "replicate",
        "gfp",
        "od600",
    ]

    for column in numeric_columns:
        original_values = df[column].copy()

        df[column] = pd.to_numeric(
            df[column],
            errors="coerce",
        )

        invalid_numeric = df[column].isna()

        if invalid_numeric.any():
            invalid_rows = (
                df.index[invalid_numeric] + 2
            ).tolist()

            invalid_values = (
                original_values[invalid_numeric]
                .tolist()
            )

            raise ValueError(
                f'Column "{column}" contains invalid '
                f"numeric values at CSV rows "
                f"{invalid_rows}: {invalid_values}"
            )

    # 10. 檢查 concentration
    if (df["concentration"] < 0).any():
        invalid_rows = (
            df.index[
                df["concentration"] < 0
            ] + 2
        ).tolist()

        raise ValueError(
            "Concentration cannot be negative. "
            f"Invalid CSV rows: {invalid_rows}"
        )

    # 11. 檢查 replicate
    if (df["replicate"] <= 0).any():
        invalid_rows = (
            df.index[
                df["replicate"] <= 0
            ] + 2
        ).tolist()

        raise ValueError(
            "Replicate numbers must be greater "
            "than 0. "
            f"Invalid CSV rows: {invalid_rows}"
        )

    # replicate 應為整數
    non_integer_replicates = (
        df["replicate"] % 1 != 0
    )

    if non_integer_replicates.any():
        invalid_rows = (
            df.index[non_integer_replicates] + 2
        ).tolist()

        raise ValueError(
            "Replicate numbers must be integers. "
            f"Invalid CSV rows: {invalid_rows}"
        )

    df["replicate"] = df["replicate"].astype(int)

    # 12. 檢查 GFP
    if (df["gfp"] < 0).any():
        invalid_rows = (
            df.index[
                df["gfp"] < 0
            ] + 2
        ).tolist()

        raise ValueError(
            "GFP values cannot be negative. "
            f"Invalid CSV rows: {invalid_rows}"
        )

    # 13. 檢查 OD600
    if (df["od600"] <= 0).any():
        invalid_rows = (
            df.index[
                df["od600"] <= 0
            ] + 2
        ).tolist()

        raise ValueError(
            "OD600 must be greater than 0. "
            f"Invalid CSV rows: {invalid_rows}"
        )

    # 14. 檢查相同 sample 和 replicate 是否重複
    duplicate_mask = df.duplicated(
        subset=[
            "sample",
            "aptamer",
            "concentration",
            "concentration_unit",
            "replicate",
        ],
        keep=False,
    )

    if duplicate_mask.any():
        duplicate_rows = (
            df.index[duplicate_mask] + 2
        ).tolist()

        raise ValueError(
            "Duplicate replicate records were found. "
            f"CSV rows: {duplicate_rows}"
        )

    # 15. 計算每筆資料的 normalized GFP
    df["normalized_gfp"] = (
        df["gfp"] / df["od600"]
    )

    # 16. 依照實驗組別分組
    grouped = (
        df.groupby(
            [
                "sample",
                "aptamer",
                "concentration",
                "concentration_unit",
            ],
            as_index=False,
            dropna=False,
        )
        .agg(
            mean_normalized_gfp=(
                "normalized_gfp",
                "mean",
            ),
            sd_normalized_gfp=(
                "normalized_gfp",
                "std",
            ),
            replicates=(
                "normalized_gfp",
                "count",
            ),
            mean_raw_gfp=(
                "gfp",
                "mean",
            ),
            mean_od600=(
                "od600",
                "mean",
            ),
        )
    )

    # 如果只有一個 replicate，標準差會是 NaN
    grouped["sd_normalized_gfp"] = (
        grouped["sd_normalized_gfp"]
        .fillna(0)
    )

    # 17. 找出 Control
    #
    # casefold 可以讓 Control、control、CONTROL
    # 都被視為相同名稱。
    control_mask = (
        grouped["sample"]
        .astype(str)
        .str.strip()
        .str.casefold()
        .eq("control")
    )

    control_rows = grouped[control_mask]

    if control_rows.empty:
        available_samples = sorted(
            grouped["sample"]
            .astype(str)
            .str.strip()
            .unique()
            .tolist()
        )

        raise ValueError(
            'The dataset must contain a sample named '
            '"Control". '
            f"Available samples: {available_samples}"
        )

    # Control 在分組後只能有一組
    if len(control_rows) > 1:
        control_details = control_rows[
            [
                "sample",
                "aptamer",
                "concentration",
                "concentration_unit",
            ]
        ].to_dict(
            orient="records"
        )

        raise ValueError(
            'More than one grouped sample is named '
            '"Control". '
            f"Control groups found: {control_details}"
        )

    # 18. 取得 Control 的平均 normalized GFP
    control_mean = float(
        control_rows.iloc[0][
            "mean_normalized_gfp"
        ]
    )

    if control_mean <= 0:
        raise ValueError(
            "The Control mean normalized GFP "
            "must be greater than 0."
        )

    # 19. 計算 inhibition rate
    #
    # inhibition rate =
    # (1 - treatment / control) * 100
    grouped["inhibition_rate"] = (
        1
        - (
            grouped["mean_normalized_gfp"]
            / control_mean
        )
    ) * 100

    # 避免浮點數造成 -0.0000000001
    grouped.loc[
        grouped["inhibition_rate"].abs() < 1e-10,
        "inhibition_rate",
    ] = 0

    # 20. 四捨五入
    grouped = grouped.round(
        {
            "concentration": 6,
            "mean_normalized_gfp": 2,
            "sd_normalized_gfp": 2,
            "mean_raw_gfp": 2,
            "mean_od600": 4,
            "inhibition_rate": 2,
        }
    )

    # 21. 將 Control 排在第一列
    grouped["_is_not_control"] = (
        grouped["sample"]
        .astype(str)
        .str.strip()
        .str.casefold()
        .ne("control")
    )

    grouped = (
        grouped.sort_values(
            by=[
                "_is_not_control",
                "sample",
                "concentration",
            ]
        )
        .drop(
            columns="_is_not_control"
        )
        .reset_index(
            drop=True
        )
    )

    # 22. 整理每筆原始資料
    raw_data = df[
        [
            "sample",
            "aptamer",
            "concentration",
            "concentration_unit",
            "replicate",
            "gfp",
            "od600",
            "normalized_gfp",
        ]
    ].copy()

    raw_data = raw_data.round(
        {
            "concentration": 6,
            "gfp": 2,
            "od600": 4,
            "normalized_gfp": 2,
        }
    )

    raw_data = raw_data.sort_values(
        by=[
            "sample",
            "concentration",
            "replicate",
        ]
    ).reset_index(
        drop=True
    )

    # 23. 回傳結果
    return {
        "status": "success",
        "summary": {
            "file_name": file_path.name,
            "total_rows": int(len(df)),
            "groups": int(len(grouped)),
            "control_group": str(
                control_rows.iloc[0]["sample"]
            ),
            "control_mean_normalized_gfp": round(
                control_mean,
                2,
            ),
        },
        "results": grouped.to_dict(
            orient="records"
        ),
        "raw_data": raw_data.to_dict(
            orient="records"
        ),
    }


if __name__ == "__main__":
    test_file = (
        Path(__file__).resolve().parent
        / "test_data"
        / "example_fluorescence.csv"
    )

    print("=" * 60)
    print("Fluorescence analysis test")
    print("=" * 60)
    print(f"Reading file: {test_file}")

    try:
        analysis_result = (
            analyze_fluorescence_csv(
                test_file
            )
        )

        print("\nAnalysis summary:")
        print(
            analysis_result["summary"]
        )

        print("\nGrouped results:")

        for row in analysis_result["results"]:
            print(row)

        print("\nRaw normalized data:")

        for row in analysis_result["raw_data"]:
            print(row)

    except (
        FileNotFoundError,
        ValueError,
    ) as error:
        print("\nAnalysis failed:")
        print(error)
