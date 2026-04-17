const WAIT_MS_AFTER_LOAD = 2500;
const POLL_MS = 250;

/** Passed to injected scraper via chrome.storage.local (session storage is SW-only). */
const PENDING_SCRAPE_KEY = "__domScrapeMd_pending__";

/** @type {{ resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> } | null} */
let scrapeWait = null;

function log(...args) {
  console.info("[dom-scrape-md]", ...args);
}

function safeFilename(title) {
  const base = (title || "scrape")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `dom-scrape-${base}-${ts}.md`;
}

async function recordLastRun(payload) {
  try {
    await chrome.storage.local.set({ lastRun: { at: Date.now(), ...payload } });
  } catch (_) {
    /* ignore */
  }
}

/**
 * MV3 extension service workers do not implement URL.createObjectURL for Blob.
 * Use FileReader → data URL, which chrome.downloads accepts.
 */
function downloadMarkdown(filename, text, saveAs) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  log("downloadMarkdown", { filename, bytes: blob.size, saveAs: !!saveAs });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        reject(new Error("FileReader did not produce a data URL."));
        return;
      }
      chrome.downloads.download(
        {
          url: dataUrl,
          filename,
          saveAs: !!saveAs,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            log("download failed", chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          log("download started", { downloadId, filename });
          resolve();
        }
      );
    };
    reader.onerror = () => {
      reject(reader.error || new Error("FileReader failed while preparing download."));
    };
    reader.readAsDataURL(blob);
  });
}

function beginWaitForScrapePayload(timeoutMs) {
  return new Promise((resolve, reject) => {
    const slot = { resolve, reject, timer: null };
    slot.timer = setTimeout(() => {
      if (scrapeWait === slot) {
        scrapeWait = null;
        reject(new Error("Timed out waiting for scrape result."));
      }
    }, timeoutMs);
    scrapeWait = slot;
  });
}

function finishScrapePayload(payload) {
  if (!scrapeWait) {
    log("scrape result ignored (no pending listener)");
    return;
  }
  clearTimeout(scrapeWait.timer);
  log("scrape payload received", {
    titleLen: (payload?.title || "").length,
    mdLen: (payload?.markdown || "").length,
    url: payload?.pageUrl,
  });
  scrapeWait.resolve(payload);
  scrapeWait = null;
}

function failScrapePayload(err) {
  if (!scrapeWait) return;
  clearTimeout(scrapeWait.timer);
  scrapeWait.reject(err);
  scrapeWait = null;
}

async function injectScraper(tabId, options) {
  log("injectScraper start", { tabId });
  await chrome.storage.local.set({
    [PENDING_SCRAPE_KEY]: {
      includeHtml: !!options.includeHtml,
    },
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["scraper.js"],
  });
  log("injectScraper done", { tabId });
}

async function scrapeTabToDownloads(tabId, options) {
  const payloadPromise = beginWaitForScrapePayload(120_000);
  try {
    await injectScraper(tabId, options || {});
  } catch (e) {
    await chrome.storage.local.remove(PENDING_SCRAPE_KEY).catch(() => {});
    failScrapePayload(
      new Error(
        `Inject failed: ${e?.message || e}. Check that the page is not a restricted chrome:// URL.`
      )
    );
    try {
      await payloadPromise;
    } catch (_) {
      /* drained */
    }
    throw e;
  }
  const payload = await payloadPromise;
  if (!payload || typeof payload.markdown !== "string") {
    throw new Error("Invalid scrape payload (missing markdown).");
  }
  const filename = safeFilename(payload.title);
  await downloadMarkdown(filename, payload.markdown, !!options?.saveAs);
  log("scrapeTabToDownloads complete", { filename });
  return { ok: true, filename };
}

async function waitUntilTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error("Timed out waiting for tab to finish loading.");
}

async function runScrapeActive(options) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  if (!tab.url || tab.url.startsWith("chrome://")) {
    throw new Error("Cannot scrape this page type (restricted URL).");
  }
  log("runScrapeActive", { tabId: tab.id, url: tab.url });
  const res = await scrapeTabToDownloads(tab.id, options);
  await recordLastRun({ ok: true, filename: res.filename });
  return res;
}

async function runScrapeUrl(url, options) {
  const raw = String(url || "").trim();
  if (!raw) throw new Error("Missing URL.");
  void new URL(raw);

  log("runScrapeUrl create tab", raw);
  const tab = await chrome.tabs.create({ url: raw, active: false });
  if (!tab.id) throw new Error("Could not create tab.");

  log("runScrapeUrl wait complete", { tabId: tab.id });
  await waitUntilTabComplete(tab.id, 180_000);
  log("runScrapeUrl post-load delay", WAIT_MS_AFTER_LOAD);
  await new Promise((r) => setTimeout(r, WAIT_MS_AFTER_LOAD));

  const res = await scrapeTabToDownloads(tab.id, options);
  if (options.closeTabAfter) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (_) {
      /* ignore */
    }
  } else {
    try {
      await chrome.tabs.update(tab.id, { active: true });
    } catch (_) {
      /* ignore */
    }
  }
  await recordLastRun({ ok: true, filename: res.filename });
  return res;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCRAPE_RESULT_RAW" && message.payload) {
    finishScrapePayload(message.payload);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "SCRAPE_ACTIVE" || message?.type === "SCRAPE_URL") {
    log("onMessage", message.type, message.url || "(active tab)");
    const p = (async () => {
      try {
        const options = message.options || {};
        if (message.type === "SCRAPE_ACTIVE") {
          return await runScrapeActive(options);
        }
        return await runScrapeUrl(message.url, options);
      } catch (e) {
        const err = String(e?.message || e);
        log("run failed", err);
        await recordLastRun({ ok: false, error: err });
        return { ok: false, error: err };
      }
    })();

    p.then((result) => {
      log("run finished", result);
      sendResponse(result);
    }).catch((e) => {
      log("run promise rejected", e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    });
    return true;
  }

  return false;
});

log("service worker started");
