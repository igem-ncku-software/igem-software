# Dose-Response Model — 實作規格 (Spec for Claude Code)

**專案**：E. coli LasR–AHL 生物感測器對 3-oxo-C12-HSL 的劑量反應定量
**對應實驗**：`[E. coli-LasR-AHL][Time-Course AHL Dose-Response Fluorescence] design v.1 (20260809)`
**目標讀者**：實作者（人 or Claude Code）。本文件把數學、資料格式、模組結構、測試都定死，實作時照著做即可。

> 假設：以 **Python** 實作（numpy / pandas / scipy / lmfit / matplotlib）。若你的軟體是別的 stack（R、JS、或要嵌進既有大專案），把「模組結構」那節換成對應寫法即可，數學與流程不變。

---

## 0. 這個模組要回答的問題

給定一組 kinetic plate reader 數據（RFU + OD600 隨時間，多個 AHL 濃度、多株菌），輸出：

1. **每株菌的 dose-response 曲線**：EC50、Hill 係數 n、dynamic range、fold-change（含 95% CI）。
2. **每條曲線的時間動力學**：onset time、response rate、plateau。
3. **偵測極限 LOD / LOQ**（以 nM 表示）。
4. **診斷判斷**：這株菌對 AHL 到底有沒有反應（平坦檢定）。
5. QC 報告（生長抑制、DMSO 效應、replicate 變異）。

**設計原則**：把純數學（Hill、logistic）跟資料處理分開，前者要能單獨用合成數據做單元測試。

---

## 1. 實驗結構（程式要知道的形狀）

- **AHL 濃度**（3-oxo-C12-HSL）：`0, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5` M（即 0、1、10、100 nM、1、10 µM），DMSO 終濃度全盤固定 0.5%。
- **菌株**：TOP10、DH5α、BL21（三株比較，挑最佳 chassis）。
- **讀值**：kinetic，OD600 + GFP（Ex/Em ≈ 485/510 nm），每 1 小時一次，共 6–8 小時或到 plateau。
- **重複**：每組 n ≥ 3。
- **Plate map（design v.1）**：列 = 濃度、欄 = 菌株。

| Row | 內容 | Col 1–3 | Col 4–6 | Col 7–9 |
|-----|------|---------|---------|---------|
| A | 0 nM (DMSO only, neg ctrl) | TOP10 | DH5α | BL21 |
| B | 1 nM | TOP10 | DH5α | BL21 |
| C | 10 nM | TOP10 | DH5α | BL21 |
| D | 100 nM | TOP10 | DH5α | BL21 |
| E | 1 µM | TOP10 | DH5α | BL21 |
| F | 10 µM | TOP10 | DH5α | BL21 |
| G | Blank（培養基+DMSO，無菌液） | TOP10-well | DH5α-well | BL21-well |
| H | Positive control (H1–3) | — | — | — |

> Plate map 不要寫死在程式裡，放進 config（見 §7），因為之後盤面會改。

---

## 2. 推薦技術棧

| 用途 | 套件 |
|------|------|
| 數值/資料 | `numpy`, `pandas` |
| 擬合 + 參數信賴區間 | `lmfit`（首選，`conf_interval()` 直接給 CI）；退而求其次 `scipy.optimize.curve_fit` + bootstrap |
| 統計檢定 | `scipy.stats`（Welch t-test、F-test） |
| 繪圖 | `matplotlib` |
| 設定檔 | `pyyaml` |
| 測試 | `pytest` |

---

## 3. 模組結構

