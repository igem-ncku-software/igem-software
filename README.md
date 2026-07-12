# iGEM Analyzer 起始專案

前端（HTML/CSS/JS）+ 後端（FastAPI）的最小可運作範例。
使用者可以在網頁輸入文字或上傳圖片，前端會把資料送到 FastAPI 後端，
後端處理完之後回傳 JSON 結果，前端再顯示出來。

```
igem-webapp/
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── script.js
├── backend/
│   ├── main.py
│   └── requirements.txt
└── README.md
```

---

## 1. 本機測試

### 1.1 啟動後端

```bash
cd backend
python -m venv venv
source venv/bin/activate      # Windows 用 venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

後端會跑在 `http://127.0.0.1:8000`。
瀏覽器打開 `http://127.0.0.1:8000/health`，看到 `{"status":"ok"}` 就代表成功。

也可以用 `http://127.0.0.1:8000/docs` 看 FastAPI 自動產生的 API 測試介面。

### 1.2 開啟前端

直接用瀏覽器打開 `frontend/index.html` 即可（或用 VS Code 的 Live Server 套件）。
確認 `script.js` 裡的 `BACKEND_URL` 是 `http://127.0.0.1:8000`。

輸入文字、選圖片、按「送出分析」，應該就能看到後端回傳的結果。

---

## 2. 把程式改成你自己的 iGEM 邏輯

- `backend/main.py` 裡的 `analyze()` 函式現在只是範例（算字數、算圖片大小）。
  把 `# TODO` 的地方換成你真正要做的分析，例如：
  - 序列比對 / motif 搜尋
  - 呼叫訓練好的模型做圖片分類
  - 呼叫外部生資 API（NCBI、UniProt 等）
- 如果之後要用到額外的 Python 套件（例如 biopython、numpy、pillow、torch），
  記得加進 `backend/requirements.txt`。

---

## 3. 上傳到 GitHub

在專案根目錄（`igem-webapp/`）執行：

```bash
git init
git add .
git commit -m "Initial commit: iGEM analyzer starter"
```

到 GitHub 網站建立一個新的 repository（例如 `igem-analyzer`），不要勾選自動加 README，
然後照 GitHub 給的指示連接遠端並推上去，大致是：

```bash
git branch -M main
git remote add origin https://github.com/<你的帳號>/igem-analyzer.git
git push -u origin main
```

---

## 4. 讓網站真的能被別人使用（部署）

這裡要注意：**前端和後端要分開部署**，因為 GitHub Pages 只能放靜態檔案，不能跑 Python。

### 4.1 部署前端：GitHub Pages（免費）

1. 到 GitHub repo 的 **Settings → Pages**
2. Source 選擇 `main` 分支，資料夾選 `/frontend`（或把 frontend 內容移到根目錄也可以）
3. 存檔後，GitHub 會給你一個網址，格式類似：
   `https://<你的帳號>.github.io/igem-analyzer/`
4. 等 1–2 分鐘讓它部署完成即可

### 4.2 部署後端：Render.com（免費方案可用）

1. 到 [render.com](https://render.com) 註冊，用 GitHub 帳號登入
2. 點 **New → Web Service**，選擇你剛剛推上去的 repo
3. 設定：
   - **Root Directory**: `backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. 部署完成後，Render 會給你一個網址，例如：
   `https://igem-analyzer-backend.onrender.com`

> 免費方案的後端閒置一段時間會「睡著」，第一次請求可能會等 30 秒左右才醒來，這是正常現象。

### 4.3 把前後端接起來

1. 打開 `frontend/script.js`，把
   ```js
   const BACKEND_URL = "http://127.0.0.1:8000";
   ```
   改成你在 Render 拿到的網址，例如：
   ```js
   const BACKEND_URL = "https://igem-analyzer-backend.onrender.com";
   ```
2. 打開 `backend/main.py`，把 CORS 設定從 `allow_origins=["*"]`
   改成只允許你的 GitHub Pages 網址（比較安全）：
   ```python
   allow_origins=["https://<你的帳號>.github.io"],
   ```
3. 修改完後重新 commit、push：
   ```bash
   git add .
   git commit -m "Connect frontend to deployed backend"
   git push
   ```
4. Render 和 GitHub Pages 都會偵測到更新並自動重新部署。

完成後，任何人打開你的 GitHub Pages 網址，就能實際使用這個網站、
輸入文字或上傳圖片，並得到後端運算後的結果。

---

## 5. 之後想擴充可以考慮

- 幫圖片分析加上真正的模型（例如用 `torch`/`tensorflow` 跑分類，或呼叫外部 AI API）
- 加上簡單的資料庫（SQLite）記錄使用者送出的紀錄
- 加上速率限制，避免免費後端被濫用
- 如果團隊有多人協作，建議直接開 GitHub repo 的 issue/PR 流程管理修改
