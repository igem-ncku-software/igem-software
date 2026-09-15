// =========================================================
// 對接 hardware-measure.html：量一管樣品，顯示 sfGFP 訊號、反推濃度、
// QC flags、十通道長條圖與組態 provenance。
// 目標元素：
//   #measure-curve（右上角目前使用的曲線）
//   #measure-form / #measure-sample-id / #measure-sample-type
//   #measure-known-field / #measure-known-concentration / #measure-read-button
//   #measure-status / #measure-result / #measure-signal(-sub)
//   #measure-concentration(-sub) / #measure-flags / #measure-channel-chart / #measure-provenance
// 對接 API：getActiveCurve / getDeviceStatus / readSample / invert
//
// 反推結果只有 status === "ok" 才顯示數字濃度。其他狀態一律不給點估計，
// 曲線範圍外絕對不外插。
// =========================================================

let channelChart = null;

// 在 F4 / F3 長條上方標註文字。Chart.js 沒有內建 annotation，外掛又是新依賴，
// 所以自己畫。
const channelAnnotationPlugin = {
  id: "channelAnnotations",
  afterDatasetsDraw(chart, _args, options) {
    const meta = chart.getDatasetMeta(0);
    const { ctx } = chart;
    HARDWARE_CHANNELS.forEach((channel, i) => {
      const note = options.annotations?.[channel.key];
      const bar = meta.data[i];
      if (!note || !bar) return;
      ctx.save();
      ctx.fillStyle = note.color;
      ctx.font = "700 12px 'Segoe UI', 'Noto Sans TC', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(note.text, bar.x, Math.min(bar.y, bar.base) - 6);
      ctx.restore();
    });
  },
};

function renderCurveChip(curve, config) {
  const el = document.getElementById("measure-curve");
  el.innerHTML = "";
  el.appendChild(hwEl("span", "curve-chip-label", "Curve in use"));

  if (!curve) {
    el.append(hwEl("strong", null, "No active curve"), hwLink("hardware-calibration.html", "Run a calibration →"));
    return;
  }

  const stale = config && curve.config_fingerprint !== config.fingerprint;
  const bound = hwEl("span");
  bound.append("Config ", hwFingerprint(curve.config_fingerprint));
  if (stale) bound.append(" ", hwEl("span", "flag-chip error", "stale"));

  el.append(
    hwEl("strong", null, curve.curve_id),
    hwEl("span", null, `Fitted ${formatLocalTime(curve.fitted_at)}`),
    bound,
  );
}

async function refreshCurveChip() {
  try {
    const [curve, status] = await Promise.all([HardwareApi.getActiveCurve(), HardwareApi.getDeviceStatus()]);
    renderCurveChip(curve, status.config);
  } catch (err) {
    document.getElementById("measure-curve").textContent = `Curve unavailable: ${err.message}`;
  }
}

function renderEstimate(estimate, curve, measurement) {
  const value = document.getElementById("measure-concentration");
  const sub = document.getElementById("measure-concentration-sub");
  value.classList.remove("is-message");
  sub.innerHTML = "";

  switch (estimate.status) {
    case "ok":
      value.textContent = formatConcentration(estimate.concentration_nM);
      sub.textContent = `95% CI ${formatConcentrationInterval(estimate.ci95_nM)}`;
      break;
    case "below_lod":
      // range_nM.min = max(LOD, lowest standard)，通常就等於 LOD。
      value.textContent = curve ? `< ${formatConcentration(curve.range_nM.min)}` : "< LOD";
      sub.textContent = curve
        ? `Below the curve's lower limit (LOD ${formatConcentration(curve.lod_nM)}). No point estimate.`
        : "Below LOD. No point estimate.";
      break;
    case "above_range":
      value.textContent = curve ? `> ${formatConcentration(curve.range_nM.max)}` : "> range";
      sub.textContent = "Above the calibrated range. No point estimate; dilute and read again.";
      break;
    case "no_curve":
      value.textContent = "No calibration curve yet";
      value.classList.add("is-message");
      sub.appendChild(hwLink("hardware-calibration.html", "Run a calibration →"));
      break;
    case "config_mismatch":
      value.textContent = "Instrument configuration changed. This curve does not apply.";
      value.classList.add("is-message");
      sub.appendChild(hwLink("hardware-calibration.html", "Rebuild the curve →"));
      break;
    default:
      value.textContent = "--";
  }

  if (measurement.sample_type === "standard") {
    const known = hwEl("span", "sensor-stat-sub", `Known: ${formatConcentration(measurement.known_concentration_nM)}`);
    sub.after(known);
  }
}

