const statusEl = document.getElementById("status");
const unlockedPanel = document.getElementById("unlocked-panel");
const lockedPanel = document.getElementById("locked-panel");
const lockBtn = document.getElementById("lock-btn");
const focusLockBtn = document.getElementById("focus-lock-btn");
const settingsLink = document.getElementById("settings-link");

settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

lockBtn.addEventListener("click", async () => {
  lockBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: "LOCK" });
  window.close();
});

focusLockBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "FOCUS_LOCK" });
  window.close();
});

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });

  if (!state.isConfigured) {
    statusEl.textContent = "Set up your PIN first";
    statusEl.className = "status";
    unlockedPanel.hidden = false;
    lockedPanel.hidden = true;
    lockBtn.textContent = "Open setup";
    lockBtn.className = "btn primary";
    lockBtn.onclick = () => chrome.runtime.openOptionsPage();
    return;
  }

  if (state.isLocked) {
    statusEl.textContent = "Browser is locked";
    statusEl.className = "status locked";
    unlockedPanel.hidden = true;
    lockedPanel.hidden = false;
  } else {
    statusEl.textContent = "Browser is unlocked";
    statusEl.className = "status unlocked";
    unlockedPanel.hidden = false;
    lockedPanel.hidden = true;
    lockBtn.textContent = "Lock browser";
    lockBtn.className = "btn danger";
    lockBtn.disabled = false;
    lockBtn.onclick = null;
  }
}

refresh();
