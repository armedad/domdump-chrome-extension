const urlInput = document.getElementById("url");
const includeHtml = document.getElementById("includeHtml");
const closeTab = document.getElementById("closeTab");
const saveAs = document.getElementById("saveAs");
const statusEl = document.getElementById("status");
const btnOpen = document.getElementById("openScrape");
const btnCurrent = document.getElementById("currentScrape");

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || "";
}

function options() {
  return {
    includeHtml: includeHtml.checked,
    closeTabAfter: closeTab.checked,
    saveAs: saveAs.checked,
  };
}

btnOpen.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Enter a URL.", "err");
    return;
  }
  btnOpen.disabled = true;
  btnCurrent.disabled = true;
  setStatus("Opening tab in background…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "SCRAPE_URL",
      url,
      options: options(),
    });
    console.info("[dom-scrape-md popup] SCRAPE_URL result", res);
    if (res?.ok) {
      setStatus(`Download started: ${res.filename}\n(Check Downloads / Chrome download bar.)`, "ok");
    } else {
      setStatus(res?.error || "Failed.", "err");
    }
  } catch (e) {
    const msg = chrome.runtime?.lastError?.message || String(e);
    setStatus(
      `Message to extension failed: ${msg}\nReload the extension on chrome://extensions and try again.`,
      "err"
    );
  } finally {
    btnOpen.disabled = false;
    btnCurrent.disabled = false;
  }
});

btnCurrent.addEventListener("click", async () => {
  btnOpen.disabled = true;
  btnCurrent.disabled = true;
  setStatus("Working…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "SCRAPE_ACTIVE",
      options: options(),
    });
    console.info("[dom-scrape-md popup] SCRAPE_ACTIVE result", res);
    if (res?.ok) {
      setStatus(`Saved: ${res.filename}`, "ok");
    } else {
      setStatus(res?.error || "Failed.", "err");
    }
  } catch (e) {
    const msg = chrome.runtime?.lastError?.message || String(e);
    setStatus(msg, "err");
  } finally {
    btnOpen.disabled = false;
    btnCurrent.disabled = false;
  }
});

chrome.storage.local.get(["lastUrl", "lastRun"], (r) => {
  if (r.lastUrl) urlInput.value = r.lastUrl;
  if (r.lastRun?.at) {
    const ageMin = Math.round((Date.now() - r.lastRun.at) / 60000);
    if (ageMin <= 60) {
      const line = r.lastRun.ok
        ? `Last run (${ageMin}m ago): saved ${r.lastRun.filename || "file"}.`
        : `Last run (${ageMin}m ago) failed: ${r.lastRun.error || "unknown error"}.`;
      const hint = document.createElement("div");
      hint.style.cssText = "margin-top:8px;font-size:11px;color:#666;";
      hint.textContent = line;
      statusEl.appendChild(hint);
    }
  }
});

urlInput.addEventListener("change", () => {
  const v = urlInput.value.trim();
  if (v) chrome.storage.local.set({ lastUrl: v });
});
