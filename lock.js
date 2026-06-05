const form = document.getElementById("unlock-form");
const pinInput = document.getElementById("pin");
const errorEl = document.getElementById("error");

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

chrome.runtime.sendMessage({ type: "IS_LOCKED" });
pinInput.focus();
