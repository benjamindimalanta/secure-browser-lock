importScripts("crypto.js");

const LOCK_PAGE = () => chrome.runtime.getURL("lock.html");
const SETUP_PAGE = () => chrome.runtime.getURL("setup.html");
const EXTENSION_ORIGIN = () => {
  try {
    return new URL(LOCK_PAGE()).origin;
  } catch {
    return "";
  }
};

/** Compact popup — fits PIN panel only */
const LOCK_WIDTH = 288;
const LOCK_HEIGHT = 318;
const SIZE_TOLERANCE = 12;

let applyingBounds = false;
let boundsFixTimer = null;

const DEFAULTS = {
  isLocked: false,
  pinHash: null,
  pinSalt: null,
  isConfigured: false,
  autoLockOnStartup: true,
  idleLockMinutes: 5,
  /** Set when all windows close — lock again on next open (Brave background process). */
  lockOnNextOpen: false,
};

const SESSION_DEFAULTS = {
  hiddenTabIds: [],
  lockWindowId: null,
  lockTabId: null,
  stashWindowId: null,
  collapsedGroupIds: [],
  savedWindowBounds: null,
  lockReady: false,
  lockPopupShownAt: null,
  lockUiDismissed: false,
};

let preparingLock = false;
let enforcing = false;
let enforceTimer = null;
let suppressEventsUntil = 0;
/** User closed the lock popup (X) — close every window so the browser exits. */
let closingBrowserFromLockDismiss = false;
/** Ignore LOCK_QUIT while the extension closes the lock window itself. */
let suppressLockQuitUntil = 0;
/** Prevents IIFE + onStartup from both preparing lock at once. */
let startupLockFlowRunning = false;
/** Startup grace — never quit the whole browser during this window (stale session / races). */
let browserLaunchTime = Date.now();

const ENFORCE_DEBOUNCE_MS = 1000;
/** Wait for Brave/Edge session restore before minimize + popup (avoids visible main window). */
/** Brief pause so Brave can open its window before we hide tabs and show PIN. */
const SESSION_RESTORE_WAIT_MS = 500;
/** Idle-alarm / enforce guard during cold start only. */
const STARTUP_GRACE_MS = 15000;
/** Lock popup must be visible this long before X counts as user quit. */
const LOCK_POPUP_MIN_AGE_MS = 1200;
/** Ignore X while the extension is closing/recreating the lock window itself. */
const LOCK_QUIT_SUPPRESS_MS = 3500;
const STASH_MINIMIZE_MAX_ATTEMPTS = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getState() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...data };
}

async function setState(partial) {
  await chrome.storage.local.set(partial);
}

async function getSession() {
  const data = await chrome.storage.session.get(Object.keys(SESSION_DEFAULTS));
  return { ...SESSION_DEFAULTS, ...data };
}

async function setSession(partial) {
  await chrome.storage.session.set(partial);
}

async function clearSession() {
  await chrome.storage.session.set({ ...SESSION_DEFAULTS });
}

/** Drop stale session IDs (e.g. Brave background process kept session after quit). */
async function validateAndRepairLockSession() {
  const state = await getState();
  if (!state.isLocked) {
    await clearSession();
    return;
  }

  if (await findLockPopup()) return;

  const session = await getSession();
  if (!session.lockReady) return;

  let popupValid = false;
  if (session.lockWindowId != null && session.lockTabId != null) {
    try {
      const win = await chrome.windows.get(session.lockWindowId);
      const tab = await chrome.tabs.get(session.lockTabId);
      popupValid =
        win.type === "popup" &&
        tab.windowId === session.lockWindowId &&
        isLockTab(tab);
    } catch {
      popupValid = false;
    }
  }

  if (!popupValid) {
    await setSession({
      lockReady: false,
      lockWindowId: null,
      lockTabId: null,
      lockPopupShownAt: null,
      lockUiDismissed: false,
    });
  }
}

