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

/** Compact popup ΓÇö fits PIN panel only */
const LOCK_WIDTH = 288;
const LOCK_HEIGHT = 388;
const SIZE_TOLERANCE = 12;

let applyingBounds = false;
let boundsFixTimer = null;

const DEFAULTS = {
  isLocked: false,
  pinHash: null,
  pinSalt: null,
  isConfigured: false,
  autoLockOnStartup: true,
  idleLockMinutes: 10,
  /** Set when all windows close ΓÇö lock again on next open (Brave background process). */
  lockOnNextOpen: false,
  /** Laptop shutdown / crash while locked ΓÇö recover on next start instead of quitting. */
  recoveryLockPending: false,
  /** Tab count before close — used only to know when Edge finished restoring. */
  lastSessionTabCount: 0,
  /** URLs saved before PIN-dismiss quit — restores tabs if Edge session degrades. */
  sessionTabSnapshot: null,
  /** True after browser quit — survives service-worker restart (PIN on reopen). */
  pendingColdStartLock: false,
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
/** User closed the lock popup (X) ΓÇö close every window so the browser exits. */
let closingBrowserFromLockDismiss = false;
/** Ignore LOCK_QUIT while the extension closes the lock window itself. */
let suppressLockQuitUntil = 0;
/** Extension is closing the lock popup (unlock) — ignore pagehide quit signal. */
let intentionalLockPopupClose = false;
/** Prevents IIFE + onStartup from both preparing lock at once. */
let startupLockFlowRunning = false;
/** Startup/crash recovery ΓÇö never quit browser when popup vanishes during this window. */
let coldBootRecoveryUntil = 0;
chrome.storage.local.get(["isLocked", "recoveryLockPending"], (data) => {
  if (data.isLocked || data.recoveryLockPending) {
    coldBootRecoveryUntil = Date.now() + 30000;
  }
});
/** Startup grace — never quit the whole browser during this window (stale session / races). */
let browserLaunchTime = Date.now();

const ENFORCE_DEBOUNCE_MS = 1000;
/** Wait for Brave/Edge session restore before minimize + popup (avoids visible main window). */
/** Brief pause before startup lock so the browser can begin session restore. */
const SESSION_RESTORE_WAIT_MS = 500;
/** How long to wait for Edge/Chrome to finish restoring your last session. */
const SESSION_RESTORE_MAX_MS = 25000;
const SESSION_RESTORE_MIN_MS = 5000;

let startupTabCaptureTimer = null;
let sessionTabCountSaveTimer = null;
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

function isHideableTab(tab) {
  return Boolean(tab?.id && !isLockTab(tab));
}

function isBlankHelperTab(url) {
  const u = url || "";
  return (
    u === "about:blank" ||
    u === "about:newtab" ||
    u === "chrome://newtab/" ||
    u === "edge://newtab/"
  );
}

function isRealSessionTab(tab) {
  if (!tab?.id || !isHideableTab(tab)) return false;
  const url = tab.url || tab.pendingUrl || "";
  return !isBlankHelperTab(url);
}

function isInternalBrowserUrl(url) {
  return /^(chrome|edge|brave|opera|vivaldi):\/\//i.test(url || "");
}

async function countHideableTabs() {
  const normalWins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const normalIds = new Set(normalWins.map((w) => w.id));
  const tabs = await chrome.tabs.query({});
  return tabs.filter(
    (t) => t.windowId != null && normalIds.has(t.windowId) && isHideableTab(t)
  ).length;
}
async function waitForSessionRestore(maxMs = SESSION_RESTORE_MAX_MS) {
  const state = await getState();
  const expected = state.lastSessionTabCount || 0;

  await sleep(SESSION_RESTORE_MIN_MS);

  let lastCount = 0;
  let stableRounds = 0;
  const start = Date.now();

  while (Date.now() - start < maxMs) {
    const count = await countHideableTabs();
    const elapsed = Date.now() - start;

    if (expected > 0 && count >= expected) {
      await sleep(1000);
      return;
    }

    if (count > lastCount) {
      lastCount = count;
      stableRounds = 0;
      await sleep(500);
      continue;
    }

    if (count === lastCount) {
      stableRounds += 1;
    }

    if (expected === 0) {
      // Edge often shows 1 empty "New tab" first — do not lock on that alone.
      if (count <= 1 && elapsed < maxMs * 0.9) {
        await sleep(400);
        continue;
      }
      if (stableRounds >= 12 && (count >= 2 || elapsed > maxMs * 0.75)) {
        return;
      }
      if (stableRounds >= 30) return;
    } else {
      if (stableRounds >= 10 && count >= Math.max(1, Math.floor(expected * 0.85))) {
        await sleep(800);
        return;
      }
      if (stableRounds >= 25) return;
    }

    await sleep(350);
  }
}

/** Remember how many tabs were open — used only to time the wait before hiding. */
async function saveSessionTabCount() {
  const state = await getState();
  if (!state.isConfigured || state.isLocked) return;

  const count = await countRealSessionTabs();
  if (count === 0) return;

  if (count >= (state.lastSessionTabCount || 0)) {
    await setState({ lastSessionTabCount: count });
  }
}

/** Count real tabs (excludes blank helpers created during lock on Edge). */
async function countRealSessionTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => isRealSessionTab(t)).length;
}

