# Secure Browser Lock (sample)

Chrome extension sample similar to “Browser Lock” — PIN-protects your browsing session with a full-screen overlay on every tab.

## Quick test

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Choose this folder: `d:\secure\browser-lock`
5. The **Setup** page opens — set a 4–8 digit PIN and save
6. Click the extension icon → **Lock browser**
7. A **small popup** opens for your PIN (no tab bar in the popup)
8. Enter your PIN to unlock — Brave and tabs come back
9. Optional: **Auto-lock on startup**; enable **Allow in incognito** on the extension card
10. **Auto-lock after 5 minutes idle** (default) — change in Settings; mouse/keyboard/scroll/tab switches reset the timer

## What it does (v0.5.0)

- **Popup lock window** (420×520) — no tabs/address bar on the lock UI
- **Tabs hidden** in a minimized Brave window until unlock
- **Closes extra windows** while locked; new windows are handled automatically
- **Incognito** (`incognito: spanning`) when enabled on the extension card
- PIN stored as **PBKDF2 hash** only

## Limits (honest)

| Threat | Blocked? |
|--------|----------|
| Switching to another tab in same profile | Yes (hidden + guards) |
| Opening another Brave window (same profile) | Locked on create |
| Firefox / Edge / another Chrome profile | **No** — different app/profile |
| Disabling extension in `brave://extensions` | **No** — Chrome API limit |
| Browser ⋮ menu / settings UI | **No** — extensions cannot remove browser chrome |
| OS admin / safe mode | **No** |

For shared PCs: use **Windows sign-in password** + this extension together.
- Not foolproof against someone who disables the extension or uses another profile
- See `PLAN.md` for roadmap (biometrics, recovery, per-site lock)

## Files

| File | Role |
|------|------|
| `background.js` | Lock state, tabs, alarms |
| `crypto.js` | PIN hashing |
| `content/lock-overlay.*` | On-page lock UI |
| `popup.*` | Toolbar lock button |
| `setup.*` | PIN and settings |

## Development

After code changes: go to `chrome://extensions` → click **Reload** on this extension.
