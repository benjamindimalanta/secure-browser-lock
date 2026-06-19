(function () {
  const ROOT_ID = "secure-browser-lock-shield";

  function showShield() {
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Browser locked");
    root.innerHTML = `
      <div class="sbl-shield-panel">
        <div class="sbl-shield-icon" aria-hidden="true">🔒</div>
        <h1 class="sbl-shield-title">Browser locked</h1>
        <p class="sbl-shield-subtitle">Enter your PIN in the lock window to continue.</p>
        <button type="button" class="sbl-shield-btn" id="sbl-focus-lock">Show lock window</button>
      </div>
    `;

    document.documentElement.appendChild(root);
    root.querySelector("#sbl-focus-lock").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "FOCUS_LOCK" }).catch(() => {});
    });
  }

  function hideShield() {
    const el = document.getElementById(ROOT_ID);
    if (el) el.remove();
  }

  async function syncLockState() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "IS_LOCKED" });
      if (res?.isLocked) showShield();
      else hideShield();
    } catch {
      /* extension context invalidated */
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SHOW_SHIELD") showShield();
    if (msg.type === "HIDE_SHIELD") hideShield();
  });

  syncLockState();

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") syncLockState();
    },
    false
  );
})();
