(function () {
  const ROOT_ID = "secure-browser-lock-root";

  function createOverlay() {
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Browser locked");
    root.innerHTML = `
      <div class="sbl-panel">
        <div class="sbl-icon" aria-hidden="true">🔒</div>
        <h1 class="sbl-title">Browser locked</h1>
        <p class="sbl-subtitle">Enter your PIN to continue</p>
        <form class="sbl-form" id="sbl-form">
          <input
            type="password"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="8"
            autocomplete="off"
            class="sbl-input"
            id="sbl-pin"
            placeholder="PIN"
            aria-label="PIN"
          />
          <p class="sbl-error" id="sbl-error" hidden>Incorrect PIN. Try again.</p>
          <button type="submit" class="sbl-btn">Unlock</button>
        </form>
      </div>
    `;

    document.documentElement.appendChild(root);

    const form = root.querySelector("#sbl-form");
    const input = root.querySelector("#sbl-pin");
    const error = root.querySelector("#sbl-error");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      const pin = input.value.trim();
      if (!pin) return;

      const res = await chrome.runtime.sendMessage({ type: "VERIFY_PIN", pin });
      if (res?.ok) {
        removeOverlay();
        input.value = "";
      } else {
        error.hidden = false;
        input.value = "";
        input.focus();
      }
    });

    input.focus();
  }

  function removeOverlay() {
    const el = document.getElementById(ROOT_ID);
    if (el) el.remove();
  }

  async function syncLockState() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "IS_LOCKED" });
      if (res?.isLocked) createOverlay();
      else removeOverlay();
    } catch {
      /* extension context invalidated */
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SHOW_LOCK") createOverlay();
    if (msg.type === "HIDE_LOCK") removeOverlay();
  });

  syncLockState();

  let idleThrottle = false;
  function pingActivity() {
    if (idleThrottle) return;
    idleThrottle = true;
    setTimeout(() => {
      idleThrottle = false;
    }, 3000);
    chrome.runtime.sendMessage({ type: "RESET_IDLE" }).catch(() => {});
  }
  ["mousedown", "keydown", "scroll", "touchstart"].forEach((ev) => {
    document.addEventListener(ev, pingActivity, { passive: true, capture: true });
  });

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") syncLockState();
    },
    false
  );
})();