/** Persist open tabs before PIN-dismiss quit so unlock can recover after many cycles. */
async function saveSessionSnapshotBeforeQuit() {
  const tabs = await chrome.tabs.query({});
  const real = tabs.filter((t) => isRealSessionTab(t));
  if (!real.length) return;

  const snapshot = real.map((t) => ({
    url: t.url || t.pendingUrl || "",
    pinned: Boolean(t.pinned),
  }));
  const count = real.length;
  const state = await getState();

  await setState({
    sessionTabSnapshot: snapshot,
    lastSessionTabCount: Math.max(count, state.lastSessionTabCount || 0),
  });
}

async function removeLockHelperBlankTabs() {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of wins) {
    if (!win.id) continue;
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const real = tabs.filter((t) => isRealSessionTab(t));
    if (!real.length) continue;
    for (const tab of tabs) {
      if (!tab.id) continue;
      const url = tab.url || tab.pendingUrl || "";
      if (isBlankHelperTab(url)) {
        try {
          await chrome.tabs.remove(tab.id);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Ungroup + drop blank helpers so Edge saves the real session on quit. */
async function prepareBrowserForCleanQuit() {
  try {
    await ungroupAllCollapsed();
    await removeLockHelperBlankTabs();
    await saveSessionSnapshotBeforeQuit();
  } catch {
    /* ignore */
  }
}

/** If Edge only restored a blank tab after many dismiss cycles, reopen saved URLs. */
async function restoreFromSessionSnapshotIfNeeded() {
  const state = await getState();
  const snapshot = state.sessionTabSnapshot;
  if (!Array.isArray(snapshot) || !snapshot.length) return;

  const currentCount = await countRealSessionTabs();
  const expected = Math.max(state.lastSessionTabCount || 0, snapshot.length);
  if (currentCount >= Math.max(1, Math.floor(expected * 0.75))) {
    await setState({ sessionTabSnapshot: null });
    return;
  }

  let windowId = null;
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (wins.length) {
    windowId = wins[0].id ?? null;
  }
  if (windowId == null) {
    const created = await chrome.windows.create({ focused: true });
    windowId = created.id ?? null;
  }
  if (windowId == null) return;

  const existing = new Set(
    (await chrome.tabs.query({ windowId }))
      .map((t) => t.url || t.pendingUrl || "")
      .filter(Boolean)
  );

  for (const entry of snapshot) {
    if (!entry.url || existing.has(entry.url)) continue;
    try {
      await chrome.tabs.create({
        windowId,
        url: entry.url,
        active: false,
        pinned: Boolean(entry.pinned),
      });
      existing.add(entry.url);
    } catch {
      /* ignore */
    }
  }

  await setState({ sessionTabSnapshot: null });
}

/** Save immediately when tab count grows (no debounce). */
async function saveSessionTabCountIfHigher() {
  const state = await getState();
  if (!state.isConfigured || state.isLocked) return;

  const count = await countRealSessionTabs();
  if (count > (state.lastSessionTabCount || 0)) {
    await setState({ lastSessionTabCount: count });
  }
}

function scheduleSessionTabCountSave() {
  if (sessionTabCountSaveTimer != null) clearTimeout(sessionTabCountSaveTimer);
  sessionTabCountSaveTimer = setTimeout(() => {
    sessionTabCountSaveTimer = null;
    saveSessionTabCount().catch(() => {});
  }, 800);
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

/** Remember to lock when the browser is closed or fully quit. */
async function markLockRequiredOnNextOpen() {
  const state = await getState();
  if (!state.isConfigured || !state.autoLockOnStartup || state.isLocked) return;
  await saveSessionTabCount();
  await setState({ lockOnNextOpen: true, pendingColdStartLock: true });
}

/** Remember to lock when Brave reopens (background process keeps running). */
async function noteAllWindowsClosed() {
  const state = await getState();
  if (!state.isConfigured || !state.autoLockOnStartup || state.isLocked) return;

  const windows = await chrome.windows.getAll({
    windowTypes: ["normal", "popup"],
  });
  if (windows.length === 0) {
    await markLockRequiredOnNextOpen();
  }
}

/** Lock when a new window opens after the user fully closed the browser. */
async function maybeAutoLockOnWindowOpen() {
  if (preparingLock || startupLockFlowRunning) return;

  const state = await getState();
  if (state.isLocked) {
    const popup = await findLockPopup();
    if (popup) {
      await secludeBrowserBehindLock(popup.popupId);
    }
    return;
  }

  if (
    !state.isConfigured ||
    !state.autoLockOnStartup ||
    !state.lockOnNextOpen
  ) {
    return;
  }

  await setState({ lockOnNextOpen: false, pendingColdStartLock: false });
  const res = await lockBrowser({ isStartupLock: true });
  if (res.ok) {
    startEnforceAlarm();
  } else {
    await setState({ lockOnNextOpen: true, pendingColdStartLock: true });
    await emergencyUnlockBrowser();
  }
}

/** Service worker start: never trap the user without a visible PIN screen. */
async function bootstrapServiceWorker() {
  browserLaunchTime = Date.now();
  chrome.alarms.clear("idle-lock");

  await purgeExtensionPagesFromHistory();

  const state = await getState();
  const hadUncleanLockExit =
    state.recoveryLockPending || (state.isLocked && !(await findLockPopup()));

  if (hadUncleanLockExit) {
    coldBootRecoveryUntil = Math.max(coldBootRecoveryUntil, Date.now() + 30000);
    await setState({ recoveryLockPending: false });
    await clearSession();
  } else {
    await validateAndRepairLockSession();
  }

  if (!state.isConfigured) return;

  const fresh = await getState();

  const needsStartupLock =
    fresh.isLocked || fresh.pendingColdStartLock || fresh.lockOnNextOpen;

  if (needsStartupLock) {
    if (fresh.isLocked && !(await findLockPopup())) {
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

  if (fresh.idleLockMinutes > 0) {
    resetIdleAlarm(fresh.idleLockMinutes);
  }
  scheduleSessionTabCountSave();
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

  // Lock UI still starting ΓÇö never delete the lock tab (was closing the whole browser).
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
  intentionalLockPopupClose = true;
  suppressLockQuitUntil = Date.now() + LOCK_QUIT_SUPPRESS_MS;
  if (session.lockWindowId != null) {
    try {
      await chrome.windows.remove(session.lockWindowId);
    } catch {
      /* ignore */
    }
  }
  await purgeExtensionPagesFromHistory();
  setTimeout(() => {
    intentionalLockPopupClose = false;
  }, 800);
}

/** If lock UI cannot be shown, release the browser instead of trapping the user. */
async function emergencyUnlockBrowser() {
  clearTimeout(enforceTimer);
  enforceTimer = null;
  stopEnforceAlarm();
  preparingLock = false;
  suppressLockQuitUntil = Date.now() + 5000;
  broadcastShieldState(false);
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
  const groupIds = new Set(session.collapsedGroupIds);

  try {
    const lockedGroups = await chrome.tabGroups.query({ title: "Locked" });
    for (const group of lockedGroups) {
      if (group.id != null) groupIds.add(group.id);
    }
  } catch {
    /* ignore */
  }

  for (const groupId of groupIds) {
    try {
      await chrome.tabGroups.update(groupId, { collapsed: false });
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

/** Brave often restores the window after we minimize ΓÇö retry until it sticks. */
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

async function closeDuplicateLockPopups(keepTabId) {
  const tabs = await chrome.tabs.query({ url: LOCK_PAGE() });
  for (const tab of tabs) {
    if (!tab.id || tab.id === keepTabId) continue;
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.type === "popup") {
        await chrome.windows.remove(tab.windowId);
      } else {
        await chrome.tabs.remove(tab.id);
      }
    } catch {
      /* ignore */
    }
  }
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
    await closeDuplicateLockPopups(existing.tabId);
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
  await closeDuplicateLockPopups(lockTab?.id ?? null);
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
  await stashHideTabs(tabs);
}

/** Hide every hideable tab; repeat until none left visible (startup). */
async function hideAllTabsInBrowserThoroughly(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await hideAllTabsInBrowser();
    const visible = await getVisibleHideableTabs();
    if (!visible.length) return;
    await sleep(450);
  }
}

/** Hide tabs in every normal window — tabs stay in place (no recreate, no close windows). */
async function hideAllTabsInBrowser() {
  const normalWins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const normalIds = new Set(normalWins.map((w) => w.id));
  const tabs = await chrome.tabs.query({});
  const toHide = tabs.filter(
    (t) => t.windowId != null && normalIds.has(t.windowId) && isHideableTab(t)
  );
  await stashHideTabs(toHide);

  const stillVisible = await getVisibleHideableTabs();
  if (stillVisible.length) await stashHideTabs(stillVisible);
}

async function getVisibleHideableTabs() {
  const normalWins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const normalIds = new Set(normalWins.map((w) => w.id));
  const tabs = await chrome.tabs.query({});
  const result = [];
  for (const tab of tabs) {
    if (!tab.id || tab.windowId == null || !normalIds.has(tab.windowId)) continue;
    if (!isHideableTab(tab)) continue;
    try {
      const full = await chrome.tabs.get(tab.id);
      if (!full.hidden) result.push(full);
    } catch {
      /* ignore */
    }
  }
  return result;
}

async function minimizeAllNormalWindowsExcept(exceptIds = []) {
  const except = new Set(exceptIds.filter((id) => id != null));
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of wins) {
    if (!win.id || except.has(win.id) || win.state === "minimized") continue;
    try {
      await chrome.windows.update(win.id, { state: "minimized" });
    } catch {
      /* ignore */
    }
  }
}

/** Edge/Chrome cannot hide tabs — keep normal windows minimized while locked. */
async function ensureAllNormalWindowsMinimizedExcept(exceptIds = [], maxAttempts = 6) {
  const except = new Set(exceptIds.filter((id) => id != null));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    let allMinimized = true;
    for (const win of wins) {
      if (!win.id || except.has(win.id)) continue;
      if (win.state === "minimized") continue;
      allMinimized = false;
      try {
        await chrome.windows.update(win.id, { state: "minimized" });
      } catch {
        /* ignore */
      }
    }
    if (allMinimized) return true;
    await sleep(120 + attempt * 80);
  }
  return false;
}

/** Move focus off session tabs so collapsed groups stick on Edge (no tabs.hide). */
async function prepareTabsForCollapse() {
  if (supportsTabHide()) return;
  // Tabs are grouped in stashHideTabs — no about:blank helpers (they pollute Edge session save).
}

function broadcastShieldState(show) {
  const type = show ? "SHOW_SHIELD" : "HIDE_SHIELD";
  chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file://*/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
    }
  });
}

/** Hide tabs and minimize every normal window except the PIN popup. */
async function secludeBrowserBehindLock(lockPopupId) {
  await prepareTabsForCollapse();
  await hideAllTabsInBrowserThoroughly(4);
  const session = await getSession();
  if (session.stashWindowId) {
    await ensureStashMinimized(session.stashWindowId);
  }
  const except = lockPopupId != null ? [lockPopupId] : [];
  await minimizeAllNormalWindowsExcept(except);
  await ensureAllNormalWindowsMinimizedExcept(except);
  broadcastShieldState(true);
  if (lockPopupId != null) {
    try {
      await chrome.windows.update(lockPopupId, { focused: true });
      await applyPopupLockBounds(lockPopupId);
    } catch {
      /* ignore */
    }
  }
}

async function unminimizeAllNormalWindows() {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of wins) {
    if (!win.id || win.state !== "minimized") continue;
    try {
      await chrome.windows.update(win.id, { state: "normal" });
    } catch {
      /* ignore */
    }
  }
}

async function stashHideTabs(tabs) {
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
    hiddenTabIds.push(...needsGroup);
  }

  if (hiddenTabIds.length) {
    await setSession({
      hiddenTabIds: [...new Set([...session.hiddenTabIds, ...hiddenTabIds])],
      collapsedGroupIds,
    });
  }
}