```
dose_response/
├── config/
│   ├── experiment.yaml        # 濃度、plate map、Ex/Em、閾值
│   └── plate_map.csv          # 或直接寫在 yaml 裡
├── data/raw/                  # reader 匯出的原始檔
├── src/dose_response/
│   ├── __init__.py
│   ├── models.py              # 純數學：hill(), logistic_time(), 反函式 — 可單獨測試
│   ├── io.py                  # load_reader_export(), load_plate_map(), to_tidy()
│   ├── normalize.py           # blank_subtract(), normalize_fluorescence()
│   ├── timeseries.py          # onset_time(), response_rate(), plateau(), fit_time_sigmoid()
│   ├── doseresponse.py        # fit_hill(), ec50_with_ci(), flatness_test(), lod_loq()
│   ├── qc.py                  # growth_check(), cv_check(), dmso_check()
│   ├── plots.py               # 三張標準圖
│   └── pipeline.py            # 串起 end-to-end
├── tests/
│   ├── test_models.py         # ★ 合成數據還原已知 EC50
│   ├── test_normalize.py
│   └── test_doseresponse.py
├── scripts/run_analysis.py    # CLI 入口
└── outputs/                   # 產出的表與圖
```

---

## 4. 資料格式

### 4.1 內部標準格式（tidy long）
所有下游函式都吃這張表：

| 欄位 | 型別 | 說明 |
|------|------|------|
| `strain` | str | TOP10 / DH5α / BL21 |
| `concentration_M` | float | AHL 莫耳濃度；0 保留為 0 |
| `replicate` | int | 重複編號 |
| `time_h` | float | 讀值時間（小時） |
| `RFU` | float | 原始螢光 |
| `OD600` | float | 原始 OD |
| `well` | str | e.g. "A1" |
| `role` | str | sample / blank / positive |

### 4.2 輸入來源
`load_reader_export()` 要能吃 SpectraMax M2/M2e 的匯出（通常是每個時間點一張 8×12 矩陣，OD 與 RFU 分開）。**寫成 adapter 模式**：一個 parser 對一種匯出格式，回傳統一的 tidy 表；未來換機器只加 parser。

> 目前團隊用 `iGEM wet 實驗數據.xlsb` 手動整理，這個模組要能取代那步：直接吃原始匯出 → tidy → 分析。

---

## 5. 數學核心（`models.py` + 各步驟）

### 5.1 正規化
對每個 well `w`、時間 `t`：

```
OD_corr(w,t)  = OD600(w,t) − OD_blank(t)          # blank = G 列（無菌液），取同時間點均值
RFU_corr(w,t) = RFU(w,t)   − RFU_blank(t)
F(w,t)        = RFU_corr(w,t) / OD_corr(w,t)       # 若 OD_corr < OD_min 則設 NaN（gating）
```

`OD_min` 建議 0.02（放 config）。之後每個 (strain, conc, t) 對 replicate 取 mean ± SD。

> **決定（§10 item 3，實作 `normalize.py` 時）**：`F(w,t)` 算出負值時**不做任何截斷**，原始負值直接保留傳給下游。原因：負值只出現在早期低訊號時間點（背景 > 訊號的雜訊區間；模擬資料集中在 t=0–2h，t≥3h 後全部轉正），不影響 plateau 或後續 EC50 擬合；若歸零會系統性墊高低劑量組（尤其 0 nM 對照）的平均值，污染 §5.4 平坦檢定與 §5.5 LOD/LOQ 的基線估計。之後畫圖（§6）如果想要非負的視覺呈現，只能在畫圖時把 y 軸下限夾在 0，不能改動 `tidy_normalized.csv` 裡的原始數據。**這是預期行為，不是 bug**，之後看到負的 F 不要直接當成錯誤去「修」。

### 5.2 時間動力學指標（每條 strain×conc 曲線）
**主方法：擬時間 logistic**

```
F(t) = F0 + (Fmax − F0) / (1 + exp(−r · (t − t0)))
```

- `plateau = Fmax`
- `rate    = r · (Fmax − F0) / 4`（logistic 最大斜率）
- `t_half  = t0`

