// =========================================================
// hardware 五個頁面共用：子導覽列 + 右上角儀器連線小標、數字格式、
// QC flag chips、AS7341 通道對照、停用按鈕的原因說明。
// 目標元素：#hardware-subnav（data-page 標示目前頁面）
// 依賴 js/hardware_api.js 的 HardwareApi，必須排在它後面、各頁面 script 前面載入。
// =========================================================

const HARDWARE_PAGES = [
  { key: "status", href: "hardware.html", label: "Status" },
  { key: "measure", href: "hardware-measure.html", label: "Measure" },
  { key: "calibration", href: "hardware-calibration.html", label: "Calibration" },
  { key: "fit", href: "hardware-calibration-fit.html", label: "Fit" },
  { key: "curves", href: "hardware-curves.html", label: "Curves" },
];

const DEVICE_STATUS_POLL_INTERVAL_MS = 12000;

// AS7341 的通道順序與中心波長。軸標籤用波長數字；Clear 沒有單一波長。
const HARDWARE_CHANNELS = [
  { key: "F1", axis: "415" },
  { key: "F2", axis: "445" },
  { key: "F3", axis: "480" },
  { key: "F4", axis: "515" },
  { key: "F5", axis: "555" },
  { key: "F6", axis: "590" },
  { key: "F7", axis: "630" },
  { key: "F8", axis: "680" },
  { key: "Clear", axis: "Clear" },
  { key: "NIR", axis: "910" },
];

// chip 顏色：error 代表這筆讀值不能用，warn 代表能用但要注意。
const FLAG_SEVERITY = {
  SATURATED: "error",
  NO_DARK_PAIR: "error",
  STALE_CONFIG: "error",
  HIGH_SCATTER: "warn",
  BELOW_LOD: "warn",
  ABOVE_RANGE: "warn",
};

// Chart.js 收的是實際色碼，沒辦法直接吃 CSS 變數，所以在這裡讀出來，
// 配色只有 css/style.css 的 :root 一個來源。
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---- 顯示規則：濃度 1 位小數（>1000 nM 改 µM）、螢光整數、百分比 1 位小數 ----

function formatConcentration(nM) {
  if (nM === null || nM === undefined || !Number.isFinite(nM)) return "--";
  return nM > 1000 ? `${(nM / 1000).toFixed(1)} µM` : `${nM.toFixed(1)} nM`;
}

function formatConcentrationInterval(interval) {
  if (!interval) return "--";
  return `${formatConcentration(interval[0])} – ${formatConcentration(interval[1])}`;
}

function formatFluorescence(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return String(Math.round(value) || 0); // `|| 0`：避免 Math.round(-0.3) 顯示成 "-0"
}

function formatPercent(fraction) {
  if (!Number.isFinite(fraction)) return "--";
  return `${(fraction * 100).toFixed(1)}%`;
}

// 資料一律存 UTC，畫面一律顯示瀏覽器的當地時間。
function formatLocalTime(utc) {
  return utc ? new Date(utc).toLocaleString() : "--";
}

function formatAgo(utc) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(utc)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// 4PL 方程式本身（沒有參數）。參數一律來自 API 回傳的 CalibrationCurve。
function fourPL(c, params) {
  if (c <= 0) return params.bottom;
  return params.bottom + (params.top - params.bottom) / (1 + (params.ec50_nM / c) ** params.hill);
}

// ---- DOM 小工具 -----------------------------------------------------

function hwEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function hwLink(href, text) {
  const a = hwEl("a", "text-link", text);
  a.href = href;
  return a;
}

function hwFingerprint(fingerprint) {
  return hwEl("span", "fingerprint", fingerprint);
}

function setHardwareStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = "status-message" + (kind ? ` ${kind}` : "");
}

// 因為「還不能做」而停用的按鈕，旁邊一定要寫出原因，不能只是變灰。
// reason 為空字串 / null 時啟用按鈕並隱藏說明。
function setBlocked(button, reasonEl, reason) {
  button.disabled = Boolean(reason);
  button.classList.toggle("is-blocked", Boolean(reason));
  if (reasonEl) {
    reasonEl.textContent = reason || "";
    reasonEl.hidden = !reason;
  }
}