async function showAllHiddenTabs() {
  const session = await getSession();
  for (const tabId of session.hiddenTabIds) {
    await showTabId(tabId);
  }
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.hidden && !isLockTab(tab)) {
      await showTabId(tab.id);
    }
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

async function pickOrCreateStashWindow({ isStartupLock = false } = {}) {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });

  if (wins.length) {
    let bestId = null;
    let bestCount = -1;
    for (const win of wins) {
      if (!win.id) continue;
      const tabs = await chrome.tabs.query({ windowId: win.id });
      const count = tabs.filter((t) => !isLockTab(t)).length;
      if (count > bestCount) {
        bestCount = count;
        bestId = win.id;
      }
    }
    if (bestId != null) {
      if (!isStartupLock || bestCount > 0) return bestId;
    }
  }

  const focused = await chrome.windows.getLastFocused({
    windowTypes: ["normal"],
  });
  if (focused?.id && focused.type === "normal") {
    return focused.id;
  }

  for (const win of wins) {
    if (win.id) return win.id;
  }

  if (isStartupLock) return null;

  const created = await chrome.windows.create({
    url: "about:blank",
    type: "normal",
    focused: false,
  });
  return created.id;
}

function clearStartupTabCaptureWatchdog() {
  if (startupTabCaptureTimer != null) {
    clearInterval(startupTabCaptureTimer);
    startupTabCaptureTimer = null;
  }
}

