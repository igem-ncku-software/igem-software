// =========================================================
// Backs hardware-calibration.html: creates a calibration plan and measures each tube in slot order.
//
// State machine (derived from the plan data, not stored separately):
//   no_plan      -> shows only the create form (no ?plan= in the URL)
//   plan_created -> list, progress 0/N, Read enabled
//   running      -> progress n/N, Read enabled, Go to fit disabled
//   complete     -> everything measured, Go to fit enabled
//
// The instrument has only one cuvette, so "what's the next tube" is pinned in a sticky
// block at the top of the page; pressing Read measures the "next tube", records it
// automatically, and advances to the next one. An already-measured tube can be redone with Re-read.
//
// Target elements: #plan-create-card / #plan-form / #plan-* family, see the HTML
// Backing API: createCalibrationPlan / getCalibrationPlan / recordPlanMeasurement /
//   readSample / getDeviceStatus
// =========================================================

let plan = null;
let planDeviceFingerprint = null; // null = device unreachable, config can't be confirmed
let rereadSlot = null; // the slot the user pressed Re-read on; null means measure the "next tube"
let planReading = false;

const PLAN_STATE_CHIP = {
  plan_created: ["Plan created", ""],
  running: ["Running", "warn"],
  complete: ["Complete", "ok"],
};

function parseConcentrationList(text) {
  return text.split(/[\s,;]+/).filter(Boolean).map(Number);
}

function planState(p) {
  if (!p) return "no_plan";
  const read = p.items.filter((it) => it.measurement).length;
  if (read === 0) return "plan_created";
  return read < p.items.length ? "running" : "complete";
}

function targetItem() {
  if (rereadSlot !== null) return plan.items.find((it) => it.slot === rereadSlot);
  return plan.items.find((it) => it.measurement === null) ?? null;
}

// ---- no_plan ---------------------------------------------------------

function updatePlanPreview() {
  const concentrations = parseConcentrationList(document.getElementById("plan-concentrations").value);
  const replicates = Number(document.getElementById("plan-replicates").value);
  const blanks = Number(document.getElementById("plan-blanks").value);
  const preview = document.getElementById("plan-preview");

  const unique = new Set(concentrations);
  if (concentrations.length === 0 || concentrations.some((c) => !(c > 0)) || !(replicates >= 1) || !(blanks >= 0)) {
    preview.textContent = "";
    return;
  }
  const total = unique.size * replicates + blanks;
  preview.textContent = `${total} tubes: ${unique.size} concentrations × ${replicates} replicates + ${blanks} blanks`;
}

async function showCreateForm(errorText) {
  plan = null;
  document.getElementById("plan-run-card").hidden = true;
  document.getElementById("plan-create-card").hidden = false;
  updatePlanPreview();
  if (errorText) setHardwareStatus(document.getElementById("plan-create-status"), errorText, "error");

  // The last plan worked on in this browser: offer a link to resume it, but don't jump there automatically.
  const lastId = hardwareRecall(HARDWARE_LAST_PLAN_KEY);
  if (!lastId) return;
  try {
    const last = await HardwareApi.getCalibrationPlan(lastId);
    const read = last.items.filter((it) => it.measurement).length;
    const resume = document.getElementById("plan-resume");
    resume.textContent = "";
    resume.append(`Last run in this browser: ${read} / ${last.items.length} tubes read. `,
      hwLink(`hardware-calibration.html?plan=${encodeURIComponent(last.plan_id)}`, `Resume ${last.plan_id} →`));
    resume.hidden = false;
  } catch (err) {
    hardwareRemember(HARDWARE_LAST_PLAN_KEY, null);
  }
}

