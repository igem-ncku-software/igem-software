// =========================================================
// Backs hardware-data.html: the one place to back up, restore, or delete everything the
// CAPTURE-Screen workflow stores in this browser. Not a workflow step; it serves all of them.
// Target elements: #backup-* family (one file holding runs, curves and batches), #reset-* family (delete all)
// Backing API (js/hardware_api.js): exportBackup / importBackup / markBatchesExported /
//   getResetPreview / resetAll
// =========================================================

// ---- Backup ---------------------------------------------------------------
// The workflow's data in one file. Deliberately one file: a curve means nothing without the run
// it was fitted from, and a batch nothing without its curve.

const BACKUP_SECTIONS = [["run", "plans"], ["curve", "curves"], ["batch", "batches"]];

function backupCount(n, word) {
  return `${n} ${word}${n === 1 ? "" : word.endsWith("h") ? "es" : "s"}`;
}

// When a backup file was last produced from this browser, or null. A stored value that isn't a
// date counts as never: this feeds a warning before a deletion, so it must not read as reassurance.
function lastBackupUtc() {
  const value = hardwareRecall(HARDWARE_LAST_BACKUP_KEY);
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function lastBackupText() {
  const last = lastBackupUtc();
  return last
    ? `Last exported ${formatLocalTime(last)} (${formatAgo(last)}).`
    : "Never exported from this browser.";
}

async function refreshBackupSummary() {
  const summaryEl = document.getElementById("backup-summary");
  try {
    const payload = await HardwareApi.exportBackup();
    const counts = BACKUP_SECTIONS.map(([word, key]) => backupCount(payload[key].length, word));
    const total = BACKUP_SECTIONS.reduce((sum, [, key]) => sum + payload[key].length, 0);
    summaryEl.textContent = `${counts.join(" · ")}. ${lastBackupText()}`;
    setBlocked(document.getElementById("backup-export-button"), document.getElementById("backup-export-reason"),
      total === 0 ? "Nothing stored in this browser yet." : null);
  } catch (err) {
    console.error("Could not read what is stored:", err);
    summaryEl.textContent = `Couldn't read what is stored: ${err.message}`;
  }
}

// The button and status line are parameters because two places export: the Backup card, and the
// Reset card's "Export everything first", whose result has to appear next to the button that was
// pressed rather than in a card that may be off screen.
async function exportBackup(
  button = document.getElementById("backup-export-button"),
  statusEl = document.getElementById("backup-export-status"),
) {
  if (button.disabled) return;

  button.disabled = true;
  try {
    const payload = await HardwareApi.exportBackup();
    const total = BACKUP_SECTIONS.reduce((sum, [, key]) => sum + payload[key].length, 0);
    if (total === 0) {
      setHardwareStatus(statusEl, "Nothing stored in this browser yet.", "warn");
      return;
    }
    hwDownloadJson(`lasreader-backup-${hwFileStamp()}.json`, payload);
    // The batches are in a file now, so the Measure page's "not exported" marks have to agree.
    await HardwareApi.markBatchesExported(payload.batches.map((batch) => batch.batch_id));
    hardwareRemember(HARDWARE_LAST_BACKUP_KEY, new Date().toISOString());
    setHardwareStatus(statusEl,
      `Exported ${BACKUP_SECTIONS.map(([word, key]) => backupCount(payload[key].length, word)).join(", ")}. `
      + "Check that the download completed before relying on it.", "success");
  } catch (err) {
    console.error("Backup export failed:", err);
    setHardwareStatus(statusEl, `Export failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
    // Both cards show what was last exported, so both have to catch up.
    refreshBackupSummary();
    if (!document.getElementById("reset-panel").hidden) refreshResetPanel();
  }
}

function backupImportFile() {
  return document.getElementById("backup-import-file").files?.[0] ?? null;
}

function updateBackupImportControls() {
  setBlocked(document.getElementById("backup-import-button"), document.getElementById("backup-import-reason"),
    backupImportFile() ? null : "Choose a backup file first.");
}

async function importBackup(event) {
  event.preventDefault();
  const button = document.getElementById("backup-import-button");
  const statusEl = document.getElementById("backup-import-status");
  const detail = document.getElementById("backup-import-detail");
  if (button.disabled) return;

  const file = backupImportFile();
  detail.innerHTML = "";
  detail.hidden = true;
  button.disabled = true;
  setHardwareStatus(statusEl, `Reading ${file.name}…`, null);

  try {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch (err) {
      // JSON.parse's own message names a byte offset, which tells the user nothing useful.
      throw new Error("That file isn't valid JSON.");
    }
    const result = await HardwareApi.importBackup(payload);

    const parts = [`Imported ${BACKUP_SECTIONS.map(([word, key]) => backupCount(result[key].imported.length, word)).join(", ")}.`];
    const skipped = BACKUP_SECTIONS.reduce((sum, [, key]) => sum + result[key].skipped.length, 0);
    const rejected = BACKUP_SECTIONS.flatMap(([word, key]) => result[key].rejected.map((item) => ({ ...item, word })));
    const entries = (n) => `${n} ${n === 1 ? "entry" : "entries"}`;
    if (skipped > 0) parts.push(`${entries(skipped)} already here, left as they were.`);
    if (rejected.length > 0) parts.push(`${entries(rejected.length)} rejected.`);
    setHardwareStatus(statusEl, parts.join(" "), rejected.length > 0 ? "warn" : "success");

    for (const { word, id, reason } of rejected) {
      const item = hwEl("li");
      item.append(hwEl("b", null, `${word} ${id}`), `: ${reason}`);
      detail.appendChild(item);
    }
    detail.hidden = rejected.length === 0;

    await refreshBackupSummary();
    refreshHardwareSteps();
  } catch (err) {
    console.error("Backup import failed:", err);
    setHardwareStatus(statusEl, `Import failed: ${err.message}`, "error");
  } finally {
    button.disabled = false;
    updateBackupImportControls();
  }
}

// ---- Reset ------------------------------------------------------------------
// Deletes everything this software stores in the browser. There is no undo, so it takes two
// deliberate steps (open the panel, then type the word), shows exactly what goes and whether it
// was ever backed up, and puts the backup one click away inside the panel. After the delete it
// checks that the storage is actually empty instead of trusting that removal worked.

const RESET_CONFIRM_WORD = "DELETE";

function resetTotal(preview) {
  return preview.runs + preview.curves + preview.batches;
}

// The Delete button is blocked when there is nothing to delete, and says so.
async function refreshResetOpenButton() {
  const openButton = document.getElementById("reset-open-button");
  try {
    const preview = await HardwareApi.getResetPreview();
    setBlocked(openButton, document.getElementById("reset-open-reason"),
      resetTotal(preview) === 0 && preview.keys === 0 ? "Nothing stored in this browser." : null);
  } catch (err) {
    console.error("Could not read what is stored:", err);
    // Leave it usable: failing to preview must never be the reason a delete can't be done.
    setBlocked(openButton, document.getElementById("reset-open-reason"), null);
  }
}

// What is about to be deleted, and how much of it exists nowhere else.
async function refreshResetPanel() {
  const summaryEl = document.getElementById("reset-summary");
  const warningEl = document.getElementById("reset-warning");
  const exportButton = document.getElementById("reset-export-button");

  let preview;
  try {
    preview = await HardwareApi.getResetPreview();
  } catch (err) {
    console.error("Could not read what is stored:", err);
    summaryEl.textContent = `Couldn't read what is stored: ${err.message}`;
    warningEl.hidden = true;
    return;
  }

  const total = resetTotal(preview);
  const counts = [["run", preview.runs], ["curve", preview.curves], ["batch", preview.batches]];
  summaryEl.textContent = total > 0
    ? `This deletes ${counts.map(([word, n]) => backupCount(n, word)).join(" · ")}.`
    : "There are no runs, curves, or batches. This clears the remembered page state.";

  // Only worth warning about when there is something to lose.
  warningEl.hidden = total === 0;
  exportButton.hidden = total === 0;
  if (total > 0) {
    const parts = [];
    if (preview.unexported_batches > 0) {
      parts.push(`${backupCount(preview.unexported_batches, "batch")} never exported.`);
    }
    // A backup time can't say what was added after it, so it is never presented as "all safe".
    parts.push(lastBackupUtc()
      ? `${lastBackupText()} Anything added since isn't in it.`
      : "Never exported from this browser.");
    warningEl.textContent = parts.join(" ");
  }
}

function updateResetConfirmControls() {
  const typed = document.getElementById("reset-confirm-input").value.trim();
  setBlocked(document.getElementById("reset-confirm-button"), document.getElementById("reset-confirm-reason"),
    typed === RESET_CONFIRM_WORD ? null : `Type ${RESET_CONFIRM_WORD} to enable.`);
}

function closeResetPanel() {
  document.getElementById("reset-panel").hidden = true;
  document.getElementById("reset-confirm-input").value = "";
  document.getElementById("reset-open-button").hidden = false;
  refreshResetOpenButton();
}

async function openResetPanel() {
  const openButton = document.getElementById("reset-open-button");
  if (openButton.disabled) return;

  setHardwareStatus(document.getElementById("reset-status"), "", null);
  document.getElementById("reset-confirm-input").value = "";
  updateResetConfirmControls();
  await refreshResetPanel();
  openButton.hidden = true;
  document.getElementById("reset-panel").hidden = false;
  document.getElementById("reset-confirm-input").focus();
}

async function confirmReset() {
  const confirmButton = document.getElementById("reset-confirm-button");
  const statusEl = document.getElementById("reset-status");
  if (confirmButton.disabled) return;
  // Re-checked here as well as in the button state: the typed word is the whole safeguard.
  if (document.getElementById("reset-confirm-input").value.trim() !== RESET_CONFIRM_WORD) return;

  const panelButtons = document.querySelectorAll("#reset-panel button");
  panelButtons.forEach((button) => { button.disabled = true; });
  setHardwareStatus(statusEl, "Deleting…", null);

  try {
    const result = await HardwareApi.resetAll();
    const after = await HardwareApi.getResetPreview();
    const leftover = resetTotal(after) > 0 || after.keys > 0 || result.remaining.length > 0;

    if (result.storage_unavailable) {
      // Nothing was ever persisted, so there is nothing more to delete; only the memory copy existed.
      setHardwareStatus(statusEl,
        "This browser blocks storage, so nothing was saved on disk. The copy held in memory was cleared.", "warn");
    } else if (leftover) {
      setHardwareStatus(statusEl,
        `Deletion did not complete: ${backupCount(result.remaining.length || after.keys, "stored item")} still present. `
        + "Clear this site's data in the browser settings.", "error");
    } else {
      setHardwareStatus(statusEl,
        "Deleted. This browser now holds no runs, curves, batches, or remembered page state.", "success");
    }
  } catch (err) {
    console.error("Reset failed:", err);
    setHardwareStatus(statusEl, `Reset failed: ${err.message}`, "error");
  } finally {
    // Whatever happened, what the page shows has to be re-read from storage.
    closeResetPanel();
    panelButtons.forEach((button) => { button.disabled = false; });
    updateResetConfirmControls();
    refreshBackupSummary();
    refreshHardwareSteps();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  refreshBackupSummary();
  updateBackupImportControls();
  // A wrapper, not the function itself: a click would otherwise pass the event as the first argument.
  document.getElementById("backup-export-button").addEventListener("click", () => exportBackup());
  document.getElementById("backup-import-form").addEventListener("submit", importBackup);
  document.getElementById("backup-import-file").addEventListener("change", updateBackupImportControls);

  refreshResetOpenButton();
  updateResetConfirmControls();
  document.getElementById("reset-open-button").addEventListener("click", openResetPanel);
  document.getElementById("reset-cancel-button").addEventListener("click", () => {
    setHardwareStatus(document.getElementById("reset-status"), "", null);
    closeResetPanel();
  });
  document.getElementById("reset-confirm-input").addEventListener("input", updateResetConfirmControls);
  document.getElementById("reset-confirm-button").addEventListener("click", confirmReset);
  document.getElementById("reset-export-button").addEventListener("click", () =>
    exportBackup(document.getElementById("reset-export-button"), document.getElementById("reset-status")));
});