/** Edge may still be restoring tabs after startup lock — keep capturing them. */
function scheduleStartupTabCaptureWatchdog(stashWindowId, popupId) {
  clearStartupTabCaptureWatchdog();
  const started = Date.now();
  startupTabCaptureTimer = setInterval(async () => {
    if (Date.now() - started > 30000) {
      clearStartupTabCaptureWatchdog();
      return;
    }
    const state = await getState();
    if (!state.isLocked) {
      clearStartupTabCaptureWatchdog();
      return;
    }
    await hideAllTabsInBrowser();
    const session = await getSession();
    await secludeBrowserBehindLock(popupId);
    if (session.stashWindowId) await ensureStashMinimized(session.stashWindowId);
  }, 1500);
}

/** While locked: hide any tab Edge restores into a normal window (never close the window). */
async function hideRestoredTabsInWindow(windowId) {
  const state = await getState();
  if (!state.isLocked || !windowId) return;

  const session = await getSession();
  if (windowId === session.lockWindowId) return;

  const tabs = await chrome.tabs.query({ windowId });
  const hideable = tabs.filter((t) => isHideableTab(t));
  if (!hideable.length) return;

  await stashHideTabs(hideable);
  try {
    await chrome.windows.update(windowId, { state: "minimized" });
  } catch {
    /* ignore */
  }
}