> **實作發現（§10 item 4，`timeseries.py`）**：0 nM / 低劑量的曲線在整個 8 小時觀測窗內都還在爬升（因為 §5.1 記錄的「早期背景>訊號」現象，F 從很負一路升到觀測窗結束都還沒看到平坦的下段），這種形狀會讓 logistic 的 `f0`/`t0` 變成不可識別（non-identifiable）——`curve_fit` 不會報錯，但在這份模擬資料上實際擬出 `t0≈-13h`、`f0≈-2,000,000`（8 小時的實驗！），套進 `rate=r·(Fmax−F0)/4` 直接爆成 30 萬等級的離譜數字。對策：擬合後多檢查一次 `t0` 有沒有落在觀測時間窗外一定範圍（目前用窗寬的 50% 當容忍度），超出就視同「未收斂」，改用 fallback 公式。`plateau`（Fmax）本身在這些情況下其實還算合理（末端有看到轉緩），問題只出在 `f0`/`t0`/`rate`。

**onset time（不依賴擬合，較穩健）**：以 0 nM 同株為對照，找出**連續 ≥2 個時間點** F(conc) 超過 `mean_0nM + k·SD_0nM`（k 放 config，預設 3）的**第一個**時間點。

> **實作澄清**：`mean_0nM`/`SD_0nM` 是**每個時間點分別算**（同一時間點、跨 replicate），不是整個時間序列一起 pool。原因：0 nM 組自己的 F 在 8 小時內也會從很負飄到 100~200 這個量級（跟上面同一個現象），如果把所有時間點 pool 在一起算一個 SD，SD 會被撐到 ~230-250，`mean+3·SD` 這個閾值會高到幾乎沒有劑量組能穿越，onset 偵測形同失效。按時間點分開算，SD 就穩定在個位數到十位數，跟每個時間點的雜訊量級相符。

**fallback**（logistic 擬合失敗時）：`plateau = mean(最後 2 個讀值)`、`rate = max 有限差分斜率`、`onset = 上述閾值穿越`。

**旗標**：若最後兩點斜率仍顯著 > 0 → `plateau_reached = False`（低濃度常見，8 小時內未達平台）。

> **實作澄清**：「顯著 > 0」沒有給正式檢定，logistic 數學上永遠不會在有限時間內斜率剛好等於 0，所以字面上的「> 0」判斷會讓每一條收斂的曲線都判定成「未達平台」。改用「最後兩點斜率 ≤ 曲線自身最大斜率（在 t0 附近）的 10%」當判準——這個 10% 是選定的經驗閾值，不是 spec 給的數字。

### 5.3 劑量反應（每株菌，用 plateau vs [AHL]）
**Hill（活化型）**：

```
F_plateau([A]) = bottom + (top − bottom) · [A]^n / (EC50^n + [A]^n)
```

擬合參數與邊界：

| 參數 | 初值 | 邊界 |
|------|------|------|
| `bottom` | 0 nM 組的 plateau | ≥ 0 |
| `top`    | 最高濃度組 plateau | > bottom |
| `EC50`   | 中間濃度 | > 0 |
| `n`      | 1.0 | [0.5, 4] |

**實作要點**：
- 在 **log10[A]** 座標上擬合較穩定。
- **[A]=0 排除在擬合之外**（不能取 log），但用 0 nM 組的 plateau 當 `bottom` 初值，並在圖上把它畫成最左的基準點。
- 用 `lmfit` 的 `conf_interval()` 取 **EC50 的 95% CI**；`scipy` 版就用殘差 bootstrap。
- 輸出：`EC50 (nM)`、`n`、`dynamic_range = top/bottom`、`R²`。

### 5.4 平坦檢定（★ 診斷關鍵，不可省）
因為感測器目前可能對 AHL 無反應，必須判斷 dose-dependence 是否真實存在：