/** Remember to lock when Brave reopens (background process keeps running). */
async function noteAllWindowsClosed() {
  const state = await getState();
  if (!state.isConfigured || !state.autoLockOnStartup || state.isLocked) return;

  const windows = await chrome.windows.getAll({
    windowTypes: ["normal", "popup"],
  });
  if (windows.length === 0) {
    await setState({ lockOnNextOpen: true });
  }
}

/** Lock when a new window opens after the user fully closed Brave. */
async function maybeAutoLockOnWindowOpen() {
  if (preparingLock || startupLockFlowRunning) return;

  const state = await getState();
  if (
    !state.isConfigured ||
    !state.autoLockOnStartup ||
    state.isLocked ||
    !state.lockOnNextOpen
  ) {
    return;
  }

  await setState({ lockOnNextOpen: false });
  const res = await lockBrowser();
  if (res.ok) {
    startEnforceAlarm();
  } else {
    await emergencyUnlockBrowser();
  }
}

/** Service worker start: never trap the user without a visible PIN screen. */
async function bootstrapServiceWorker() {
  browserLaunchTime = Date.now();
  chrome.alarms.clear("idle-lock");

  await purgeExtensionPagesFromHistory();
  await validateAndRepairLockSession();

  const state = await getState();
  if (!state.isConfigured) return;

  const shouldAutoLock =
    state.autoLockOnStartup && (!state.isLocked || state.lockOnNextOpen);

  if (state.isLocked || shouldAutoLock) {
    if (state.isLocked && !(await findLockPopup())) {
      await setSession({
        lockReady: false,
        lockWindowId: null,
        lockTabId: null,
        lockPopupShownAt: null,
      });
    }
    scheduleStartupLockRecovery();
    if (!startupLockFlowRunning) {
      runBrowserStartupLock().catch(() => {});
    }
    return;
  }

  if (state.idleLockMinutes > 0) {
    resetIdleAlarm(state.idleLockMinutes);
  }
}

function isWithinStartupGrace() {
  return Date.now() - browserLaunchTime < STARTUP_GRACE_MS;
}

function isLockPageUrl(url) {
  if (!url) return false;
  const lock = LOCK_PAGE();
  return url === lock || url.startsWith(lock);
}

function isProtectedExtensionUrl(url) {
  if (!url) return false;
  if (isLockPageUrl(url)) return true;
  const setup = SETUP_PAGE();
  return url === setup || url.startsWith(setup);
}

function isLockTab(tab) {
  return tab?.url && isLockPageUrl(tab.url);
}

async function purgeUrlFromHistory(url) {
  if (!url || !chrome.history?.deleteUrl) return;
  try {
    await chrome.history.deleteUrl({ url });
  } catch {
    /* ignore */
  }
}

/** Remove lock/setup pages from Brave history (they are not normal tabs). */
async function purgeExtensionPagesFromHistory() {
  const origin = EXTENSION_ORIGIN();
  if (!origin || !chrome.history?.search) return;

  try {
    const items = await chrome.history.search({ text: origin, maxResults: 250 });
    for (const item of items) {
      if (item.url && isProtectedExtensionUrl(item.url)) {
        await purgeUrlFromHistory(item.url);
      }
    }
  } catch {
    /* ignore */
  }

  await purgeUrlFromHistory(LOCK_PAGE());
  await purgeUrlFromHistory(SETUP_PAGE());
}

/**
 * Block Ctrl+Shift+T reopening the lock page: close stray lock tabs when
 * unlocked, or keep only the live popup while locked.
 */
async function handleStrayLockTab(tab) {
  if (!tab?.id) return;

  const url = tab.url || tab.pendingUrl;
  if (!isLockPageUrl(url)) return;

  await purgeUrlFromHistory(url);

  const state = await getState();
  const session = await getSession();

  if (!state.isLocked) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* ignore */
    }
    await purgeExtensionPagesFromHistory();
    return;
  }

  // Lock UI still starting — never delete the lock tab (was closing the whole browser).
  if (preparingLock || !session.lockReady) {
    const popup = await findLockPopup();
    if (popup?.tabId === tab.id) return;
    if (popup) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* ignore */
      }
    }
    return;
  }

  if (session.lockTabId != null && tab.id === session.lockTabId) return;

  try {
    await chrome.tabs.remove(tab.id);
  } catch {
    /* ignore */
  }
  scheduleEnforce();
}

