const pinInput = document.getElementById("pin");
const pinConfirm = document.getElementById("pin-confirm");
const pinError = document.getElementById("pin-error");
const savePinBtn = document.getElementById("save-pin");
const autoStartup = document.getElementById("auto-startup");
const idleMinutes = document.getElementById("idle-minutes");
const saveSettingsBtn = document.getElementById("save-settings");
const settingsMsg = document.getElementById("settings-msg");

async function loadSettings() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  autoStartup.checked = state.autoLockOnStartup !== false;
  idleMinutes.value =
    state.idleLockMinutes != null ? state.idleLockMinutes : 5;
}

savePinBtn.addEventListener("click", async () => {
  pinError.hidden = true;
  const pin = pinInput.value.trim();
  const confirm = pinConfirm.value.trim();

  if (!/^\d{4,8}$/.test(pin)) {
    pinError.textContent = "PIN must be 4–8 digits.";
    pinError.hidden = false;
    return;
  }
  if (pin !== confirm) {
    pinError.textContent = "PINs do not match.";
    pinError.hidden = false;
    return;
  }

  const res = await chrome.runtime.sendMessage({ type: "SET_PIN", pin });
  if (!res?.ok) {
    pinError.textContent = "Could not save PIN.";
    pinError.hidden = false;
    return;
  }

  pinInput.value = "";
  pinConfirm.value = "";
  pinError.textContent = "PIN saved. You can lock from the toolbar icon.";
  pinError.style.color = "#4ade80";
  pinError.hidden = false;
});

saveSettingsBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    autoLockOnStartup: autoStartup.checked,
    idleLockMinutes: idleMinutes.value,
  });
  settingsMsg.hidden = false;
  setTimeout(() => {
    settingsMsg.hidden = true;
  }, 2000);
});

loadSettings();

// Reset idle timer on user activity in this tab (extension page)
["click", "keydown"].forEach((ev) => {
  document.addEventListener(ev, () => {
    chrome.runtime.sendMessage({ type: "RESET_IDLE" });
  });
});