/** Hide a single tab restored after lock — stays in its window. */
async function hideRestoredTab(tab) {
  if (!tab?.id || !isHideableTab(tab)) return;
  const state = await getState();
  if (!state.isLocked) return;

  const session = await getSession();
  if (!session.lockReady || tab.windowId === session.lockWindowId) return;

  const url = tab.url || tab.pendingUrl || "";
  if (isInternalBrowserUrl(url)) {
    const windowId = tab.windowId;
    const siblings = await chrome.tabs.query({ windowId });
    if (siblings.length > 1) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* ignore */
      }
    }
    if (windowId != null) {
      try {
        await chrome.windows.update(windowId, { state: "minimized" });
      } catch {
        /* ignore */
      }
      await ensureAllNormalWindowsMinimizedExcept([session.lockWindowId]);
      if (session.lockWindowId != null) {
        try {
          await chrome.windows.update(session.lockWindowId, { focused: true });
        } catch {
          /* ignore */
        }
      }
    }
    return;
  }

  await stashHideTabs([tab]);
  if (tab.windowId != null) {
    try {
      await chrome.windows.update(tab.windowId, { state: "minimized" });
    } catch {
      /* ignore */
    }
  }
}

/** Minimized stash window (hidden tabs) + separate popup lock UI. */
async function prepareLockWindow({ isStartupLock = false } = {}) {
  preparingLock = true;
  suppressEventsUntil = Date.now() + 3000;

  try {
    let stashWindowId = await pickOrCreateStashWindow({ isStartupLock });
    if (stashWindowId == null && isStartupLock) {
      for (let i = 0; i < 6; i++) {
        await sleep(1000);
        stashWindowId = await pickOrCreateStashWindow({ isStartupLock: true });
        if (stashWindowId != null) break;
      }
    }
    if (stashWindowId == null) {
      stashWindowId = await pickOrCreateStashWindow({ isStartupLock: false });
    }
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

    if (isStartupLock) {
      const popupId = await ensureLockPopup();
      const afterPopup = await getSession();
      if (!(await findLockPopup())) {
        throw new Error("lock_popup_missing");
      }

      await setSession({
        lockReady: true,
        lockUiDismissed: false,
        lockWindowId: popupId,
        lockTabId: afterPopup.lockTabId,
        lockPopupShownAt: null,
      });

      await minimizeAllNormalWindowsExcept([]);
      await ensureAllNormalWindowsMinimizedExcept([]);

      await waitForSessionRestore();
      await hideAllTabsInBrowserThoroughly(8);

      await secludeBrowserBehindLock(popupId);
      await purgeExtensionPagesFromHistory();
      scheduleStashMinimizeWatchdog(stashWindowId);
      scheduleStartupTabCaptureWatchdog(stashWindowId, popupId);
      return popupId;
    }

    await hideAllTabsInWindow(stashWindowId);
    await ensureStashMinimized(stashWindowId);

    const popupId = await ensureLockPopup();
    const afterPopup = await getSession();
    if (!(await findLockPopup())) {
      throw new Error("lock_popup_missing");
    }

    await setSession({
      lockReady: true,
      lockUiDismissed: false,
      lockWindowId: popupId,
      lockTabId: afterPopup.lockTabId,
      lockPopupShownAt: null,
    });

    await secludeBrowserBehindLock(popupId);
    await purgeExtensionPagesFromHistory();

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
    await prepareLockWindow({ isStartupLock: true });
    return;
  }

  const found = await findLockPopup();
  if (!found) {
    const popupId = await ensureLockPopup();
    await secludeBrowserBehindLock(popupId);
    return;
  }

  enforcing = true;
  try {
    await secludeBrowserBehindLock(found.popupId);
  } catch {
    await ensureLockPopup();
  } finally {
    enforcing = false;
  }
}

async function resumeLockedSession() {
  const session = await getSession();
  if (!session.lockReady) {
    await prepareLockWindow({ isStartupLock: true });
    return;
  }
  const popup = await findLockPopup();
  const popupId = popup?.popupId ?? session.lockWindowId;
  await secludeBrowserBehindLock(popupId);
  if (!(await findLockPopup())) {
    await ensureLockPopup();
  }
  scheduleEnforce();
}