async function closeLockPopupSafely(session) {
  suppressLockQuitUntil = Date.now() + LOCK_QUIT_SUPPRESS_MS;
  if (session.lockWindowId != null) {
    try {
      await chrome.windows.remove(session.lockWindowId);
    } catch {
      /* ignore */
    }
  }
  await purgeExtensionPagesFromHistory();
}

/** If lock UI cannot be shown, release the browser instead of trapping the user. */
async function emergencyUnlockBrowser() {
  clearTimeout(enforceTimer);
  enforceTimer = null;
  stopEnforceAlarm();
  preparingLock = false;
  suppressLockQuitUntil = Date.now() + 5000;
  await setState({ isLocked: false });
  await clearSession();
  const state = await getState();
  if (state.idleLockMinutes > 0) {
    resetIdleAlarm(state.idleLockMinutes);
  }
}

function supportsTabHide() {
  return typeof chrome.tabs.hide === "function";
}

async function hideTabId(tabId) {
  if (!tabId || tabId < 0) return false;
  try {
    if (supportsTabHide()) {
      await chrome.tabs.hide(tabId);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function showTabId(tabId) {
  if (!tabId || tabId < 0) return;
  try {
    if (typeof chrome.tabs.show === "function") {
      await chrome.tabs.show(tabId);
    }
  } catch {
    /* ignore */
  }
}

async function collapseTabsIntoLockGroup(tabIds) {
  const ids = tabIds.filter((id) => id > 0);
  if (!ids.length || !chrome.tabs.group) return null;
  try {
    const groupId = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(groupId, {
      collapsed: true,
      title: "Locked",
      color: "grey",
    });
    return groupId;
  } catch {
    return null;
  }
}

async function ungroupAllCollapsed() {
  const session = await getSession();
  for (const groupId of session.collapsedGroupIds) {
    try {
      const tabs = await chrome.tabs.query({ groupId });
      for (const tab of tabs) {
        if (tab.id) await chrome.tabs.ungroup(tab.id);
      }
    } catch {
      /* ignore */
    }
  }
}

async function getCenteredBounds() {
  try {
    const displays = await chrome.system.display.getInfo();
    const primary = displays.find((d) => d.isPrimary) || displays[0];
    if (primary?.workArea) {
      const left = Math.round(
        primary.workArea.left + (primary.workArea.width - LOCK_WIDTH) / 2
      );
      const top = Math.round(
        primary.workArea.top + (primary.workArea.height - LOCK_HEIGHT) / 2
      );
      return { left, top, width: LOCK_WIDTH, height: LOCK_HEIGHT };
    }
  } catch {
    /* ignore */
  }
  return { left: 120, top: 120, width: LOCK_WIDTH, height: LOCK_HEIGHT };
}

/** Brave often restores the window after we minimize — retry until it sticks. */
async function ensureStashMinimized(stashWindowId) {
  if (!stashWindowId) return false;

  for (let attempt = 0; attempt < STASH_MINIMIZE_MAX_ATTEMPTS; attempt++) {
    try {
      const win = await chrome.windows.get(stashWindowId);
      if (win.state === "minimized") return true;

      await chrome.windows.update(stashWindowId, { state: "minimized" });
      await sleep(120 + attempt * 100);

      const check = await chrome.windows.get(stashWindowId);
      if (check.state === "minimized") return true;
    } catch {
      return false;
    }
  }
  return false;
}

function scheduleStashMinimizeWatchdog(stashWindowId) {
  if (!stashWindowId) return;
  for (const delayMs of [500, 1400, 3000]) {
    setTimeout(async () => {
      if (preparingLock || closingBrowserFromLockDismiss) return;
      const state = await getState();
      if (!state.isLocked) return;
      const session = await getSession();
      if (session.stashWindowId !== stashWindowId) return;
      await ensureStashMinimized(stashWindowId);
    }, delayMs);
  }
}

async function applyPopupLockBounds(windowId) {
  if (applyingBounds || !windowId) return;
  applyingBounds = true;
  const bounds = await getCenteredBounds();
  try {
    await chrome.windows.update(windowId, {
      state: "normal",
      focused: true,
      width: bounds.width,
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
    });
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    applyingBounds = false;
  }, 450);
}

function schedulePopupBoundsFix(windowId) {
  if (applyingBounds || preparingLock || Date.now() < suppressEventsUntil) return;
  clearTimeout(boundsFixTimer);
  boundsFixTimer = setTimeout(async () => {
    const state = await getState();
    if (!state.isLocked) return;

    const session = await getSession();
    if (session.lockWindowId !== windowId) return;

    try {
      const win = await chrome.windows.get(windowId);
      if (win.type !== "popup") return;

      const target = await getCenteredBounds();
      const needsFix =
        win.state !== "normal" ||
        Math.abs(win.width - target.width) > SIZE_TOLERANCE ||
        Math.abs(win.height - target.height) > SIZE_TOLERANCE;

      if (needsFix) await applyPopupLockBounds(windowId);
    } catch {
      /* ignore */
    }
  }, 300);
}

async function findLockPopup() {
  const tabs = await chrome.tabs.query({ url: LOCK_PAGE() });
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.type === "popup") {
        return { popupId: win.id, tabId: tab.id };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function ensureLockPopup() {
  const existing = await findLockPopup();
  if (existing) {
    await setSession({
      lockWindowId: existing.popupId,
      lockTabId: existing.tabId,
    });
    await applyPopupLockBounds(existing.popupId);
    return existing.popupId;
  }

  suppressLockQuitUntil = Date.now() + LOCK_QUIT_SUPPRESS_MS;
  const bounds = await getCenteredBounds();
  const popup = await chrome.windows.create({
    url: LOCK_PAGE(),
    type: "popup",
    width: bounds.width,
    height: bounds.height,
    left: bounds.left,
    top: bounds.top,
    focused: true,
  });

  const tabs = await chrome.tabs.query({ windowId: popup.id });
  const lockTab = tabs[0];
  await setSession({
    lockWindowId: popup.id,
    lockTabId: lockTab?.id ?? null,
  });
  await applyPopupLockBounds(popup.id);
  return popup.id;
}

function scheduleEnforce() {
  if (preparingLock || Date.now() < suppressEventsUntil) return;
  clearTimeout(enforceTimer);
  enforceTimer = setTimeout(() => {
    enforceLockStateLight().catch(() => {});
  }, ENFORCE_DEBOUNCE_MS);
}

async function hideAllTabsInWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const hiddenTabIds = [];
  const needsGroup = [];
  const session = await getSession();

  for (const tab of tabs) {
    if (!tab.id || isLockTab(tab)) continue;
    const hidden = await hideTabId(tab.id);
    if (hidden) {
      hiddenTabIds.push(tab.id);
    } else {
      needsGroup.push(tab.id);
    }
  }

  const collapsedGroupIds = [...session.collapsedGroupIds];
  if (needsGroup.length) {
    const groupId = await collapseTabsIntoLockGroup(needsGroup);
    if (groupId != null) collapsedGroupIds.push(groupId);
  }

  await setSession({
    hiddenTabIds: [...new Set([...session.hiddenTabIds, ...hiddenTabIds])],
    collapsedGroupIds,
  });
}

async function showAllHiddenTabs() {
  const session = await getSession();
  for (const tabId of session.hiddenTabIds) {
    await showTabId(tabId);
  }
  await ungroupAllCollapsed();
}

async function closeOtherWindowsExcept(keepIds) {
  suppressLockQuitUntil = Date.now() + LOCK_QUIT_SUPPRESS_MS;
  const keep = new Set(keepIds.filter((id) => id != null));
  const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup"] });
  for (const win of windows) {
    if (!keep.has(win.id)) {
      try {
        await chrome.windows.remove(win.id);
      } catch {
        /* ignore */
      }
    }
  }
}

async function pickOrCreateStashWindow() {
  const focused = await chrome.windows.getLastFocused({
    windowTypes: ["normal"],
  });
  if (focused?.id && focused.type === "normal") {
    return focused.id;
  }

  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of wins) {
    if (win.id) return win.id;
  }

  const created = await chrome.windows.create({
    url: "about:blank",
    type: "normal",
    focused: false,
  });
  return created.id;
}

/** Minimized stash window (hidden tabs) + separate popup lock UI. */
async function prepareLockWindow() {
  preparingLock = true;
  suppressEventsUntil = Date.now() + 3000;

  try {
    const stashWindowId = await pickOrCreateStashWindow();
    const stashWin = await chrome.windows.get(stashWindowId);

    await setSession({
      stashWindowId,
      savedWindowBounds: {
        left: stashWin.left,
        top: stashWin.top,
        width: stashWin.width,
        height: stashWin.height,
        state: stashWin.state,
      },
      lockReady: false,
    });

    await hideAllTabsInWindow(stashWindowId);
    await ensureStashMinimized(stashWindowId);

    const popupId = await ensureLockPopup();
    const afterPopup = await getSession();
    if (!(await findLockPopup())) {
      throw new Error("lock_popup_missing");
    }

    await ensureStashMinimized(stashWindowId);
    await purgeExtensionPagesFromHistory();

    await setSession({
      lockReady: true,
      lockUiDismissed: false,
      lockWindowId: popupId,
      lockTabId: afterPopup.lockTabId,
      lockPopupShownAt: Date.now(),
    });

    scheduleStashMinimizeWatchdog(stashWindowId);

    setTimeout(() => {
      closeOtherWindowsExcept([stashWindowId, popupId]).catch(() => {});
    }, 1200);

    return popupId;
  } finally {
    preparingLock = false;
    suppressEventsUntil = Date.now() + 1500;
    suppressLockQuitUntil = Date.now() + LOCK_QUIT_SUPPRESS_MS;
  }
}

async function enforceLockStateLight() {
  if (preparingLock || enforcing || Date.now() < suppressEventsUntil) return;

  const state = await getState();
  if (!state.isLocked) return;

  const session = await getSession();
  if (!session.lockReady) {
    await prepareLockWindow();
    return;
  }

  const found = await findLockPopup();
  if (!found) {
    await ensureLockPopup();
    return;
  }

  enforcing = true;
  try {
    await chrome.windows.update(found.popupId, { focused: true });
    await applyPopupLockBounds(found.popupId);
    await ensureStashMinimized(session.stashWindowId);
  } catch {
    await ensureLockPopup();
  } finally {
    enforcing = false;
  }
}

async function resumeLockedSession() {
  const session = await getSession();
  if (!session.lockReady) {
    await prepareLockWindow();
    return;
  }
  await ensureStashMinimized(session.stashWindowId);
  if (!(await findLockPopup())) {
    await ensureLockPopup();
  }
  scheduleEnforce();
}

/** Runs once per browser launch — waits for session restore, then locks or resumes. */
async function runBrowserStartupLock() {
  if (startupLockFlowRunning) return;
  startupLockFlowRunning = true;
  chrome.alarms.clear("idle-lock");
  try {
    await sleep(SESSION_RESTORE_WAIT_MS);

    const state = await getState();
    if (!state.isConfigured) return;

    if (state.autoLockOnStartup) {
      await setState({ lockOnNextOpen: false });
      if (!state.isLocked) {
        const res = await lockBrowser();
        if (!res.ok) await emergencyUnlockBrowser();
      } else {
        await resumeLockedSession();
        if (!(await findLockPopup())) await emergencyUnlockBrowser();
      }
      startEnforceAlarm();
      return;
    }

    if (state.isLocked) {
      await resumeLockedSession();
      if (!(await findLockPopup())) await emergencyUnlockBrowser();
      startEnforceAlarm();
    } else if (state.idleLockMinutes > 0) {
      resetIdleAlarm(state.idleLockMinutes);
    }
  } finally {
    startupLockFlowRunning = false;
  }
}

async function lockBrowser() {
  const state = await getState();
  if (!state.isConfigured) {
    chrome.runtime.openOptionsPage();
    return { ok: false, error: "not_configured" };
  }

  await setState({ isLocked: true });
  await clearSession();
  try {
    await prepareLockWindow();
  } catch {
    await emergencyUnlockBrowser();
    return { ok: false, error: "lock_ui_failed" };
  }
  await purgeExtensionPagesFromHistory();

  if (!(await findLockPopup())) {
    await emergencyUnlockBrowser();
    return { ok: false, error: "lock_ui_failed" };
  }

  resetIdleAlarm(0);
  return { ok: true };
}

async function unlockBrowser() {
  const session = await getSession();

  clearTimeout(enforceTimer);
  enforceTimer = null;
  suppressEventsUntil = Date.now() + 5000;
  preparingLock = false;

  await setState({ isLocked: false, lockOnNextOpen: false });

  await closeLockPopupSafely(session);

  await showAllHiddenTabs();

  const restoreWindowId = session.stashWindowId || session.lockWindowId;
  if (restoreWindowId != null && session.savedWindowBounds) {
    try {
      const b = session.savedWindowBounds;
      await chrome.windows.update(restoreWindowId, {
        state: b.state === "minimized" ? "normal" : b.state || "normal",
        width: b.width,
        height: b.height,
        left: b.left,
        top: b.top,
        focused: true,
      });
    } catch {
      /* ignore */
    }
  }

  await clearSession();
  resetIdleAlarm((await getState()).idleLockMinutes);
  return { ok: true };
}

function resetIdleAlarm(minutes) {
  chrome.alarms.clear("idle-lock");
  if (minutes > 0) {
    chrome.alarms.create("idle-lock", { delayInMinutes: minutes });
  }
}

function startEnforceAlarm() {
  chrome.alarms.clear("enforce-lock");
  chrome.alarms.create("enforce-lock", { periodInMinutes: 1 });
}

function stopEnforceAlarm() {
  chrome.alarms.clear("enforce-lock");
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "enforce-lock") {
    scheduleEnforce();
    return;
  }
  if (alarm.name !== "idle-lock") return;
  if (
    startupLockFlowRunning ||
    preparingLock ||
    closingBrowserFromLockDismiss ||
    isWithinStartupGrace()
  ) {
    const state = await getState();
    if (!state.isLocked && state.idleLockMinutes > 0) {
      resetIdleAlarm(state.idleLockMinutes);
    }
    return;
  }
  const state = await getState();
  if (state.isConfigured && !state.isLocked) {
    const res = await lockBrowser();
    if (!res.ok) await emergencyUnlockBrowser();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install" || !(await getState()).isConfigured) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (details.reason === "update") {
    const state = await getState();
    if (state.idleLockMinutes === 0) {
      await setState({ idleLockMinutes: 5 });
    }
    if (state.isLocked && !(await findLockPopup())) {
      await emergencyUnlockBrowser();
    }
  }
  bootstrapServiceWorker().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  bootstrapServiceWorker().catch(() => {});
});