async function createPlan(event) {
  event.preventDefault();
  const button = document.getElementById("plan-create-button");
  const statusEl = document.getElementById("plan-create-status");

  button.disabled = true;
  setHardwareStatus(statusEl, "Creating plan...", null);

  try {
    // The plan is bound to the device's current config, so the device must be reachable to create one (the API layer checks the device first).
    const created = await HardwareApi.createCalibrationPlan({
      concentrations_nM: parseConcentrationList(document.getElementById("plan-concentrations").value),
      replicates: Number(document.getElementById("plan-replicates").value),
      blanks: Number(document.getElementById("plan-blanks").value),
      timepoint: document.getElementById("plan-timepoint").value,
    });
    // Carry the plan id in the URL: a refresh or a shared link both return to the same run.
    history.replaceState(null, "", `?plan=${encodeURIComponent(created.plan_id)}`);
    setHardwareStatus(statusEl, "", null);
    await openPlan(created.plan_id, created);
  } catch (err) {
    console.error("Plan creation failed:", err);
    setHardwareStatus(statusEl, `Could not create plan: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

// ---- plan_created / running / complete ---------------------------------

async function openPlan(planId, alreadyLoaded) {
  document.getElementById("plan-create-card").hidden = true;
  const runCard = document.getElementById("plan-run-card");

  // The plan lives in the browser: it still opens when the device is unreachable, just without a config check.
  const [planResult, statusResult] = await Promise.allSettled([
    alreadyLoaded ? Promise.resolve(alreadyLoaded) : HardwareApi.getCalibrationPlan(planId),
    HardwareApi.getDeviceStatus(),
  ]);

  if (planResult.status === "rejected") {
    console.error("Failed to load plan:", planResult.reason);
    showCreateForm(`Could not load plan ${planId}: ${planResult.reason.message}`);
    return;
  }

  plan = planResult.value;
  planDeviceFingerprint = statusResult.status === "fulfilled" ? statusResult.value.config.fingerprint : null;
  hardwareRemember(HARDWARE_LAST_PLAN_KEY, plan.plan_id);
  runCard.hidden = false;
  renderPlan();
  if (statusResult.status === "rejected") {
    setHardwareStatus(document.getElementById("plan-read-status"), `Read unavailable: ${statusResult.reason.message}`, "error");
  }
  document.getElementById("plan-read-button").focus();
}

function renderPlan() {
  const total = plan.items.length;
  const read = plan.items.filter((it) => it.measurement).length;
  const state = planState(plan);
  const target = targetItem();

  document.getElementById("plan-title").textContent = plan.plan_id;

  const [stateText, stateKind] = PLAN_STATE_CHIP[state];
  const chip = document.getElementById("plan-state");
  chip.textContent = stateText;
  chip.className = `flag-chip ${stateKind}`.trim();

  const meta = document.getElementById("plan-meta");
  meta.textContent = "";
  meta.append(`Timepoint ${plan.timepoint} · created ${formatLocalTime(plan.created_at)} · bound to config `,
    hwFingerprint(plan.config_fingerprint));

  const configWarning = document.getElementById("plan-config-warning");
  configWarning.hidden = planDeviceFingerprint === plan.config_fingerprint;
  if (planDeviceFingerprint === null) {
    setHardwareStatus(configWarning,
      "The instrument is unreachable, so its config can't be checked against this plan.", "warn");
  } else if (!configWarning.hidden) {
    setHardwareStatus(configWarning,
      `The instrument now runs config ${planDeviceFingerprint}, not this plan's ${plan.config_fingerprint}. New readings will be flagged STALE_CONFIG and cannot be fitted.`,
      "error");
  }

  // Next-tube prompt
  const banner = document.getElementById("next-tube");
  const label = document.getElementById("next-tube-label");
  const value = document.getElementById("next-tube-value");
  banner.classList.toggle("is-reread", rereadSlot !== null);
  banner.classList.toggle("is-done", !target);
  if (rereadSlot !== null) {
    label.textContent = "Re-read";
    value.textContent = `${target.label} (tube ${target.slot} of ${total})`;
  } else if (target) {
    label.textContent = "Next tube";
    value.textContent = `${target.label} (tube ${target.slot} of ${total})`;
  } else {
    label.textContent = "All tubes read";
    value.textContent = `${total} / ${total} tubes read. Ready to fit.`;
  }
  document.getElementById("plan-cancel-reread").hidden = rereadSlot === null;

  const progress = document.getElementById("plan-progress");
  progress.setAttribute("aria-valuemax", String(total));
  progress.setAttribute("aria-valuenow", String(read));
  document.getElementById("plan-progress-fill").style.width = `${(read / total) * 100}%`;
  document.getElementById("plan-progress-text").textContent = `${read} / ${total} read (${formatPercent(read / total)})`;

  const readButton = document.getElementById("plan-read-button");
  readButton.textContent = target ? `Read ${target.label}` : "Read";
  setBlocked(readButton, document.getElementById("plan-read-reason"),
    target ? null : "Every tube has been read. Use Re-read on a row to replace a reading.");
  if (planReading) readButton.disabled = true;

  const fitButton = document.getElementById("plan-fit-button");
  fitButton.classList.toggle("btn-secondary", state !== "complete");
  setBlocked(fitButton, document.getElementById("plan-fit-reason"),
    state === "complete" ? null : `${total - read} of ${total} tubes are still unread. Every tube must be read before fitting.`);

  renderPlanTable(target);
}

