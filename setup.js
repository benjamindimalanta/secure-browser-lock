const pinSectionFirst = document.getElementById("pin-section-first");
const pinSectionChange = document.getElementById("pin-section-change");
const pinInput = document.getElementById("pin");
const pinConfirm = document.getElementById("pin-confirm");
const pinError = document.getElementById("pin-error");
const savePinBtn = document.getElementById("save-pin");
const currentPinInput = document.getElementById("current-pin");
const newPinInput = document.getElementById("new-pin");
const newPinConfirmInput = document.getElementById("new-pin-confirm");
const changePinError = document.getElementById("change-pin-error");
const changePinBtn = document.getElementById("change-pin-btn");
const autoStartup = document.getElementById("auto-startup");
const idleMinutes = document.getElementById("idle-minutes");
const saveSettingsBtn = document.getElementById("save-settings");
const settingsMsg = document.getElementById("settings-msg");
const versionEl = document.getElementById("extension-version");
const openSessionSettingsBtn = document.getElementById("open-session-settings");
const sessionSettingsMsg = document.getElementById("session-settings-msg");
const openShortcutsSettingsBtn = document.getElementById("open-shortcuts-settings");

const manifest = chrome.runtime.getManifest();
if (versionEl && manifest?.version) {
  versionEl.textContent = `Version ${manifest.version}`;
}

function validatePinFormat(pin) {
  return /^\d{4,8}$/.test(pin);
}

async function loadSettings() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  autoStartup.checked = state.autoLockOnStartup !== false;
  idleMinutes.value =
    state.idleLockMinutes != null ? state.idleLockMinutes : 10;

  if (state.isConfigured) {
    pinSectionFirst.hidden = true;
    pinSectionChange.hidden = false;
  } else {
    pinSectionFirst.hidden = false;
    pinSectionChange.hidden = true;
  }
}

savePinBtn.addEventListener("click", async () => {
  pinError.hidden = true;
  pinError.style.color = "";
  const pin = pinInput.value.trim();
  const confirm = pinConfirm.value.trim();

  if (!validatePinFormat(pin)) {
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
  pinError.textContent = "PIN saved. Enable “Open tabs from the previous session” in startup settings (button below).";
  pinError.style.color = "#4ade80";
  pinError.hidden = false;
  await loadSettings();
  openSessionSettingsBtn?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

changePinBtn.addEventListener("click", async () => {
  changePinError.hidden = true;
  changePinError.style.color = "";

  const currentPin = currentPinInput.value.trim();
  const newPin = newPinInput.value.trim();
  const confirm = newPinConfirmInput.value.trim();

  if (!validatePinFormat(currentPin)) {
    changePinError.textContent = "Current PIN must be 4–8 digits.";
    changePinError.hidden = false;
    return;
  }
  if (!validatePinFormat(newPin)) {
    changePinError.textContent = "New PIN must be 4–8 digits.";
    changePinError.hidden = false;
    return;
  }
  if (newPin !== confirm) {
    changePinError.textContent = "New PINs do not match.";
    changePinError.hidden = false;
    return;
  }
  if (currentPin === newPin) {
    changePinError.textContent = "New PIN must be different from your current PIN.";
    changePinError.hidden = false;
    return;
  }

  const res = await chrome.runtime.sendMessage({
    type: "CHANGE_PIN",
    currentPin,
    newPin,
  });

  if (!res?.ok) {
    if (res?.error === "wrong_pin") {
      changePinError.textContent = "Current PIN is incorrect.";
    } else if (res?.error === "locked") {
      changePinError.textContent = "Unlock the browser first, then change your PIN.";
    } else {
      changePinError.textContent = "Could not update PIN.";
    }
    changePinError.hidden = false;
    return;
  }

  currentPinInput.value = "";
  newPinInput.value = "";
  newPinConfirmInput.value = "";
  changePinError.textContent = "PIN updated successfully.";
  changePinError.style.color = "#4ade80";
  changePinError.hidden = false;
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

openSessionSettingsBtn?.addEventListener("click", async () => {
  if (sessionSettingsMsg) sessionSettingsMsg.hidden = true;
  const res = await chrome.runtime.sendMessage({ type: "OPEN_SESSION_SETTINGS" });
  if (sessionSettingsMsg) {
    sessionSettingsMsg.hidden = false;
    sessionSettingsMsg.textContent = res?.ok
      ? "Opened startup settings — select “Open tabs from the previous session”."
      : "Could not open settings tab. Go to edge://settings/onStartup manually.";
  }
});

openShortcutsSettingsBtn?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "OPEN_SHORTCUTS_SETTINGS" });
});

loadSettings();

["click", "keydown"].forEach((ev) => {
  document.addEventListener(ev, () => {
    chrome.runtime.sendMessage({ type: "RESET_IDLE" });
  });
});