/** Retry until the PIN popup is visible (crash / restart recovery). */
async function ensureLockPopupWithRetry(maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await findLockPopup()) return true;
    try {
      await resumeLockedSession();
    } catch {
      /* ignore */
    }
    if (await findLockPopup()) return true;
    await sleep(800);
  }
  return Boolean(await findLockPopup());
}

/** Runs once per browser launch ΓÇö waits for session restore, then locks or resumes. */
async function runBrowserStartupLock() {
  if (startupLockFlowRunning) return;
  startupLockFlowRunning = true;
  chrome.alarms.clear("idle-lock");
  try {
    await sleep(SESSION_RESTORE_WAIT_MS);

    const state = await getState();
    if (!state.isConfigured) return;

    const coldLaunch = state.pendingColdStartLock;
    if (coldLaunch) await setState({ pendingColdStartLock: false });

    if (state.autoLockOnStartup) {
      const shouldLock =
        state.isLocked || coldLaunch || state.lockOnNextOpen;
      if (!shouldLock) {
        if (state.idleLockMinutes > 0) resetIdleAlarm(state.idleLockMinutes);
        return;
      }

      await setState({ lockOnNextOpen: false });
      if (!state.isLocked) {
        const res = await lockBrowser({ isStartupLock: true });
        if (!res.ok) {
          await markLockRequiredOnNextOpen();
          await emergencyUnlockBrowser();
        }
      } else {
        await resumeLockedSession();
        if (!(await ensureLockPopupWithRetry())) {
          if (Date.now() >= coldBootRecoveryUntil) {
            await emergencyUnlockBrowser();
          }
        }
      }
      startEnforceAlarm();
      return;
    }

    if (state.isLocked) {
      await resumeLockedSession();
      if (!(await ensureLockPopupWithRetry())) {
        if (Date.now() >= coldBootRecoveryUntil) {
          await emergencyUnlockBrowser();
        }
      }
      startEnforceAlarm();
    } else if (state.idleLockMinutes > 0) {
      resetIdleAlarm(state.idleLockMinutes);
    }
  } finally {
    startupLockFlowRunning = false;
  }
}

async function lockBrowser({ isStartupLock = false } = {}) {
  const state = await getState();
  if (!state.isConfigured) {
    chrome.runtime.openOptionsPage();
    return { ok: false, error: "not_configured" };
  }

  if (state.isLocked) {
    const popup = await findLockPopup();
    if (popup) {
      await secludeBrowserBehindLock(popup.popupId);
      return { ok: true };
    }
  }

  await saveSessionSnapshotBeforeQuit();
  await setState({ isLocked: true });
  await clearSession();
  try {
    await prepareLockWindow({ isStartupLock });
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
  startEnforceAlarm();
  return { ok: true };
}

async function unlockBrowser() {
  const session = await getSession();

  clearTimeout(enforceTimer);
  enforceTimer = null;
  suppressEventsUntil = Date.now() + 5000;
  preparingLock = false;

  await setState({ isLocked: false, lockOnNextOpen: false });
  coldBootRecoveryUntil = 0;

  await closeLockPopupSafely(session);

  await showAllHiddenTabs();
  await restoreFromSessionSnapshotIfNeeded();
  await unminimizeAllNormalWindows();

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
  clearStartupTabCaptureWatchdog();
  broadcastShieldState(false);
  resetIdleAlarm((await getState()).idleLockMinutes);
  scheduleSessionTabCountSave();
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
  chrome.alarms.create("enforce-lock", { periodInMinutes: 0.5 });
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
      await setState({ idleLockMinutes: 10 });
    }
    if (state.isLocked && !(await findLockPopup())) {
      await emergencyUnlockBrowser();
    }
  }
  bootstrapServiceWorker().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set(
    { pendingColdStartLock: true, lockOnNextOpen: true },
    () => bootstrapServiceWorker().catch(() => {})
  );
});

function getExtensionShortcutsUrl() {
  try {
    if (navigator.userAgent.includes("Edg/")) return "edge://extensions/shortcuts";
    if (navigator.userAgent.includes("Brave")) return "brave://extensions/shortcuts";
  } catch {
    /* ignore */
  }
  return "chrome://extensions/shortcuts";
}

function getBrowserStartupSettingsUrl() {
  try {
    if (navigator.userAgent.includes("Edg/")) return "edge://settings/onStartup";
    if (navigator.userAgent.includes("Brave")) return "brave://settings/onStartup";
  } catch {
    /* ignore */
  }
  return "chrome://settings/onStartup";
}

function scheduleStartupLockRecovery() {
  setTimeout(async () => {
    if (closingBrowserFromLockDismiss || preparingLock) return;
    const state = await getState();
    if (!state.isConfigured || !state.isLocked) return;
    if (await findLockPopup()) {
      await resumeLockedSession();
      return;
    }
    if (!(await ensureLockPopupWithRetry(4))) {
      if (Date.now() >= coldBootRecoveryUntil) {
        await emergencyUnlockBrowser();
      }
    }
  }, SESSION_RESTORE_WAIT_MS + 1200);
}