function renderChannelChart(raw) {
  const canvas = document.getElementById("measure-channel-chart");
  if (channelChart) channelChart.destroy();

  const accent = cssVar("--accent");
  const gold = cssVar("--gold");
  const goldInk = cssVar("--gold-ink");
  const muted = cssVar("--muted");
  const ink = cssVar("--text");
  const rule = cssVar("--border");

  const colors = HARDWARE_CHANNELS.map(({ key }) => {
    if (key === "F4") return accent;
    if (key === "F3") return gold;
    return muted;
  });

  channelChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: HARDWARE_CHANNELS.map((channel) => channel.axis),
      datasets: [{
        label: "Counts",
        data: HARDWARE_CHANNELS.map(({ key }) => raw[key]),
        backgroundColor: colors,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      aspectRatio: 2.6,
      animation: false,
      layout: { padding: { top: 8 } },
      scales: {
        x: {
          title: { display: true, text: "Channel center wavelength (nm)", color: ink },
          grid: { display: false },
          ticks: { color: muted },
        },
        y: {
          beginAtZero: true,
          grace: "12%", // 留空間給長條上方的標註文字
          title: { display: true, text: "Counts (dark-subtracted)", color: ink },
          grid: { color: rule },
          ticks: { color: muted },
        },
      },
      plugins: {
        legend: { display: false },
        channelAnnotations: {
          annotations: {
            F4: { text: "sfGFP 510 nm", color: accent },
            F3: { text: "leakage", color: goldInk },
          },
        },
      },
    },
    plugins: [channelAnnotationPlugin],
  });
}

function renderProvenance(m, config) {
  const el = document.getElementById("measure-provenance");
  el.innerHTML = "";

  const item = (label, value) => {
    const span = hwEl("span");
    span.append(hwEl("b", null, `${label} `), value);
    el.appendChild(span);
  };

  // 只有組態沒變時，目前的組態細節才代表這筆讀值；否則只能給 fingerprint。
  if (config && config.fingerprint === m.config_fingerprint) {
    item("LED", `${config.led_current_mA} mA`);
    item("Gain", `${config.gain}×`);
    item("ATIME / ASTEP", `${config.atime} / ${config.astep}`);
    item("Build", config.build_id);
  } else {
    item("Config details", "unavailable (the instrument config changed after this read)");
  }
  item("Config", hwFingerprint(m.config_fingerprint));
}

function nextSampleId(id) {
  const match = id.match(/^(.*?)(\d+)$/);
  if (!match) return id;
  return match[1] + String(Number(match[2]) + 1).padStart(match[2].length, "0");
}

async function readMeasureSample(event) {
  event.preventDefault();

  const idInput = document.getElementById("measure-sample-id");
  const sampleType = document.getElementById("measure-sample-type").value;
  const statusEl = document.getElementById("measure-status");
  const button = document.getElementById("measure-read-button");

  const sampleId = idInput.value.trim();
  if (!sampleId) {
    setHardwareStatus(statusEl, "Enter a sample ID first.", "error");
    return;
  }

  const input = { sample_id: sampleId, sample_type: sampleType };
  if (sampleType === "standard") {
    const known = Number(document.getElementById("measure-known-concentration").value);
    if (document.getElementById("measure-known-concentration").value === "" || !(known >= 0)) {
      setHardwareStatus(statusEl, "A standard needs its known concentration (nM).", "error");
      return;
    }
    input.known_concentration_nM = known;
  }

  button.disabled = true;
  // 先收起上一管的結果：讀取失敗時不能讓舊數字留在畫面上，看起來像這一管的。
  document.getElementById("measure-result").hidden = true;
  setHardwareStatus(statusEl, `Reading ${sampleId}...`, null);

  try {
    const [m, status] = await Promise.all([HardwareApi.readSample(input), HardwareApi.getDeviceStatus()]);
    const [estimate, curve] = await Promise.all([
      HardwareApi.invert(m.fluorescence, m.config_fingerprint),
      HardwareApi.getActiveCurve(),
    ]);
    // 兩個呼叫之間 active 曲線可能被換掉；對不上就不拿它的 LOD / range 來顯示。
    const matchingCurve = curve && curve.curve_id === estimate.curve_id ? curve : null;

    renderCurveChip(curve, status.config);

    document.getElementById("measure-result").hidden = false;
    document.getElementById("measure-signal").textContent = formatFluorescence(m.fluorescence);
    document.getElementById("measure-signal-sub").textContent =
      `± ${formatFluorescence(m.fluorescence_sd)} counts (SD) · scatter ${formatFluorescence(m.scatter)}`;
    renderEstimate(estimate, matchingCurve, m);

    const flags = document.getElementById("measure-flags");
    flags.innerHTML = "";
    flags.appendChild(renderFlagChips(m.flags));

    renderChannelChart(m.raw);
    renderProvenance(m, status.config);

    setHardwareStatus(statusEl, `Read ${m.sample_id} at ${formatLocalTime(m.timestamp_utc)}.`, m.flags.length ? "warn" : "success");
    idInput.value = nextSampleId(sampleId);
  } catch (err) {
    console.error("Measurement failed:", err);
    setHardwareStatus(statusEl, `Read failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  refreshCurveChip();

  const typeSelect = document.getElementById("measure-sample-type");
  typeSelect.addEventListener("change", () => {
    document.getElementById("measure-known-field").hidden = typeSelect.value !== "standard";
  });

  document.getElementById("measure-form").addEventListener("submit", readMeasureSample);
});
