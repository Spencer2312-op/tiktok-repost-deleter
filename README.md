# TikTok Repost Deleter

A lightweight browser extension for Chrome, Firefox, and Edge that removes all reposts from your TikTok account in one click — no manual work required.

---

## Features

- **One-click deletion** — hit the button and walk away
- **Live progress counter** — shows "Deleting repost 3 of 12..." as it runs
- **Rate-limit safe** — 1.5 second delay between each deletion
- **Smart error handling** — detects if you are not logged in, have no reposts, or are on the wrong page
- **No dependencies** — pure HTML, CSS, and JavaScript; nothing to install
- **Manifest V3** — compatible with the current Chrome Web Store standard

---

## Screenshots

> Open TikTok, click the extension icon, press the button.

```
┌─────────────────────────────┐
│   TikTok Repost Deleter     │
│                             │
│  [ Delete All Reposts ]     │
│  ━━━━━━━━━━━━━━━━━━━━━      │
│  Deleting repost 4 of 11... │
└─────────────────────────────┘
```

---

## Installation

### Chrome / Edge (Developer Mode)

1. Download or clone this repository
   ```
   git clone https://github.com/Spencer2312-op/tiktok-repost-deleter.git
   ```
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge)
3. Toggle **Developer mode** on (top-right switch)
4. Click **Load unpacked**
5. Select the `tiktok-repost-deleter` folder
6. The extension icon appears in your toolbar

### Firefox (Temporary Add-on)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select any file inside the `tiktok-repost-deleter` folder

> Note: Firefox temporary add-ons are removed when the browser closes. For a permanent install, the extension would need to be signed through Mozilla.

---

## Usage

1. Log into your TikTok account at [tiktok.com](https://www.tiktok.com)
2. Click the **TikTok Repost Deleter** icon in your browser toolbar
3. Click **Delete All Reposts**
4. Watch the live status update as each repost is removed
5. When complete, the popup shows **"All reposts deleted!"**

---

## How It Works

```
popup.js  ──sendMessage──►  content.js
                               │
                    Navigate to /@username/repost
                               │
                    For each video card:
                      1. Hover card
                      2. Click "..." menu
                      3. Click "Remove repost"
                      4. Confirm if prompted
                      5. Wait 1.5s
                               │
                    sendMessage back with progress
                               │
popup.js  ◄──progress/done──  content.js
```

The content script runs entirely inside the TikTok tab. It uses `MutationObserver` to wait for dynamic React elements to appear rather than relying on fixed timeouts, making it resilient to slow connections.

---

## File Structure

```
tiktok-repost-deleter/
├── manifest.json   # Manifest V3 config — permissions, host rules, action
├── popup.html      # Extension popup UI
├── popup.js        # Button handler and message listener
├── content.js      # DOM automation that runs inside the TikTok tab
├── styles.css      # TikTok-themed black/pink styling
└── icon.png        # 128x128 toolbar icon
```

---

## Updating Selectors

TikTok is a React SPA and redesigns its UI periodically. All CSS selectors are stored in one place at the top of `content.js`:

```js
const SELECTORS = {
  userAvatar:       '...',
  repostTab:        '...',
  videoCard:        '...',
  moreBtn:          '...',
  removeRepostItem: '...',
  confirmBtn:       '...',
};
```

If the extension stops working after a TikTok update, open DevTools on your profile page, inspect the relevant elements, and update the selectors here. The script also falls back to scanning menu item text for the word `"repost"` as an extra layer of resilience.

---

## Edge Cases

| Situation | What happens |
|---|---|
| Not logged in | Shows "Please log in to TikTok first" |
| No reposts found | Shows "No reposts found" |
| Used on a non-TikTok page | Shows "Please open TikTok in this tab first" |
| TikTok rate limits | 1.5s delay between deletions; retries up to 3× per item |
| TikTok UI changes | Update `SELECTORS` in `content.js` |

---

## Permissions

| Permission | Why it is needed |
|---|---|
| `activeTab` | Read the URL of the current tab to confirm it is TikTok |
| `scripting` | Inject `content.js` into the TikTok tab |
| `tabs` | Query the active tab to get its ID |
| `https://*.tiktok.com/*` | Host permission required to run scripts on TikTok |

No data is collected, stored, or transmitted anywhere. Everything runs locally in your browser.

---

## Contributing

Pull requests are welcome. If TikTok updates their UI and you have working selectors, open a PR updating the `SELECTORS` object in `content.js`.

1. Fork the repo
2. Create a branch: `git checkout -b fix/selectors-2025`
3. Commit your changes
4. Open a pull request

---

## License

MIT — do whatever you want with it.

---

## Disclaimer

This extension interacts with TikTok's web interface through normal browser actions, the same way a human would. Use it responsibly. Deleting reposts cannot be undone.