- 擬 **Hill 模型** vs **常數模型**（F = 平均值）。
- 用 **F-test** 或 **ΔAIC** 比較。
- 若 Hill 沒有顯著較好（p > 0.05 或 ΔAIC < 2）→ 回報 `responsive = False`、`EC50 = None`，**不要輸出假 EC50**。訊息例：`"No significant dose-dependence detected; EC50 not identifiable."`

### 5.5 LOD / LOQ
以 0 nM 組分布為基準：

```
signal_threshold_LOD = mean_0nM + 3 · SD_0nM
signal_threshold_LOQ = mean_0nM + 10 · SD_0nM
```

`LOD = 最小的 [AHL]，其 plateau 均值 ≥ LOD 閾值 且 Welch 單尾 t-test 對 0 nM 顯著 (α=0.05)`。以 nM 回報；查不到就回 `> 10 µM (not detectable in tested range)`。

---

## 6. QC 檢查（`qc.py`）
- **生長抑制**：比較各濃度的 OD600 生長曲線；若高濃度組終點 OD 比 0 nM 低超過 X%（config，預設 20%）→ 旗標 `growth_inhibition`，因為這會讓 RFU/OD 正規化失真。
- **DMSO 效應**：0 nM(DMSO) vs 純 blank，確認溶劑本身沒有壓生長或加背景。
- **Replicate CV**：每組算 CV，> 閾值（config，預設 20%）旗標。
- **OD gating 記錄**：報告被 gate 掉的 (well, time) 數量。

---

## 7. Config（`experiment.yaml`）

```yaml
fluorescence:
  ex_nm: 485
  em_nm: 510
read_interval_h: 1.0
concentrations_M:   # row 對應
  A: 0.0
  B: 1.0e-9
  C: 1.0e-8
  D: 1.0e-7
  E: 1.0e-6
  F: 1.0e-5
strains:            # 欄範圍對應
  TOP10: [1, 2, 3]
  DH5a:  [4, 5, 6]
  BL21:  [7, 8, 9]
roles:
  blank_row: G
  positive_wells: [H1, H2, H3]
thresholds:
  od_min: 0.02
  onset_k_sd: 3
  cv_max: 0.20
  growth_inhibition_frac: 0.20
hill:
  n_bounds: [0.5, 4.0]
```

---

## 8. 輸出

**表（CSV，存 outputs/）**
- `tidy_normalized.csv`：全部 (strain, conc, replicate, time, F)。
- `timeseries_metrics.csv`：每 strain×conc 的 onset、rate、plateau ± SD、plateau_reached。
- `doseresponse_params.csv`：每株 EC50、EC50_CI、n、top、bottom、dynamic_range、R²、responsive、LOD_nM、LOQ_nM。
- `qc_report.csv`。

**圖（PNG）**
- `growth_curves.png`：OD600 vs 時間，每濃度一線（看有沒有生長抑制）。
- `timecourse_normF.png`：正規化螢光 vs 時間，每株一張、每濃度一線。
- `doseresponse.png`：每株 plateau vs log[AHL]，資料點 + Hill 擬合曲線 + EC50 垂直標線 + CI 帶；平坦者標註 "not responsive"。

---

## 9. 單元測試（先寫，當 ground truth）

`tests/test_models.py`：
1. 用已知參數 (`EC50=1e-7, n=1.5, top=8000, bottom=200`) 產生 6 個濃度的合成 plateau，加小量高斯雜訊 → `fit_hill()` 應還原 EC50 在 ±20% 內、n 在 ±0.3 內。
   > **TODO（§10 item 4）**：現階段 `fit_hill()` 還沒寫，`tests/dose_response/test_models.py` 先用 `scipy.optimize.curve_fit` 直接對 `hill()` 做暫代版本，只證明數學形狀可還原，不代表 `fit_hill()` 屆時一定會通過。等 `doseresponse.py` 的 `fit_hill()` 寫出來後，要補一個真的呼叫 `fit_hill()` 的還原測試，取代或補齊這個暫代版本。
