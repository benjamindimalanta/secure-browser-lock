# Browser Secure

**PIN-lock your Chromium browser** (Chrome, Brave, Edge) on startup, idle, or demand. Hides tabs until you unlock. All data stays on your device.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](manifest.json)
[![Version](https://img.shields.io/badge/version-1.1.4-green)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

---

## Features

| Feature | Description |
|---------|-------------|
| **PIN lock** | 4–8 digit PIN; stored as salted PBKDF2 hash only (never plain text) |
| **Lock popup** | Compact PIN window (no address bar); tabs hidden in background |
| **Auto-lock on open** | PIN required every time you open the browser (default: on) |
| **Idle auto-lock** | Locks after **10 minutes** of no use (configurable; `0` = off) |
| **Manual lock** | Lock anytime from the toolbar icon or **Ctrl+Shift+L** |
| **Change PIN** | Update your PIN in Settings without reinstalling |
| **Close (✕) quits browser** | Closing the PIN window exits Brave/Chrome/Edge; reopening asks for PIN again |
| **History protection** | Lock pages removed from history (reduces Ctrl+Shift+T bypass) |
| **Backup overlay** | Lock overlay on open web tabs while locked |
| **Incognito support** | Works across normal + incognito when enabled on the extension card |
| **No cloud / no tracking** | No accounts, analytics, or remote code |

---

## Supported browsers

- Google Chrome
- Microsoft Edge
- Brave

Requires **Manifest V3** support (Chromium 88+).

---

## Installation

### Option A — Load unpacked (development / testing)

1. Download or clone this repository.
2. Open your browser extensions page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select the `browser-lock` folder (must contain `manifest.json` at the root).
6. The **Setup** page opens automatically on first install.

### Option B — Chrome Web Store

> Coming soon — check [Releases](https://github.com/benjamindimalanta/secure-browser-lock/releases) for updates.

### Option C — Install from release ZIP

1. Go to [Releases](https://github.com/benjamindimalanta/secure-browser-lock/releases).
2. Download `browser-secure-v1.0.1.zip`.
3. Unzip to a folder.
4. Load unpacked from that folder (steps above).

---

## Setup (first time)

1. **Set your PIN**
   - Open extension **Options** (right-click icon → Options, or via `brave://extensions` → Details).
   - Enter a **4–8 digit PIN** and confirm.
   - Click **Save PIN**.

2. **Configure behavior** (Settings on the same page)
   - **Auto-lock when browser opens** — PIN required on every launch (recommended).
   - **Auto-lock after idle** — Minutes of inactivity before lock (default: `10`; set `0` to disable).
   - Click **Save settings**.

3. **Optional: Incognito**
   - On the extension card, enable **Allow in incognito** if you use private windows.

4. **Pin the toolbar icon**
   - Click the puzzle piece → pin **Browser Secure** for quick access.

---

## How to use

### Lock the browser

- Click the **Browser Secure** toolbar icon → **Lock browser**, or
- Press **Ctrl+Shift+L** (customize at `chrome://extensions/shortcuts`), or
- Wait for **auto-lock** (on startup or after idle timeout).

### Change PIN

1. Open extension **Options** (must be unlocked).
2. Under **Change PIN**, enter current PIN and new PIN.
3. Click **Update PIN**.

### Unlock

- Enter your PIN in the lock popup → **Unlock**.

### Close without unlocking

- Click **✕** on the PIN window → **browser quits entirely**.
- Open the browser again → PIN screen appears (if auto-lock on open is enabled).

### Show lock screen again (if needed)

- Toolbar icon → **Show lock screen** (when locked but popup is missing).

---

## How it works (technical overview)

```
Browser opens
    → Extension checks: PIN configured? Auto-lock enabled?
    → Hides all tabs in a minimized window (stash)
    → Opens small popup with lock.html (PIN entry)
    → User enters PIN → tabs restored, popup closed

While locked:
    → New windows/tabs are blocked or absorbed
    → Web pages show a backup lock overlay (content script)
    → Idle timer paused until unlock
```

**Storage:**

| Data | Where | Notes |
|------|-------|-------|
| PIN hash + salt | `chrome.storage.local` | Permanent until reset |
| Lock state, hidden tab IDs | `chrome.storage.session` | Cleared when browser fully quits |
| Settings | `chrome.storage.local` | Auto-lock, idle minutes |

---

## Permissions

Every permission is required for core functionality. **No data is sent to external servers.**

| Permission | Why it is needed |
|------------|------------------|
| `storage` | Save PIN hash, settings, and lock flags locally |
| `tabs` | Hide/show tabs; detect tab activity for idle reset |
| `windows` | Open PIN popup; minimize stash window; close extra windows |
| `tabGroups` | Collapse tabs that cannot be hidden (fallback grouping) |
| `alarms` | Idle auto-lock timer |
| `system.display` | Center the PIN popup on your screen |
| `history` | Remove lock/setup pages from browser history |
| `webNavigation` | Block lock page from staying in navigation history |

**Content scripts** (not a manifest permission, but declared in `manifest.json`):

| Match | Why |
|-------|-----|
| `http://*/*`, `https://*/*`, `file://*/*` | Show backup lock overlay on open web pages while locked |

There is **no** `host_permissions` / `<all_urls>` in the manifest — content scripts use scoped URL matches only.

---

## Privacy & security

- **PIN:** PBKDF2 hash with random salt (`crypto.js`). Plain PIN is never stored.
- **No remote code:** All logic is bundled; CSP blocks external scripts.
- **No analytics or ads.**
- **Privacy policy:** [privacy.html](privacy.html)

Full policy URL for store listing:
`https://github.com/benjamindimalanta/secure-browser-lock/blob/master/privacy.html`

---

## What it can and cannot do

| Can | Cannot |
|-----|--------|
| Hide tabs in the same browser profile | Block Firefox, Safari, or another Chromium profile |
| Lock on startup, idle, or manual demand | Prevent someone from disabling the extension in `chrome://extensions` |
| Quit browser when PIN window is closed (✕) | Remove OS title-bar buttons or browser ⋮ menu |
| Block most casual snooping on a shared PC | Replace Windows account password or disk encryption |

**Best for:** shared family PC, quick privacy when stepping away.  
**Pair with:** Windows sign-in password for stronger protection.

---

## Troubleshooting

### Brave/Edge closes immediately on open

1. Run `emergency-unlock.bat` (Brave) or `emergency-unlock-edge.bat` (Edge).
2. Go to extensions page → **Reload** Browser Secure.
3. If still stuck: run `reset-brave-lock-state.bat` (clears saved lock data; you will set PIN again).

### Extension stuck / PIN screen missing

- `brave://extensions` → Reload extension  
- Or run `reset-brave-lock-state.bat`

### Change icon

Preview alternatives in `icons/previews/`. Active icons: `icons/icon16.png`, `icon48.png`, `icon128.png`.

---

## Project structure

| Path | Role |
|------|------|
| `manifest.json` | Extension config (MV3) |
| `background.js` | Lock logic, windows, tabs, alarms |
| `crypto.js` | PIN hashing (PBKDF2) |
| `lock.html/js/css` | PIN popup UI |
| `lock-hardening.js` | Block shortcuts on lock page |
| `popup.html/js/css` | Toolbar popup |
| `setup.html/js/css` | PIN setup & settings |
| `content/lock-overlay.*` | Backup overlay on web tabs |
| `privacy.html` | Privacy policy |
| `CHROME_WEB_STORE.md` | Store submission checklist |
| `icons/` | Extension icons |

---

## Build ZIP for Chrome Web Store

```powershell
cd browser-lock
Compress-Archive -Path manifest.json,background.js,crypto.js,lock.html,lock.js,lock.css,lock-hardening.js,popup.html,popup.js,popup.css,setup.html,setup.js,setup.css,privacy.html,icons,content -DestinationPath ..\browser-secure.zip -Force
```

See [CHROME_WEB_STORE.md](CHROME_WEB_STORE.md) for the full submission checklist.

---

## Development

After code changes:

```
brave://extensions  →  Reload "Browser Secure"
```

Bump `version` in `manifest.json` before each store upload.

---

## License

MIT — use and modify freely. No warranty; see limits above.

---

## Links

- **Repository:** https://github.com/benjamindimalanta/secure-browser-lock
- **Releases:** https://github.com/benjamindimalanta/secure-browser-lock/releases
- **Issues:** https://github.com/benjamindimalanta/secure-browser-lock/issues
