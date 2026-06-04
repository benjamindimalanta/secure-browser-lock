/**
 * Best-effort protection on the lock page only.
 * Cannot block DevTools from the browser ⋮ menu (Chrome/Brave API limit).
 */
(function () {
  function blockShortcut(e) {
    const key = e.key?.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;

    if (key === "f12") return true;
    if (ctrl && e.shiftKey && ["i", "j", "c", "k"].includes(key)) return true;
    if (ctrl && !e.shiftKey && key === "u") return true;
    if (e.keyCode === 123) return true;

    return false;
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (blockShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  document.addEventListener(
    "selectstart",
    (e) => {
      if (e.target.closest("input, textarea")) return;
      e.preventDefault();
    },
    true
  );

  document.addEventListener(
    "dragstart",
    (e) => {
      e.preventDefault();
    },
    true
  );
})();