chrome.windows.onCreated.addListener((win) => {
  setTimeout(() => maybeAutoLockOnWindowOpen().catch(() => {}), 80);
  const tryAbsorb = (delayMs) => {
    setTimeout(async () => {
      if (preparingLock || Date.now() < suppressEventsUntil) return;
      const state = await getState();
      if (!state.isLocked || !win.id) return;

      const session = await getSession();
      if (win.id === session.lockWindowId || win.id === session.stashWindowId) return;

      const tabs = await chrome.tabs.query({ windowId: win.id });
      if (!tabs.length) return;

      await hideRestoredTabsInWindow(win.id);
      scheduleEnforce();
    }, delayMs);
  };
  tryAbsorb(400);
  tryAbsorb(1200);
  tryAbsorb(3000);
  tryAbsorb(6000);
  tryAbsorb(10000);
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

chrome.tabs.onActivated.addListener((activeInfo) => {
  noteBrowserActivity();
  saveSessionTabCountIfHigher().catch(() => {});

  setTimeout(async () => {
    if (preparingLock || Date.now() < suppressEventsUntil) return;
    const state = await getState();
    if (!state.isLocked) return;

    const session = await getSession();
    if (!session.lockReady || activeInfo.tabId === session.lockTabId) return;

    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.windowId === session.lockWindowId) return;
      await hideRestoredTab(tab);
      if (session.lockWindowId != null) {
        await chrome.windows.update(session.lockWindowId, { focused: true });
      }
    } catch {
      /* ignore */
    }
  }, 50);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    noteAllWindowsClosed().catch(() => {});
    setTimeout(() => noteAllWindowsClosed(), 400);
    return;
  }
  noteBrowserActivity();
  (async () => {
    const state = await getState();
    if (!state.isLocked) return;

    const session = await getSession();
    if (!session.lockReady) return;

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
      try {
        const win = await chrome.windows.get(windowId);
        if (win.type === "normal") {
          await hideRestoredTabsInWindow(windowId);
          await ensureAllNormalWindowsMinimizedExcept([session.lockWindowId]);
          await chrome.windows.update(session.lockWindowId, { focused: true });
        }
      } catch {
        /* ignore */
      }
      scheduleEnforce();
    }
  })().catch(() => {});
});

async function handleLockPopupClosedByUser() {
  if (closingBrowserFromLockDismiss || intentionalLockPopupClose) return;

  const session = await getSession();
  const state = await getState();
  if (!state.isLocked) return;

  // Lock UI was live — user closed the popup → quit the whole browser.
  if (session.lockReady) {
    await closeBrowserOnLockDismiss();
    return;
  }

  if (preparingLock || startupLockFlowRunning) return;

  // Popup torn down before it was ready — recover (crash/startup), never quit.
  if (Date.now() < suppressLockQuitUntil) return;
  try {
    await resumeLockedSession();
  } catch {
    /* ignore */
  }
}

/** Reliable X detection: lock page port drops when the popup window closes. */
function handleLockUiPortDisconnect(tabId) {
  setTimeout(async () => {
    if (closingBrowserFromLockDismiss || intentionalLockPopupClose) return;

    const state = await getState();
    if (!state.isLocked) return;

    const session = await getSession();
    if (!session.lockReady || tabId !== session.lockTabId) return;
    if (await findLockPopup()) return;

    await closeBrowserOnLockDismiss();
  }, 80);
}

/** Close all windows when the user dismisses the lock popup (title-bar X). */
async function closeBrowserOnLockDismiss() {
  if (closingBrowserFromLockDismiss) return;

  closingBrowserFromLockDismiss = true;
  suppressEventsUntil = Date.now() + 15000;
  preparingLock = false;
  startupLockFlowRunning = false;
  clearTimeout(enforceTimer);
  enforceTimer = null;
  stopEnforceAlarm();
  chrome.alarms.clear("idle-lock");
  clearStartupTabCaptureWatchdog();

  const state = await getState();
  const closeAll = chrome.windows
    .getAll({ populate: false })
    .then((wins) =>
      Promise.all(wins.map((win) => chrome.windows.remove(win.id).catch(() => {})))
    );

  await prepareBrowserForCleanQuit();

  await Promise.all([
    closeAll,
    setState({
      isLocked: false,
      lockOnNextOpen: state.autoLockOnStartup,
      pendingColdStartLock: state.autoLockOnStartup,
    }),
    clearSession(),
  ]);
}

