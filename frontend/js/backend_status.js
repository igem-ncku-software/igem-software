// =========================================================
// 頁尾「後端連線狀態」指示燈：定期打 GET /health，通/不通切換樣式。
// 目標元素：#backend-status
// 依賴 js/config.js 的全域 BACKEND_BASE_URL，這支必須排在它後面載入。
// =========================================================

const BACKEND_STATUS_POLL_INTERVAL_MS = 12000; // 12 秒，落在需求的 10-15 秒區間內

async function checkBackendStatus() {
  const el = document.getElementById("backend-status");
  if (!el) return;

  try {
    const res = await fetch(`${BACKEND_BASE_URL}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    el.textContent = "Backend online";
    el.classList.remove("offline");
  } catch (err) {
    el.textContent = "Backend offline";
    el.classList.add("offline");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  checkBackendStatus();
  setInterval(checkBackendStatus, BACKEND_STATUS_POLL_INTERVAL_MS);
});
