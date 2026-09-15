// =========================================================
// 集中設定：後端 base URL。
// 本機開發（localhost / 127.0.0.1）打本機的 uvicorn，其他一律打線上網址。
//
// 這個專案沒有 build step（純靜態檔案直接部署到 GitHub Pages），沒有辦法
// 用一般 SPA 那種「build 時注入環境變數」的做法，所以沿用 hostname 判斷方式，
// 集中在這一個檔案管理，而不是每支 script 各自寫一份。
//
// 之後若 Render 網址換掉，只要改這一行，所有打後端的地方
// （dose_response.js、hardware.js、backend_status.js）都會自動生效。
//
// 必須在其他會用到 BACKEND_BASE_URL 的 <script> 之前載入。
// =========================================================

const BACKEND_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? "http://127.0.0.1:8000"
  : "https://igem-ncku-software.onrender.com";

// ---- CAPTURE-Screen 裝置 --------------------------------------------
// DEVICE_MODE_SETTING：
//   "mock" 用 js/hardware_mock.js 的模擬裝置（沒有硬體也能完整展示流程）
//   "live" 呼叫 DEVICE_BASE_URL 上的真實裝置（firmware/as7341）
// 手動改這一行切換。
//
// HTTPS 頁面（例如 GitHub Pages）的瀏覽器會擋掉對 http:// 與 ws:// 的請求
// （mixed content），裝置又只有 http，所以 HTTPS 下一律強制 mock；
// live 只能在本機用 http 開前端時使用（python -m http.server 5500）。
const DEVICE_BASE_URL = "http://capture-screen.local";
const DEVICE_MODE_SETTING = "mock"; // "mock" | "live"
const DEVICE_MODE = window.location.protocol === "https:" ? "mock" : DEVICE_MODE_SETTING;