function renderFlagChips(flags) {
  const row = hwEl("div", "chip-row");
  if (!flags || flags.length === 0) {
    row.appendChild(hwEl("span", "flag-chip ok", "QC pass"));
    return row;
  }
  for (const flag of flags) {
    row.appendChild(hwEl("span", `flag-chip ${FLAG_SEVERITY[flag] ?? "warn"}`, flag));
  }
  return row;
}

// 數字小卡：標題、大數字、一行補充說明。
function hwStatTile(label, value, sub) {
  const tile = hwEl("div", "sensor-stat");
  tile.appendChild(hwEl("span", "sensor-stat-label", label));
  tile.appendChild(hwEl("span", "sensor-stat-value", value));
  if (sub) tile.appendChild(hwEl("span", "sensor-stat-sub", sub));
  return tile;
}

// key/value 表格的一列；value 可以是字串或 DOM 節點。
function appendKvRow(tbody, label, value) {
  const row = hwEl("tr");
  const th = hwEl("th", null, label);
  th.scope = "row";
  const td = hwEl("td");
  if (value instanceof Node) td.appendChild(value);
  else td.textContent = value;
  row.append(th, td);
  tbody.appendChild(row);
}

// 十個通道的數值表（儀器狀態頁的暗讀 / blank 讀值用）。
function renderChannelTable(raw) {
  const wrapper = hwEl("div", "table-wrapper table-spaced");
  const table = hwEl("table", "channel-table");
  const head = hwEl("tr");
  const body = hwEl("tr");
  head.appendChild(Object.assign(hwEl("th", null, "Channel (nm)"), { scope: "row" }));
  body.appendChild(Object.assign(hwEl("th", null, "Counts"), { scope: "row" }));
  for (const { key, axis } of HARDWARE_CHANNELS) {
    head.appendChild(Object.assign(hwEl("th", null, axis), { scope: "col" }));
    body.appendChild(hwEl("td", null, formatFluorescence(raw[key])));
  }
  const thead = hwEl("thead");
  thead.appendChild(head);
  const tbody = hwEl("tbody");
  tbody.appendChild(body);
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function hardwareQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// ---- 瀏覽器端的小記憶（只是方便，不是資料） ---------------------------

const HARDWARE_LAST_PLAN_KEY = "lasreader.hardware.lastPlanId";
// 資料契約目前沒有「上次暗讀時間」，先由前端記住；後端補上欄位後改讀 API。
const HARDWARE_LAST_DARK_READ_KEY = "lasreader.hardware.lastDarkReadUtc";

function hardwareRemember(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    // 無痕模式或被停用：只是少了「接續上次」的便利。
  }
}

function hardwareRecall(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

// ---- 子導覽列與儀器狀態小標 -----------------------------------------

function renderHardwareSubnav() {
  const nav = document.getElementById("hardware-subnav");
  if (!nav) return;

  const list = hwEl("ul", "hw-subnav-links");
  for (const page of HARDWARE_PAGES) {
    const item = hwEl("li");
    const link = hwEl("a", null, page.label);
    link.href = page.href;
    if (page.key === nav.dataset.page) link.setAttribute("aria-current", "page");
    item.appendChild(link);
    list.appendChild(item);
  }

  const badge = hwEl("span", "backend-status-badge", "Device: checking...");
  badge.id = "device-status-badge";
  badge.setAttribute("aria-live", "polite");

  nav.append(list, badge);
}

async function refreshDeviceBadge() {
  const badge = document.getElementById("device-status-badge");
  if (!badge) return;
  try {
    const status = await HardwareApi.getDeviceStatus();
    badge.textContent = status.online ? `Device online · ${status.config.fingerprint}` : "Device offline";
    badge.classList.toggle("offline", !status.online);
  } catch (err) {
    badge.textContent = "Device unreachable";
    badge.classList.add("offline");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderHardwareSubnav();
  refreshDeviceBadge();
  setInterval(refreshDeviceBadge, DEVICE_STATUS_POLL_INTERVAL_MS);
});