function scheduleStartupLockRecovery() {
  setTimeout(async () => {
    if (closingBrowserFromLockDismiss || preparingLock) return;
    const state = await getState();
    if (!state.isConfigured || !state.isLocked) return;
    if (await findLockPopup()) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await resumeLockedSession();
      } catch {
        /* ignore */
      }
      if (await findLockPopup()) return;
      await sleep(800);
    }
    await emergencyUnlockBrowser();
  }, SESSION_RESTORE_WAIT_MS + 1200);
}

chrome.windows.onCreated.addListener((win) => {
  setTimeout(() => maybeAutoLockOnWindowOpen().catch(() => {}), 80);
  setTimeout(async () => {
    if (preparingLock || Date.now() < suppressEventsUntil) return;
    const state = await getState();
    if (!state.isLocked) return;

    const session = await getSession();
    if (win.id === session.lockWindowId || win.id === session.stashWindowId) return;

    try {
      const stashId = session.stashWindowId;
      if (stashId) {
        const tabs = await chrome.tabs.query({ windowId: win.id });
        for (const tab of tabs) {
          if (tab.id && !isLockTab(tab)) {
            await chrome.tabs.move(tab.id, { windowId: stashId, index: -1 });
            await hideTabId(tab.id);
          }
        }
      }
      await chrome.windows.remove(win.id);
    } catch {
      /* ignore */
    }
    scheduleEnforce();
  }, 400);
});