function renderPlanTable(target) {
  const tbody = document.getElementById("plan-table-body");
  tbody.innerHTML = "";

  for (const item of plan.items) {
    const m = item.measurement;
    const row = hwEl("tr");
    if (target && item.slot === target.slot) row.classList.add("is-target");

    const statusCell = hwEl("td");
    if (!m) statusCell.appendChild(hwEl("span", "flag-chip", "Pending"));
    else if (m.flags.length === 0) statusCell.appendChild(hwEl("span", "flag-chip ok", "Read"));
    else statusCell.appendChild(renderFlagChips(m.flags));

    const actionCell = hwEl("td");
    if (m) {
      const reread = hwEl("button", "btn-secondary table-button", "Re-read");
      reread.type = "button";
      reread.disabled = planReading;
      reread.setAttribute("aria-label", `Re-read slot ${item.slot}, ${item.label}`);
      reread.addEventListener("click", () => {
        rereadSlot = item.slot;
        setHardwareStatus(document.getElementById("plan-read-status"),
          `Put ${item.label} back in the reader, then press Read.`, null);
        renderPlan();
        document.getElementById("plan-read-button").focus();
      });
      actionCell.appendChild(reread);
    }

    row.append(
      hwEl("td", null, String(item.slot)),
      hwEl("td", null, item.label),
      statusCell,
      hwEl("td", null, m ? formatFluorescence(m.fluorescence) : "--"),
      hwEl("td", null, m ? formatLocalTime(m.timestamp_utc) : "--"),
      actionCell,
    );
    tbody.appendChild(row);
  }
}

async function readPlanTarget() {
  const item = targetItem();
  if (!item || planReading) return;

  const statusEl = document.getElementById("plan-read-status");
  planReading = true;
  renderPlan();
  setHardwareStatus(statusEl, `Reading tube ${item.slot} (${item.label})...`, null);

  try {
    const input = {
      sample_id: `${plan.plan_id}-${String(item.slot).padStart(2, "0")}`,
      sample_type: item.sample_type,
    };
    if (item.sample_type === "standard") input.known_concentration_nM = item.concentration_nM;

    const [m, status] = await Promise.all([HardwareApi.readSample(input), HardwareApi.getDeviceStatus()]);
    planDeviceFingerprint = status.config.fingerprint;
    plan = await HardwareApi.recordPlanMeasurement(plan.plan_id, item.slot, m);
    rereadSlot = null;

    const recorded = plan.items.find((it) => it.slot === item.slot).measurement;
    const flagText = recorded.flags.length ? ` Flags: ${recorded.flags.join(", ")}.` : "";
    setHardwareStatus(statusEl,
      `Recorded tube ${item.slot} (${item.label}): ${formatFluorescence(recorded.fluorescence)} ${HARDWARE_FLUORESCENCE_UNIT}.${flagText}`,
      recorded.flags.length ? "warn" : "success");
  } catch (err) {
    console.error("Plan reading failed:", err);
    setHardwareStatus(statusEl, `Read failed for tube ${item.slot}: ${err.message}`, "error");
  } finally {
    planReading = false;
    renderPlan();
    document.getElementById("plan-read-button").focus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("plan-form");
  form.addEventListener("submit", createPlan);
  form.addEventListener("input", updatePlanPreview);

  document.getElementById("plan-read-button").addEventListener("click", readPlanTarget);
  document.getElementById("plan-cancel-reread").addEventListener("click", () => {
    rereadSlot = null;
    setHardwareStatus(document.getElementById("plan-read-status"), "", null);
    renderPlan();
  });
  document.getElementById("plan-fit-button").addEventListener("click", () => {
    window.location.href = `hardware-calibration-fit.html?plan=${encodeURIComponent(plan.plan_id)}`;
  });

  const planId = hardwareQueryParam("plan");
  if (planId) openPlan(planId);
  else showCreateForm();
});