chrome.windows.onRemoved.addListener((windowId) => {
  (async () => {
    if (closingBrowserFromLockDismiss || intentionalLockPopupClose) return;
    const state = await getState();
    if (state.isLocked) {
      const session = await getSession();
      if (session.lockWindowId === windowId) {
        await handleLockPopupClosedByUser();
        return;
      }
      if (session.lockReady) {
        await sleep(150);
        if (!(await findLockPopup())) {
          await handleLockPopupClosedByUser();
        }
      }
    } else if (Date.now() >= suppressLockQuitUntil) {
      await markLockRequiredOnNextOpen();
      await noteAllWindowsClosed();
    }
  })().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setTimeout(async () => {
    if (closingBrowserFromLockDismiss) return;
    const state = await getState();
    if (!state.isLocked) {
      scheduleSessionTabCountSave();
      return;
    }

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
  if (isLockPageUrl(url)) {
    setTimeout(() => handleStrayLockTab(tab), 0);
    return;
  }
  if (changeInfo.status === "complete" || changeInfo.url) {
    (async () => {
      const state = await getState();
      if (state.isLocked && isHideableTab(tab)) {
        await hideRestoredTab(tab);
      } else if (!state.isLocked) {
        noteBrowserActivity();
        scheduleSessionTabCountSave();
      }
    })().catch(() => {});
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  setTimeout(async () => {
    try {
      const fresh = tab.id ? await chrome.tabs.get(tab.id) : tab;
      const state = await getState();
      if (state.isLocked) {
        await hideRestoredTab(fresh);
      } else {
        saveSessionTabCountIfHigher().catch(() => {});
        scheduleSessionTabCountSave();
      }
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
      return;
    }
    noteBrowserActivity();
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
      case "CHANGE_PIN": {
        const state = await getState();
        if (!state.isConfigured) {
          sendResponse({ ok: false, error: "not_configured" });
          break;
        }
        if (state.isLocked) {
          sendResponse({ ok: false, error: "locked" });
          break;
        }
        const currentPin = String(message.currentPin || "");
        const newPin = String(message.newPin || "");
        if (!/^\d{4,8}$/.test(currentPin) || !/^\d{4,8}$/.test(newPin)) {
          sendResponse({ ok: false, error: "invalid_pin" });
          break;
        }
        const valid = await verifyPin(currentPin, state.pinHash, state.pinSalt);
        if (!valid) {
          sendResponse({ ok: false, error: "wrong_pin" });
          break;
        }
        const { hash, salt } = await hashPin(newPin);
        await setState({ pinHash: hash, pinSalt: salt });
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
            await prepareLockWindow({ isStartupLock: true });
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case "LOCK_UI_USER_CLOSED": {
        const state = await getState();
        if (!state.isLocked || closingBrowserFromLockDismiss || intentionalLockPopupClose) {
          sendResponse({ ok: false });
          break;
        }
        const session = await getSession();
        if (session.lockReady) {
          await closeBrowserOnLockDismiss();
          sendResponse({ ok: true });
          break;
        }
        sendResponse({ ok: false });
        break;
      }
      case "LOCK_UI_READY": {
        const tabId = _sender.tab?.id;
        const tabUrl = _sender.tab?.url || _sender.url || "";
        if (tabId && isLockPageUrl(tabUrl)) {
          await setSession({
            lockPopupShownAt: Date.now(),
            lockTabId: tabId,
            lockWindowId: _sender.tab?.windowId ?? null,
          });
        }
        sendResponse({ ok: true });
        break;
      }
      case "OPEN_SHORTCUTS_SETTINGS": {
        const url = getExtensionShortcutsUrl();
        try {
          await chrome.tabs.create({ url, active: true });
          sendResponse({ ok: true, url });
        } catch {
          sendResponse({ ok: false, error: "cannot_open", url });
        }
        break;
      }
      case "OPEN_SESSION_SETTINGS": {
        const url = getBrowserStartupSettingsUrl();
        try {
          await chrome.tabs.create({ url, active: true });
          sendResponse({ ok: true, url });
        } catch {
          sendResponse({ ok: false, error: "cannot_open", url });
        }
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lock-ui") return;
  const tabId = port.sender?.tab?.id;
  if (!tabId) return;
  port.onDisconnect.addListener(() => {
    handleLockUiPortDisconnect(tabId);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "lock-browser") return;
  (async () => {
    const state = await getState();
    if (!state.isConfigured || state.isLocked) return;
    const res = await lockBrowser();
    if (res.ok) startEnforceAlarm();
  })().catch(() => {});
});

chrome.runtime.onSuspend.addListener(() => {
  getState().then((state) => {
    if (state.isLocked) {
      chrome.storage.local.set({ recoveryLockPending: true });
    } else if (state.isConfigured && state.autoLockOnStartup) {
      chrome.storage.local.set({
        lockOnNextOpen: true,
        pendingColdStartLock: true,
      });
      saveSessionTabCount().catch(() => {});
    }
  });
});

setTimeout(() => bootstrapServiceWorker().catch(() => {}), 120);