2. 產生一條**平的**合成曲線（top≈bottom）→ `flatness_test()` 應回 `responsive=False`。
   > **TODO（§10 item 4）**：`flatness_test()` 還沒實作，這項測試還沒寫，等 `doseresponse.py` 完成後補上。
3. `hill()` 邊界：`[A]→0` 回 `bottom`、`[A]→∞` 回 `top`、`[A]=EC50` 回 `(top+bottom)/2`。

`tests/test_normalize.py`：給定人工 RFU/OD/blank 矩陣，驗證 blank 扣除與 OD gating 正確。

---

## 10. 建議建置順序（給 Claude Code 的里程碑）

1. `models.py`（純函式）+ `test_models.py` — 先讓數學正確且可驗。
2. `io.py`：一個 SpectraMax parser + plate map 載入 + to_tidy + `test`。
3. `normalize.py` + `test`。
4. `doseresponse.py`：fit_hill → flatness_test → lod_loq → EC50 CI。
5. `timeseries.py`：onset / rate / plateau。
6. `qc.py`。
7. `plots.py`：三張圖。
8. `pipeline.py` + `scripts/run_analysis.py`（CLI：吃 config + raw 資料夾 → 產出 outputs）。

---

## 11. 參考實作（把數值最敏感的兩塊釘死，其餘讓 Claude Code 補）

```python
# models.py
import numpy as np

def hill(A, bottom, top, ec50, n):
    """Activation Hill. A in molar (>0 for fitting)."""
    A = np.asarray(A, dtype=float)
    return bottom + (top - bottom) * A**n / (ec50**n + A**n)

def logistic_time(t, f0, fmax, r, t0):
    return f0 + (fmax - f0) / (1.0 + np.exp(-r * (t - t0)))
```

```python
# doseresponse.py  (lmfit 版，取 EC50 CI)
import numpy as np
from lmfit import Model
from scipy import stats

def fit_hill(conc_M, plateau, plateau_sd=None):
    """conc_M, plateau: 1D arrays aligned. 排除 conc==0（單獨拿來估 bottom）。"""
    mask = conc_M > 0
    x, y = conc_M[mask], plateau[mask]
    bottom0 = float(plateau[conc_M == 0].mean()) if (conc_M == 0).any() else float(y.min())

    model = Model(hill)
    params = model.make_params(
        bottom=bottom0, top=float(y.max()),
        ec50=float(np.median(x)), n=1.0,
    )
    params['bottom'].min = 0
    params['top'].min = params['bottom'].value
    params['ec50'].min = 0
    params['n'].set(min=0.5, max=4.0)

    weights = 1.0 / plateau_sd[mask] if plateau_sd is not None else None
    result = model.fit(y, params, A=x, weights=weights)
    return result  # result.params['ec50'].value / .stderr; result.conf_interval()

def flatness_test(result, y):
    """F-test: Hill vs 常數模型。回傳 (responsive: bool, p: float)."""
    rss_full = np.sum(result.residual**2)
    rss_null = np.sum((y - y.mean())**2)
    n = len(y); p_full, p_null = 4, 1
    df1, df2 = p_full - p_null, n - p_full
    if df2 <= 0 or rss_full <= 0:
        return False, 1.0
    F = ((rss_null - rss_full) / df1) / (rss_full / df2)
    p = 1 - stats.f.cdf(F, df1, df2)
    return (p < 0.05), float(p)
```

---

## 12. 這份 model 之後怎麼接下去
擬出的 `EC50 / n / top / bottom` 會直接餵給後續兩個 model：
- **機制 ODE model**：EC50、n 校準 pLas 啟動子的活化函數。
- **AHL pH 水解 + 共培養 model**：把 EC50 當「偵測門檻」，疊上 AHL 在 pH 8.3 的衰減曲線，解釋為什麼共培養測不到。

所以 `doseresponse_params.csv` 要設計成能被那兩個 model 直接讀取的乾淨介面。
