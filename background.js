const WAIT_MS_AFTER_LOAD = 2500;
const POLL_MS = 250;
const DEFAULT_MAX_PAGES = 30;
const ABS_MAX_PAGES = 100;

/** Passed to injected scraper via chrome.storage.local (session storage is SW-only). */
const PENDING_SCRAPE_KEY = "__domScrapeMd_pending__";

/** @type {{ resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> } | null} */
let scrapeWait = null;

function log(...args) {
  console.info("[dom-scrape-md]", ...args);
}

function simpleUrlHash(url) {
  let h = 0;
  const s = String(url);
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, "0").slice(0, 10);
}

function markdownFilename(title, pageUrl, pageIndex) {
  const base = (title || "page")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  const idx = pageIndex !== undefined && pageIndex !== null ? `p${String(pageIndex).padStart(2, "0")}-` : "";
  const h = simpleUrlHash(pageUrl);
  const ts = Date.now();
  return `dom-scrape-${idx}${base}-h${h}-${ts}.md`;
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
  const filename = markdownFilename(
    payload.title,
    payload.pageUrl,
    options?.pageIndex
  );
  await downloadMarkdown(filename, payload.markdown, !!options?.saveAs);
  log("scrapeTabToDownloads complete", { filename });
  return { ok: true, filename };
}

function normalizeHttpUrl(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch (_) {
    return null;
  }
}

/**
 * Collect absolute http(s) links on the page whose URL contains `needle` (case-insensitive).
 */
async function collectMatchingLinks(tabId, needle) {
  const n = String(needle || "").trim();
  if (!n) return [];

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: (needleRaw) => {
      const needleLc = String(needleRaw || "").trim().toLowerCase();
      if (!needleLc) return [];
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll("a[href]")) {
        try {
          const raw = a.getAttribute("href");
          if (!raw) continue;
          const abs = new URL(raw, location.href).href;
          if (!abs.startsWith("http")) continue;
          if (abs.toLowerCase().includes(needleLc) && !seen.has(abs)) {
            seen.add(abs);
            out.push(abs);
          }
        } catch (_) {
          /* skip */
        }
      }
      return out;
    },
    args: [n],
  });

  return Array.isArray(result) ? result : [];
}

function buildVisitList(mainUrl, extras, maxTotal) {
  const cap = Math.min(ABS_MAX_PAGES, Math.max(1, maxTotal));
  const seen = new Set();
  const ordered = [];

  const push = (u) => {
    const norm = normalizeHttpUrl(u);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    ordered.push(norm);
  };

  push(mainUrl);
  for (const u of extras) push(u);
  return ordered.slice(0, cap);
}

function clampMaxPages(n) {
  const x = Number.parseInt(String(n), 10);
  if (Number.isNaN(x)) return DEFAULT_MAX_PAGES;
  return Math.min(ABS_MAX_PAGES, Math.max(1, x));
}

async function scrapeMultiplePages(tabId, urls, options) {
  const filenames = [];
  const errors = [];

  for (let i = 0; i < urls.length; i += 1) {
    const u = urls[i];
    try {
      if (i > 0) {
        log("navigate to linked page", { i, u });
        await chrome.tabs.update(tabId, { url: u });
        await waitUntilTabComplete(tabId, 180_000);
        await new Promise((r) => setTimeout(r, WAIT_MS_AFTER_LOAD));
      }
      const r = await scrapeTabToDownloads(tabId, { ...options, pageIndex: i });
      filenames.push(r.filename);
    } catch (e) {
      const msg = `${u}: ${e?.message || e}`;
      errors.push(msg);
      log("page scrape failed", msg);
    }
  }

  if (filenames.length === 0) {
    throw new Error(errors.join("\n") || "All page scrapes failed.");
  }

  return {
    ok: true,
    filenames,
    count: filenames.length,
    errors: errors.length ? errors : undefined,
  };
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

  const filter = String(options.linkContains || "").trim();
  let res;
  if (filter) {
    await waitUntilTabComplete(tab.id, 60_000);
    await new Promise((r) => setTimeout(r, WAIT_MS_AFTER_LOAD));
    const mainUrl = (await chrome.tabs.get(tab.id)).url || tab.url;
    const extras = await collectMatchingLinks(tab.id, filter);
    const maxTotal = clampMaxPages(options.maxTotalPages);
    const urls = buildVisitList(mainUrl, extras, maxTotal);
    log("follow links", { filter, extras: extras.length, visiting: urls.length });
    res = await scrapeMultiplePages(tab.id, urls, options);
  } else {
    res = await scrapeTabToDownloads(tab.id, options);
  }

  await recordLastRun({
    ok: true,
    filename: res.filename || res.filenames?.[res.filenames.length - 1],
    filenames: res.filenames,
    count: res.count || (res.filename ? 1 : 0),
    errors: res.errors,
  });
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

  const filter = String(options.linkContains || "").trim();
  let res;
  if (filter) {
    const mainUrl = (await chrome.tabs.get(tab.id)).url || raw;
    const extras = await collectMatchingLinks(tab.id, filter);
    const maxTotal = clampMaxPages(options.maxTotalPages);
    const urls = buildVisitList(mainUrl, extras, maxTotal);
    log("follow links", { filter, extras: extras.length, visiting: urls.length });
    res = await scrapeMultiplePages(tab.id, urls, options);
  } else {
    res = await scrapeTabToDownloads(tab.id, options);
  }

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

  await recordLastRun({
    ok: true,
    filename: res.filename || res.filenames?.[res.filenames.length - 1],
    filenames: res.filenames,
    count: res.count || (res.filename ? 1 : 0),
    errors: res.errors,
  });
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
