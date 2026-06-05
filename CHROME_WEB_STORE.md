# Chrome Web Store submission — Browser Secure

Use this checklist before uploading the ZIP to the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Extension package (included in repo)

| Requirement | Status |
|-------------|--------|
| Manifest V3 | Yes (`manifest.json`) |
| `manifest.json` at ZIP root | Yes |
| Icons 16 / 48 / 128 PNG | Yes (`icons/`) |
| No remote hosted code | Yes — all scripts are bundled |
| CSP on extension pages | Yes |
| Version increases each release | Yes — bump `version` in manifest |
| Description ≤ 132 characters | Yes — see `manifest.json` |

## Store listing (you fill in the dashboard)

| Item | Guidance |
|------|----------|
| **Name** | Browser Secure |
| **Summary** | Same as manifest `description` |
| **Category** | Productivity or Privacy & Security |
| **Language** | English |
| **Privacy policy URL** | `https://github.com/benjamindimalanta/secure-browser-lock/blob/master/privacy.html` (or host `privacy.html` on a public URL) |
| **Screenshots** | At least 1 image, 1280×800 or 640×400 — capture PIN screen, settings, toolbar popup |
| **Promotional tile** | 440×280 PNG (optional but recommended) |
| **Single purpose** | Lock the browser with a PIN; hide tabs until unlock |
| **Permission justifications** | Copy from `privacy.html` permissions section |

## Privacy tab (dashboard)

Declare:

- **Single purpose:** Browser PIN lock / session protection
- **Data handling:** No data sold; PIN stored locally as hash only; no remote transmission
- **Uses host permissions:** No (content scripts use `http/https/file` matches only)
- **Certification:** Accurate answers matching `privacy.html`

## Test instructions (for reviewers)

1. Install unpacked or from submitted ZIP.
2. Open **Options** (setup page) → set a 4–8 digit PIN → Save.
3. Click extension icon → **Lock browser** → PIN popup appears; tabs hidden.
4. Enter PIN → browser unlocks.
5. **Auto-lock on open** is enabled by default — close all windows, reopen → PIN required.

Test PIN example: `1234` (use your own during review).

## Common rejection risks — how we address them

| Risk | Mitigation |
|------|------------|
| Broad `host_permissions` | Removed; only scoped content script matches |
| Misleading name/description | Renamed to **Browser Secure**; honest limits in setup page |
| Missing privacy policy | `privacy.html` added |
| Unused permissions | Removed `scripting` and `<all_urls>` host access; only permissions in use remain |
| Remote code | None |

## Build ZIP for upload

From the `browser-lock` folder (exclude `.git`, `.bat` helpers optional):

```powershell
Compress-Archive -Path * -DestinationPath browser-secure.zip -Force
```

Or zip only store-required files: manifest, JS, HTML, CSS, icons, crypto.js, content/, privacy.html.

## After approval

- Use **staged rollout** for first public release.
- Respond to policy emails within 30 days if publish is deferred.
