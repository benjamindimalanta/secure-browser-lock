const form = document.getElementById("unlock-form");
const pinInput = document.getElementById("pin");
const errorEl = document.getElementById("error");
const versionEl = document.getElementById("extension-version");
const forgotBtn = document.getElementById("forgot-pin");
const forgotPanel = document.getElementById("forgot-panel");
const openRecoveryBtn = document.getElementById("open-recovery");
const resetLockBtn = document.getElementById("reset-lock");
const forgotCancelBtn = document.getElementById("forgot-cancel");

const RECOVERY_URL = "https://secure.cubescenter.org/recovery";

const manifest = chrome.runtime.getManifest();
if (versionEl && manifest?.version) {
  versionEl.textContent = `Browser Secure v${manifest.version}`;
}

chrome.runtime.sendMessage({ type: "LOCK_UI_READY" }).catch(() => {});

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

function showForgotPanel(show) {
  forgotPanel.hidden = !show;
  form.hidden = show;
  forgotBtn.hidden = show;
  if (!show) {
    pinInput.focus();
  }
}

forgotBtn.addEventListener("click", () => showForgotPanel(true));
forgotCancelBtn.addEventListener("click", () => showForgotPanel(false));

openRecoveryBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: RECOVERY_URL });
});

resetLockBtn.addEventListener("click", async () => {
  const ok = confirm(
    "Reset lock and clear your saved PIN?\n\nYou will need to set a new PIN in extension Settings."
  );
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: "RESET_LOCK_STATE" });
  chrome.runtime.openOptionsPage();
});

chrome.runtime.sendMessage({ type: "IS_LOCKED" });
pinInput.focus();
