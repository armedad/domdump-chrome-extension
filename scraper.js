/**
 * Injected (isolated world). Reads options from chrome.storage.local, builds markdown,
 * sends result to the service worker. (storage.session is not available in this context.)
 */
(async () => {
  const PENDING_SCRAPE_KEY = "__domScrapeMd_pending__";
  const log = (...a) => console.info("[dom-scrape-md:page]", ...a);

  try {
    const bag = await chrome.storage.local.get(PENDING_SCRAPE_KEY);
    const pending = bag[PENDING_SCRAPE_KEY];
    await chrome.storage.local.remove(PENDING_SCRAPE_KEY);
    const includeHtml = !!(pending && pending.includeHtml);

    const d = document;
    const now = new Date().toISOString();

    const esc = (s) =>
      String(s)
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ")
        .trim();

    const lines = [];
    lines.push(`# ${d.title || "Untitled"}`);
    lines.push("");
    lines.push(`**Source URL:** ${d.location.href}`);
    lines.push(`**Scraped at (UTC):** ${now}`);
    lines.push("");
    lines.push("---");
    lines.push("");

    const main =
      d.querySelector("main") ||
      d.querySelector('[role="main"]') ||
      d.querySelector("article") ||
      d.body;
    const textBlob = main ? main.innerText.trim() : "";
    lines.push("## Plain text (from main/article/body)");
    lines.push("");
    lines.push(textBlob.replace(/\n{3,}/g, "\n\n") || "_empty_");
    lines.push("");

    lines.push("## Headings outline");
    lines.push("");
    d.querySelectorAll("h1, h2, h3, h4").forEach((h) => {
      const t = h.innerText.replace(/\s+/g, " ").trim();
      if (!t) return;
      const level = Number(h.tagName.slice(1)) || 2;
      const prefix = "#".repeat(Math.min(6, Math.max(1, level)));
      lines.push(`${prefix} ${t}`);
    });
    lines.push("");

    lines.push("## Links");
    lines.push("");
    const seen = new Set();
    let n = 0;
    d.querySelectorAll("a[href]").forEach((a) => {
      if (n >= 400) return;
      const href = a.href;
      if (!href || seen.has(href)) return;
      seen.add(href);
      const label = esc(a.innerText) || href;
      lines.push(`- [${label}](${href})`);
      n += 1;
    });
    lines.push("");

    lines.push("## Tables (first 8)");
    lines.push("");
    const tables = d.querySelectorAll("table");
    const maxTables = Math.min(8, tables.length);
    for (let ti = 0; ti < maxTables; ti += 1) {
      const table = tables[ti];
      lines.push(`### Table ${ti + 1}`);
      lines.push("");
      const rows = table.querySelectorAll("tr");
      const maxRows = Math.min(80, rows.length);
      for (let ri = 0; ri < maxRows; ri += 1) {
        const cells = rows[ri].querySelectorAll("th, td");
        const parts = Array.from(cells).map((c) => esc(c.innerText) || " ");
        if (!parts.length) continue;
        lines.push(`| ${parts.join(" | ")} |`);
        if (ri === 0) lines.push(`| ${parts.map(() => "---").join(" | ")} |`);
      }
      lines.push("");
    }

    lines.push("## Meta tags");
    lines.push("");
    d.querySelectorAll("meta[name][content], meta[property][content]").forEach((m) => {
      const name = m.getAttribute("name") || m.getAttribute("property");
      const content = m.getAttribute("content");
      if (name && content) lines.push(`- **${name}:** ${content}`);
    });
    lines.push("");

    if (includeHtml) {
      lines.push("## HTML snapshot (truncated)");
      lines.push("");
      lines.push("```html");
      const html = d.documentElement ? d.documentElement.outerHTML : "";
      lines.push(html.slice(0, 200_000));
      if (html.length > 200_000) lines.push("\n<!-- truncated -->");
      lines.push("```");
      lines.push("");
    }

    const markdown = lines.join("\n");
    log("sending scrape result", { mdLen: markdown.length, title: d.title });
    await chrome.runtime.sendMessage({
      type: "SCRAPE_RESULT_RAW",
      payload: {
        markdown,
        title: d.title || "page",
        pageUrl: d.location.href,
      },
    });
  } catch (e) {
    console.error("[dom-scrape-md:page] scraper failed", e);
    try {
      await chrome.runtime.sendMessage({
        type: "SCRAPE_RESULT_RAW",
        payload: {
          markdown: `# Scraper error\n\nURL: ${location.href}\n\n\`\`\`\n${String(e)}\n\`\`\`\n`,
          title: "dom-scrape-error",
          pageUrl: location.href,
        },
      });
    } catch (e2) {
      console.error("[dom-scrape-md:page] could not report error to extension", e2);
    }
  }
})();