if (chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener((window) => {
    schedulePopupBoundsFix(window.id);
  });
}

let idleActivityDebounce = null;

function noteBrowserActivity() {
  clearTimeout(idleActivityDebounce);
  idleActivityDebounce = setTimeout(async () => {
    const state = await getState();
    if (!state.isLocked && state.idleLockMinutes > 0) {
      resetIdleAlarm(state.idleLockMinutes);
    }
  }, 400);
}

chrome.tabs.onActivated.addListener(() => {
  noteBrowserActivity();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  noteBrowserActivity();
  setTimeout(async () => {
    if (preparingLock || Date.now() < suppressEventsUntil) return;
    const state = await getState();
    if (!state.isLocked) return;

    const session = await getSession();

    if (session.stashWindowId != null && windowId === session.stashWindowId) {
      await ensureStashMinimized(session.stashWindowId);
      if (session.lockWindowId != null) {
        try {
          await chrome.windows.update(session.lockWindowId, { focused: true });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (session.lockWindowId != null && windowId !== session.lockWindowId) {
      scheduleEnforce();
    }
  }, 300);
});

async function handleLockPopupClosedByUser() {
  if (preparingLock || closingBrowserFromLockDismiss) {
    return;
  }

  if (Date.now() < suppressLockQuitUntil) {
    try {
      await resumeLockedSession();
    } catch {
      /* ignore */
    }
    return;
  }

  const session = await getSession();
  const shownAt = session.lockPopupShownAt || 0;
  if (!session.lockReady || !shownAt || Date.now() - shownAt < LOCK_POPUP_MIN_AGE_MS) {
    try {
      await resumeLockedSession();
    } catch {
      /* ignore */
    }
    return;
  }

  await closeBrowserOnLockDismiss();
}

/** Close all windows when the user dismisses the lock popup (title-bar X). */
async function closeBrowserOnLockDismiss() {
  if (closingBrowserFromLockDismiss) return;

  closingBrowserFromLockDismiss = true;
  suppressEventsUntil = Date.now() + 15000;
  preparingLock = false;
  clearTimeout(enforceTimer);
  enforceTimer = null;
  stopEnforceAlarm();
  chrome.alarms.clear("idle-lock");

  const state = await getState();
  await setState({
    isLocked: false,
    lockOnNextOpen: state.autoLockOnStartup,
  });
  await clearSession();

  try {
    const windows = await chrome.windows.getAll({ populate: false });
    for (const win of windows) {
      try {
        await chrome.windows.remove(win.id);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  setTimeout(async () => {
    if (!closingBrowserFromLockDismiss) {
      const state = await getState();
      if (state.isLocked) {
        const session = await getSession();
        if (session.lockWindowId === windowId) {
          await handleLockPopupClosedByUser();
        }
      } else {
        await noteAllWindowsClosed();
      }
    }
  }, 200);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setTimeout(async () => {
    if (closingBrowserFromLockDismiss) return;
    const state = await getState();
    if (!state.isLocked) return;

    const session = await getSession();
    if (session.lockTabId !== tabId) return;

    const popup = await findLockPopup();
    if (popup) {
      await setSession({
        lockWindowId: popup.popupId,
        lockTabId: popup.tabId,
      });
      return;
    }

    await handleLockPopupClosedByUser();
  }, 200);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!isLockPageUrl(url)) return;

  setTimeout(() => handleStrayLockTab(tab), 0);
});

chrome.tabs.onCreated.addListener((tab) => {
  setTimeout(async () => {
    try {
      const fresh = tab.id ? await chrome.tabs.get(tab.id) : tab;
      await handleStrayLockTab(fresh);
    } catch {
      /* tab gone */
    }
  }, 150);
});

if (chrome.history?.onVisited) {
  chrome.history.onVisited.addListener((item) => {
    if (isProtectedExtensionUrl(item.url)) {
      purgeUrlFromHistory(item.url);
    }
  });
}

if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    if (isProtectedExtensionUrl(details.url)) {
      purgeUrlFromHistory(details.url);
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_STATE": {
        sendResponse(await getState());
        break;
      }
      case "SET_PIN": {
        const pin = String(message.pin || "");
        if (!/^\d{4,8}$/.test(pin)) {
          sendResponse({ ok: false, error: "invalid_pin" });
          break;
        }
        const { hash, salt } = await hashPin(pin);
        await setState({
          pinHash: hash,
          pinSalt: salt,
          isConfigured: true,
          isLocked: false,
        });
        resetIdleAlarm((await getState()).idleLockMinutes);
        sendResponse({ ok: true });
        break;
      }
      case "VERIFY_PIN": {
        const state = await getState();
        const valid = await verifyPin(
          String(message.pin || ""),
          state.pinHash,
          state.pinSalt
        );
        if (valid) {
          stopEnforceAlarm();
          await unlockBrowser();
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "wrong_pin" });
        }
        break;
      }
      case "LOCK": {
        const res = await lockBrowser();
        if (res.ok) startEnforceAlarm();
        sendResponse(res);
        break;
      }
      case "UNLOCK": {
        stopEnforceAlarm();
        sendResponse(await unlockBrowser());
        break;
      }
      case "SAVE_SETTINGS": {
        await setState({
          autoLockOnStartup: Boolean(message.autoLockOnStartup),
          idleLockMinutes: Math.max(0, parseInt(message.idleLockMinutes, 10) || 0),
        });
        resetIdleAlarm((await getState()).idleLockMinutes);
        sendResponse({ ok: true });
        break;
      }
      case "IS_LOCKED": {
        const s = await getState();
        sendResponse({ isLocked: s.isLocked, isConfigured: s.isConfigured });
        break;
      }
      case "RESET_IDLE": {
        const s = await getState();
        if (!s.isLocked && s.idleLockMinutes > 0) {
          resetIdleAlarm(s.idleLockMinutes);
        }
        sendResponse({ ok: true });
        break;
      }
      case "FOCUS_LOCK": {
        const state = await getState();
        if (state.isLocked) {
          const session = await getSession();
          await setSession({ lockUiDismissed: false });
          if (session.lockReady && session.stashWindowId) {
            await ensureLockPopup();
          } else {
            await prepareLockWindow();
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case "LOCK_UI_READY": {
        const readySession = await getSession();
        if (readySession.lockTabId != null && _sender.tab?.id === readySession.lockTabId) {
          await setSession({ lockPopupShownAt: Date.now() });
        }
        sendResponse({ ok: true });
        break;
      }
      case "RESET_LOCK_STATE": {
        await emergencyUnlockBrowser();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown" });
    }
  })();
  return true;
});

bootstrapServiceWorker().catch(() => {});
