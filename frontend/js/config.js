// =========================================================
// 集中設定：後端 base URL。
// 本機開發（localhost / 127.0.0.1）打本機的 uvicorn，其他一律打線上網址。
// 之後要換部署網址（例如 Render 網址換掉），只要改這一個檔案。
//
// 這個專案沒有 build step（純靜態檔案直接部署到 GitHub Pages），沒有辦法
// 用一般 SPA 那種「build 時注入環境變數」的做法，所以沿用原本 dose_response.js
// 就有的 hostname 判斷方式，只是把它搬到這一個檔案集中管理，而不是每支
// script 各自寫一份。
//
// 必須在其他會用到 BACKEND_BASE_URL 的 <script> 之前載入。
// =========================================================

const BACKEND_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? "http://127.0.0.1:8000"
  : "https://igem-ncku-software.onrender.com";
