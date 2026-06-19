const form = document.getElementById("unlock-form");
const pinInput = document.getElementById("pin");
const errorEl = document.getElementById("error");
const versionEl = document.getElementById("extension-version");
const subtitleEl = document.getElementById("lock-subtitle");
const forgotRow = document.getElementById("forgot-row");
const forgotBtn = document.getElementById("forgot-pin");
const forgotPanel = document.getElementById("forgot-panel");
const resetConfirmPanel = document.getElementById("reset-confirm-panel");
const openRecoveryBtn = document.getElementById("open-recovery");
const resetLockBtn = document.getElementById("reset-lock");
const forgotCancelBtn = document.getElementById("forgot-cancel");
const resetConfirmYes = document.getElementById("reset-confirm-yes");
const resetConfirmNo = document.getElementById("reset-confirm-no");

const RECOVERY_URL = "https://secure.cubescenter.org/recovery";

const manifest = chrome.runtime.getManifest();
if (versionEl && manifest?.version) {
  versionEl.textContent = `Browser Secure v${manifest.version}`;
}

chrome.runtime.sendMessage({ type: "LOCK_UI_READY" }).catch(() => {});

try {
  chrome.runtime.connect({ name: "lock-ui" });
} catch {
  /* ignore */
}

window.addEventListener("pagehide", () => {
  chrome.runtime.sendMessage({ type: "LOCK_UI_USER_CLOSED" }).catch(() => {});
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const pin = pinInput.value.trim();
  if (!pin) return;

  const res = await chrome.runtime.sendMessage({ type: "VERIFY_PIN", pin });
  if (res?.ok) {
    pinInput.value = "";
  } else {
    errorEl.hidden = false;
    pinInput.value = "";
    pinInput.focus();
  }
});

function setLockView(view) {
  const isUnlock = view === "unlock";
  const isForgot = view === "forgot";
  const isConfirm = view === "confirm";

  form.hidden = !isUnlock;
  forgotRow.hidden = !isUnlock;
  forgotPanel.hidden = !isForgot;
  resetConfirmPanel.hidden = !isConfirm;

  if (subtitleEl) subtitleEl.hidden = !isUnlock;

  const note = document.getElementById("lock-note");
  if (note) note.classList.toggle("note-hidden", !isUnlock);
  if (versionEl) versionEl.hidden = !isUnlock;

  if (isUnlock) pinInput.focus();
}

forgotBtn.addEventListener("click", () => setLockView("forgot"));
forgotCancelBtn.addEventListener("click", () => setLockView("unlock"));
resetConfirmNo.addEventListener("click", () => setLockView("forgot"));

resetLockBtn.addEventListener("click", () => setLockView("confirm"));

openRecoveryBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: RECOVERY_URL });
});

resetConfirmYes.addEventListener("click", async () => {
  resetConfirmYes.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "RESET_LOCK_STATE" });
    chrome.runtime.openOptionsPage();
  } finally {
    resetConfirmYes.disabled = false;
  }
});

chrome.runtime.sendMessage({ type: "IS_LOCKED" });
pinInput.focus();
