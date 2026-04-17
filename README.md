# DOM to Markdown (Chrome extension)

Opens a URL (optional) or scrapes the **active tab**, walks the DOM, and downloads a **Markdown** file to your Downloads folder for downstream processing.

## Where to look in DevTools (important)

Extension code **does not log** to the website’s tab console (e.g. LoopNet’s DevTools).

| What you want | Where to open DevTools |
|----------------|-------------------------|
| Background / downloads / tab timing | `chrome://extensions` → **DOM to Markdown** → **Service worker** → *Inspect* |
| Popup UI + `sendMessage` result | Open the extension popup → **right‑click inside the popup** → **Inspect** |
| Injected scraper (`[dom-scrape-md:page]` lines) | DevTools on the **target page** → console filter `dom-scrape-md` (may show as the extension’s isolated world depending on Chrome version) |

After clicking **Open URL & download .md**, you should see `[dom-scrape-md]` lines in the **service worker** console within a few seconds. If there are **zero** lines, the click may not be reaching the background (reload the extension).

## Install (unpacked)

1. Open Chrome → **Extensions** → enable **Developer mode**.
2. **Load unpacked** → select this folder: `coding/chrome-extension-dom-scrape-md/`.
3. Approve permissions (`<all_urls>` is required so you can scrape arbitrary sites you choose).

## Use

1. Click the extension icon.
2. Either:
   - Paste a URL and click **Open URL & download .md**, or  
   - On the tab you care about, click **Scrape active tab & download .md**.
3. Options:
   - **Include HTML snapshot** — adds a large fenced `html` block (truncated).
   - **Close tab after scrape** — only for the URL flow.
   - **Prompt “Save as…”** — uses Chrome’s save dialog instead of silent download.

The `.md` includes: title, URL, timestamp, plain text (main/article/body fallback), heading outline, links, tables (limited rows), meta tags, optional HTML.

### Follow links (one `.md` per page)

1. Fill **“URL must contain”** with a substring that must appear in each link’s absolute URL, **case-insensitive** (e.g. `loopnet.com/Listing`).
2. Set **Max pages total** — the **first** page is always the page you opened (or the active tab); then matching links from that page are visited in order, up to this cap (max 100).
3. Only **http/https** links are followed. Each successful page produces **one** Markdown download with a unique filename (`dom-scrape-p00-…`, `p01-…`, …).

**Active-tab mode:** the extension will **navigate the same tab** through each URL in sequence (you leave the original page until it finishes). **Open-URL mode** uses one background tab the same way.

If some pages fail (timeout, block), others can still succeed; the popup lists **partial errors** when that happens.

## Notes

- **Restricted pages** (`chrome://`, Web Store, etc.) cannot be scripted.
- **SPAs** (LoopNet, etc.) may still be loading after `complete`; increase wait in `background.js` (`WAIT_MS_AFTER_LOAD`) if captures are empty.
- **Terms of use**: only scrape sites you’re allowed to automate.
- **Concurrent scrapes**: one at a time; overlapping runs can confuse the result handler.

## If nothing downloads

1. **Reload the extension** on `chrome://extensions` (Developer mode → Reload) after updates.
2. Open **Service worker → Inspect views: service worker** on the extension card and check the **Console** for errors (inject failures, download errors).
3. **Chrome download settings**: Settings → Downloads — ensure downloads are allowed and not blocked for the site.
4. **“Open URL” flow** opens the tab **in the background** first (so the popup stays open), then focuses that tab after the scrape; check the **download bar** at the bottom of Chrome.
5. Re-open the popup within **~60 minutes**: it shows the **last run** status line (success path writes `lastRun` to `chrome.storage.local`).

**Huge exports:** downloads use a `data:` URL from `FileReader` (service workers lack `URL.createObjectURL` for blobs). Very large pages with **Include HTML snapshot** could hit Chrome / memory limits; turn that option off or scrape a lighter view.

## Files

- `manifest.json` — MV3 manifest  
- `background.js` — tab lifecycle, inject, download  
- `scraper.js` — injected DOM → markdown  
- `popup.html` / `popup.js` — UI  
