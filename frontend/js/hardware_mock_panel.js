// =========================================================
// Mock 控制面板：只在 API 層還是 mock 的時候存在。
// 讓 demo 能觸發邊界狀況：極低 / 極高螢光的 unknown、組態變更（換 gain，
// 所有舊曲線變 stale、高訊號會 SATURATED）、儀器離線、缺 dark frame。
//
// 它直接改 js/hardware_mock.js 的模擬開關，不經過 HardwareApi，因為真後端
// 不會有這些開關。接上真後端時，把這支和 hardware_mock.js 從每個
// hardware 頁面的 <script> 一起拿掉即可，頁面本身不受影響。
// 插在頁尾前面，收在預設關閉的 <details> 裡。
// =========================================================

const MOCK_PANEL_OPEN_KEY = "lasreader.hardware.mockPanelOpen";

// 極低 / 極高兩個選項直接指定期望螢光，而不是給一個極端濃度：濃度 0 的讀值
// 仍然是 blank 加噪音，有時候會合法地落在 LOD 上面，邊界測試就不穩定。
const MOCK_PANEL_UNKNOWN_PRESETS = [
  { value: "random", label: "Random concentration, 3–1000 nM", sim: { unknown_nM: null, unknown_signal: null } },
  { value: "low", label: "Very low signal: 50 counts (below any blank)", sim: { unknown_nM: null, unknown_signal: 50 } },
  { value: "high", label: "Very high signal: 5000 counts (above the curve top)", sim: { unknown_nM: null, unknown_signal: 5000 } },
  { value: "custom", label: "Custom concentration...", sim: null },
];

const MOCK_PANEL_GAINS = [
  { value: 16, label: "16× (default)" },
  { value: 64, label: "64×" },
  { value: 512, label: "512× (high signal saturates)" },
];

function mockPanelField(id, labelText, ...controls) {
  const field = hwEl("div", "field");
  const label = hwEl("label", null, labelText);
  label.htmlFor = id;
  controls[0].id = id;
  field.append(label, ...controls);
  return field;
}

function mockPanelCheck(id, labelText, checked, onChange) {
  const label = hwEl("label", "check-field");
  const input = hwEl("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  label.append(input, labelText);
  return label;
}

function mockPanelCurrentPreset(sim) {
  const signalPreset = MOCK_PANEL_UNKNOWN_PRESETS.find((p) => p.sim && p.sim.unknown_signal !== null && p.sim.unknown_signal === sim.unknown_signal);
  if (signalPreset) return signalPreset.value;
  return sim.unknown_nM === null ? "random" : "custom";
}

function renderMockPanel() {
  if (typeof HardwareMock === "undefined") return;
  const footer = document.querySelector(".site-footer");
  if (!footer) return;

  const sim = HardwareMock.getSim();

  const panel = hwEl("section", "card mock-panel");
  const details = hwEl("details");
  try {
    details.open = sessionStorage.getItem(MOCK_PANEL_OPEN_KEY) === "1";
  } catch (err) {
    // 沒有 sessionStorage 就每次都收起。
  }
  details.addEventListener("toggle", () => {
    try {
      sessionStorage.setItem(MOCK_PANEL_OPEN_KEY, details.open ? "1" : "0");
    } catch (err) {
      // 同上。
    }
  });

  details.appendChild(hwEl("summary", "section-label", "Mock controls · simulated instrument, no backend"));
  details.appendChild(hwEl("p", "section-description",
    "Every number on these pages comes from a simulated reader. Plans, curves, and these settings are stored in this browser only."));

  const grid = hwEl("div", "form-grid");

  // unknown 樣品
  const preset = hwEl("select");
  for (const option of MOCK_PANEL_UNKNOWN_PRESETS) {
    const el = hwEl("option", null, option.label);
    el.value = option.value;
    preset.appendChild(el);
  }
  const custom = hwEl("input");
  custom.type = "number";
  custom.min = "0";
  custom.step = "any";
  custom.placeholder = "nM";
  custom.setAttribute("aria-label", "Custom unknown concentration (nM)");

  preset.value = mockPanelCurrentPreset(sim);
  custom.hidden = preset.value !== "custom";
  if (preset.value === "custom") custom.value = String(sim.unknown_nM);

  const applyUnknown = () => {
    custom.hidden = preset.value !== "custom";
    const chosen = MOCK_PANEL_UNKNOWN_PRESETS.find((p) => p.value === preset.value);
    if (chosen.sim) {
      HardwareMock.setSim(chosen.sim);
    } else {
      const value = Number(custom.value);
      if (custom.value !== "" && value >= 0) HardwareMock.setSim({ unknown_nM: value, unknown_signal: null });
    }
  };
  preset.addEventListener("change", applyUnknown);
  custom.addEventListener("input", applyUnknown);
  grid.appendChild(mockPanelField("mock-unknown-preset", "Unknown samples read as", preset, custom));

  // gain：換 gain 就換 config fingerprint，頁面上的組態資訊要重新載入。
  const gain = hwEl("select");
  for (const option of MOCK_PANEL_GAINS) {
    const el = hwEl("option", null, option.label);
    el.value = String(option.value);
    gain.appendChild(el);
  }
  gain.value = String(sim.gain);
  gain.addEventListener("change", () => {
    HardwareMock.setSim({ gain: Number(gain.value) });
    window.location.reload();
  });
  grid.appendChild(mockPanelField("mock-gain", "Instrument gain (changes the config)", gain));

  details.appendChild(grid);

  const checks = hwEl("div", "button-row");
  checks.append(
    mockPanelCheck("mock-offline", "Instrument offline", sim.offline, (checked) => {
      HardwareMock.setSim({ offline: checked });
      window.location.reload();
    }),
    mockPanelCheck("mock-drop-dark", "Drop the paired dark frame (NO_DARK_PAIR)", sim.drop_dark, (checked) => {
      HardwareMock.setSim({ drop_dark: checked });
    }),
  );
  details.appendChild(checks);

  const reset = hwEl("button", "btn-secondary", "Reset all mock data");
  reset.type = "button";
  reset.addEventListener("click", () => {
    if (!window.confirm("Delete every mock plan, curve, and setting stored in this browser?")) return;
    HardwareMock.reset();
    hardwareRemember(HARDWARE_LAST_PLAN_KEY, null);
    hardwareRemember(HARDWARE_LAST_DARK_READ_KEY, null);
    window.location.href = "hardware.html";
  });
  details.appendChild(reset);

  panel.appendChild(details);
  footer.before(panel);
}

document.addEventListener("DOMContentLoaded", renderMockPanel);
