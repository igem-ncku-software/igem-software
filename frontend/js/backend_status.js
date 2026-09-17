// =========================================================
// Footer "backend connection status" indicator: polls GET /health periodically and
// switches style between reachable / unreachable.
// Target element: #backend-status
// Depends on js/config.js's global BACKEND_BASE_URL, so this must load after it.
// =========================================================

const BACKEND_STATUS_POLL_INTERVAL_MS = 12000; // 12 s, within the required 10-15 s range

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
