// Content script: watches Forkable's meal modal. When the menu-browse list is
// open it scrapes every meal card and asks the background worker to batch-
// estimate them (one API call per ~40 items, cached 7 days), so opening an
// item's detail view is served instantly from cache. A "Refine" button does an
// on-demand, search-grounded estimate for the currently selected options.

// ---------------------------------------------------------------------------
// DOM extraction.
// Forkable's meal flows live in a BootstrapVue modal (#add-meal-popup):
//  - browse list: .card.meal-card per item (.live-input__label = restaurant,
//    h4 = dish name, p.card-text = description)
//  - item detail: .card.item-details (h4 = name, h4+p = description,
//    .back-button = restaurant, input:checked = chosen options)
// ---------------------------------------------------------------------------
const DETAIL_SELECTORS = [
  "#add-meal-popup .card.item-details",
  ".modal.show .card.item-details",
  '[role="dialog"] .card.item-details',
];

function findDetailContainer() {
  for (const sel of DETAIL_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null && !el.closest("#fkm-panel")) return el;
  }
  return null;
}

function findMealModal() {
  // NB: the modal is position:fixed, so offsetParent is always null —
  // getClientRects() is the reliable visibility check here.
  const el = document.querySelector("#add-meal-popup");
  return el && el.getClientRects().length > 0 ? el : null;
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Option labels render as e.g. "Carne Asada +$3.49" or "No Protein+" —
// strip the price tail.
function cleanOptionLabel(s) {
  return cleanText(s).replace(/\+?\s*\$?\d+(\.\d+)?\s*$/, "").replace(/\+$/, "").trim();
}

function extractItem(container) {
  const name = cleanText(container.querySelector("h4")?.textContent);
  if (!name || name.length < 3 || name.length > 120) return null;

  const description = cleanText(
    container.querySelector("h4 + p, p.mb-5")?.textContent
  ).slice(0, 400);

  const restaurant = cleanText(
    document.querySelector("#add-meal-popup .back-button")?.textContent
  );

  // Each option group is a <fieldset class="item-details__section"> whose
  // <legend> names it ("Choose Protein", "Add Side", ...). Track which labels
  // came from "Add ..." groups so the search link can phrase them as sides.
  const options = [];
  const sideOptions = [];
  for (const input of container.querySelectorAll("input:checked")) {
    const labelEl =
      input.closest("label") ||
      input.closest(".custom-control")?.querySelector("label") ||
      input.parentElement;
    const label = cleanOptionLabel(labelEl?.textContent);
    if (!label || label.length > 60) continue;
    options.push(label);
    const group = cleanText(
      input.closest("fieldset")?.querySelector("legend")?.textContent
    );
    if (/^add\b/i.test(group)) sideOptions.push(label);
  }

  return { name, description, restaurant, options, sideOptions };
}

function extractMenuItems(modal) {
  // Only favorites cards carry a venue label; cards in the per-restaurant
  // tabs don't. Their restaurant name lives in the tab strip — map each
  // menu container id to its tab label.
  const tabNames = {};
  for (const a of modal.querySelectorAll('a.nav-link[href^="#menu"]')) {
    const name = cleanText(a.textContent);
    if (name && !/favorites/i.test(name)) {
      tabNames[a.getAttribute("href").slice(1)] = name;
    }
  }
  const seen = new Set();
  const items = [];
  for (const card of modal.querySelectorAll(".card.meal-card")) {
    const name = cleanText(card.querySelector("h4")?.textContent);
    if (!name || name.length < 3 || name.length > 120) continue;
    const restaurant =
      cleanText(card.querySelector(".live-input__label")?.textContent) ||
      // NB: the card's own id starts with "menu-item-", which a bare
      // [id^="menu"] closest() would match — exclude it to reach the
      // surrounding menu container (#menuNNNN-NNNN) the tab names map to.
      tabNames[card.closest('div[id^="menu"]:not([id^="menu-item"])')?.id] ||
      "";
    const dedupeKey = `${restaurant}|${name}`.toLowerCase();
    if (seen.has(dedupeKey)) continue; // favorites duplicate tab items
    seen.add(dedupeKey);
    items.push({
      restaurant,
      name,
      description: cleanText(card.querySelector("p.card-text")?.textContent).slice(0, 300),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Side panel UI
// ---------------------------------------------------------------------------
let panel = null;
let autoOpened = false;
let currentItem = null;

function getPanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "fkm-panel";
  const version = chrome.runtime.getManifest().version;
  panel.innerHTML = `
    <div class="fkm-header">
      <span class="fkm-title"><img class="fkm-logo" src="${chrome.runtime.getURL(
        "logo.png"
      )}" alt="Apex" />Macros</span>
      <button class="fkm-close" title="Close">&times;</button>
    </div>
    <div class="fkm-search">
      <input type="text" class="fkm-query" placeholder="Estimate any food..." />
    </div>
    <div class="fkm-body"></div>
    <div class="fkm-footer">Estimated by Gemini &mdash; may not be official nutrition data &middot; v${version}</div>
  `;
  document.documentElement.appendChild(panel);

  panel.querySelector(".fkm-close").addEventListener("click", hidePanel);
  panel.querySelector(".fkm-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      runLookup({ name: e.target.value.trim() }, true);
    }
  });
  // The refine button is re-rendered with each result; delegate its clicks.
  panel.addEventListener("click", (e) => {
    if (e.target.closest(".fkm-refine") && currentItem) {
      runLookup(currentItem, true);
    }
  });
  return panel;
}

function showPanel() {
  getPanel().classList.add("fkm-open");
  document.documentElement.classList.add("fkm-page-shift");
}

function hidePanel() {
  panel?.classList.remove("fkm-open");
  document.documentElement.classList.remove("fkm-page-shift");
  autoOpened = false;
}

function hidePanelIfAutoOpened() {
  if (autoOpened && panel) hidePanel();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function safeUrl(u) {
  return /^https?:\/\//i.test(u) ? u.replace(/"/g, "%22") : "#";
}

function renderLoading(item) {
  getPanel().querySelector(".fkm-body").innerHTML =
    `<div class="fkm-status">Estimating &ldquo;${escapeHtml(item.name)}&rdquo;&hellip;</div>`;
}

function renderError(message) {
  getPanel().querySelector(".fkm-body").innerHTML =
    `<div class="fkm-status fkm-error">${escapeHtml(message)}</div>`;
}

function renderResult(item, r) {
  const approx = r.approx && item.options?.length;
  const configLine = approx
    ? `<div class="fkm-serving">standard configuration &mdash; selected options not factored in</div>`
    : item.options?.length
    ? `<div class="fkm-serving">with ${escapeHtml(item.options.join(", "))}</div>`
    : "";
  const refineBtn = approx
    ? `<button class="fkm-refine">Refine for selected options</button>`
    : "";
  const sourceLine = r.source
    ? `<div class="fkm-source">Source: ${escapeHtml(r.source)}</div>`
    : "";
  const links = (r.sources || []).map(
    (s) =>
      `<a href="${safeUrl(s.uri)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>`
  );
  // Phrase the search around the selected configuration: "with" for chosen
  // ingredients (protein/cheese/...), "and" for added sides. Skip "No X"
  // selections — they add nothing to a search.
  const sides = new Set(item.sideOptions || []);
  const chosen = (item.options || []).filter((o) => !/^no\b/i.test(o));
  const withList = chosen.filter((o) => !sides.has(o));
  const andList = chosen.filter((o) => sides.has(o));
  let query = `${item.restaurant ? item.restaurant + " " : ""}${item.name}`;
  if (withList.length) query += ` with ${withList.join(", ")}`;
  if (andList.length) query += ` and ${andList.join(" and ")}`;
  query += " nutrition";
  links.push(
    `<a href="https://www.google.com/search?q=${encodeURIComponent(query)}" target="_blank" rel="noopener">Search nutrition info</a>`
  );
  getPanel().querySelector(".fkm-body").innerHTML = `
    <div class="fkm-card fkm-best">
      <div class="fkm-food-name">${escapeHtml(item.name)}${
    item.restaurant ? ` <span class="fkm-brand">(${escapeHtml(item.restaurant)})</span>` : ""
  }</div>
      ${configLine}
      <div class="fkm-macros">
        <div class="fkm-macro"><span class="fkm-num">${r.calories}</span><span class="fkm-label">kcal</span></div>
        <div class="fkm-macro fkm-protein"><span class="fkm-num">${r.protein}g</span><span class="fkm-label">protein</span></div>
        <div class="fkm-macro fkm-carbs"><span class="fkm-num">${r.carbs}g</span><span class="fkm-label">carbs</span></div>
        <div class="fkm-macro fkm-fat"><span class="fkm-num">${r.fat}g</span><span class="fkm-label">fat</span></div>
      </div>
      <div class="fkm-confidence fkm-conf-${escapeHtml(r.confidence)}">${escapeHtml(r.confidence)} confidence</div>
      ${sourceLine}
      ${r.notes ? `<div class="fkm-notes">${escapeHtml(r.notes)}</div>` : ""}
      ${refineBtn}
      <div class="fkm-links">${links.join(" &middot; ")}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Lookup orchestration
// ---------------------------------------------------------------------------
let lastSignature = null;

function signatureOf(item) {
  return JSON.stringify([item.restaurant, item.name, item.options]);
}

// When the extension is reloaded at chrome://extensions, content scripts
// already injected into open tabs are orphaned and chrome.runtime calls throw
// "Extension context invalidated". Stop cleanly and tell the user to refresh.
function handleInvalidatedContext() {
  observer.disconnect();
  showPanel();
  renderError("The extension was updated — refresh this page to reconnect.");
}

function runLookup(item, refine) {
  if (!chrome.runtime?.id) {
    handleInvalidatedContext();
    return;
  }
  currentItem = item;
  const sig = signatureOf(item);
  lastSignature = sig;
  showPanel();
  getPanel().querySelector(".fkm-query").value = item.name;
  renderLoading(item);
  try {
    chrome.runtime.sendMessage({ type: "MACRO_LOOKUP", item, refine }, (resp) => {
      if (sig !== lastSignature) return; // a newer lookup superseded this one
      if (chrome.runtime.lastError) {
        renderError(chrome.runtime.lastError.message);
      } else if (!resp.ok) {
        renderError(resp.error);
      } else {
        renderResult(item, resp.result);
      }
    });
  } catch (e) {
    handleInvalidatedContext();
  }
}

// ---------------------------------------------------------------------------
// Batch progress indicator (small pill, bottom-left)
// ---------------------------------------------------------------------------
let progressEl = null;
let progressHideTimer = null;
let lastProgressAt = 0;
let batchActive = false;

function updateProgress({ done, total, finished, stalled, working }) {
  if (!progressEl) {
    progressEl = document.createElement("div");
    progressEl.id = "fkm-progress";
    progressEl.innerHTML = `
      <div class="fkm-progress-label"></div>
      <div class="fkm-progress-track"><div class="fkm-progress-fill"></div></div>
      <div class="fkm-progress-note"></div>`;
    document.documentElement.appendChild(progressEl);
  }
  lastProgressAt = Date.now();
  const isDone = finished || stalled || done >= total;
  batchActive = !isDone;
  const pct = total ? Math.round((done / total) * 100) : 0;
  // keep a sliver of bar visible so the shimmer reads as activity at 0%
  progressEl.querySelector(".fkm-progress-fill").style.width =
    Math.max(pct, isDone ? pct : 4) + "%";
  progressEl.classList.toggle("fkm-working", !isDone);
  const label = progressEl.querySelector(".fkm-progress-label");
  const note = progressEl.querySelector(".fkm-progress-note");
  if (stalled) {
    label.textContent = `Macro estimation paused at ${done}/${total} — daily quota used up`;
    note.textContent = "";
  } else if (isDone) {
    label.textContent = `Menu macros ready (${done}/${total})`;
    note.textContent = "";
  } else {
    label.textContent = `Estimating menu macros… ${done}/${total}`;
    note.textContent = working
      ? "Crunching the next batch — new menus take a few minutes"
      : "Runs in the background — feel free to keep browsing";
  }
  progressEl.classList.add("fkm-show");
  clearTimeout(progressHideTimer);
  if (isDone) {
    progressHideTimer = setTimeout(
      () => progressEl.classList.remove("fkm-show"),
      5000
    );
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "BATCH_PROGRESS") updateProgress(msg);
});

// Watchdog: if the batch goes silent (e.g. Chrome recycled the background
// worker mid-run), clear the dedupe signature and rescan so it restarts from
// wherever the shared cache left off.
setInterval(() => {
  if (batchActive && Date.now() - lastProgressAt > 180_000) {
    batchActive = false;
    lastBatchSig = null;
    scheduleScan(100);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Menu batching
// ---------------------------------------------------------------------------
let lastBatchSig = null;

// The browse modal belongs to one delivery day; find its date so the server
// can track which restaurants are available on which weekday. Header-ish
// elements are trusted with bare "July 15" / "7/15" / "today" forms; the
// modal body only with an unambiguous "Tuesday, July 15" form (dish
// descriptions can contain stray numbers and the word "today").
const FKM_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const FKM_MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
const FKM_WEEKDAY_MONTH_DAY = /\b(?:sun|mon|tues?|wednes|thurs?|fri|satur)day\s*,?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
const FKM_NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

function fkmYmd(d) {
  return (
    d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

// Menus are only browsable a couple of weeks out — reject anything else
// (it's likelier a mis-scrape than a real delivery day), and use the same
// window to pick the year, which Forkable's UI omits.
function fkmBuildDate(month, day, year) {
  const now = new Date();
  const candidates = year != null
    ? [new Date(year < 100 ? 2000 + year : year, month, day)]
    : [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(
        (y) => new Date(y, month, day)
      );
  for (const d of candidates) {
    if (d.getMonth() === month && Math.abs(d - now) < 21 * 86400_000) return fkmYmd(d);
  }
  return null;
}

function extractMenuDate(modal) {
  const headerText = cleanText(
    Array.from(
      modal.querySelectorAll(
        ".modal-header, .modal-title, header, h1, h2, h3, .back-button"
      )
    ).map((el) => el.textContent).join(" | ")
  );
  let m;
  if ((m = headerText.match(FKM_MONTH_DAY))) {
    return fkmBuildDate(FKM_MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  if ((m = headerText.match(FKM_NUMERIC_DATE))) {
    return fkmBuildDate(+m[1] - 1, +m[2], m[3] ? +m[3] : null);
  }
  if (/\btoday\b/i.test(headerText)) return fkmYmd(new Date());
  if (/\btomorrow\b/i.test(headerText)) return fkmYmd(new Date(Date.now() + 86400_000));
  const bodyText = cleanText(modal.textContent).slice(0, 1000);
  if ((m = bodyText.match(FKM_WEEKDAY_MONTH_DAY))) {
    return fkmBuildDate(FKM_MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  return null;
}

function maybeBatchMenu(modal) {
  const items = extractMenuItems(modal);
  if (items.length < 3) return;
  const menuDate = extractMenuDate(modal);
  // Same menu browsed for a DIFFERENT day must re-send (availability!),
  // so the date is part of the dedupe signature.
  const sig =
    (menuDate || "") + "|" +
    items.map((i) => `${i.restaurant}|${i.name}`).sort().join(";");
  if (sig === lastBatchSig) return;
  lastBatchSig = sig;
  if (!chrome.runtime?.id) return;
  console.debug("[fkm] menu batch:", items.length, "items, day:", menuDate || "not found");
  try {
    chrome.runtime.sendMessage({ type: "MACRO_BATCH", items, menuDate });
  } catch {}
}

// ---------------------------------------------------------------------------
// Watch the page for the modal opening/closing and options changing
// ---------------------------------------------------------------------------
let scanTimer = null;

function scan() {
  const container = findDetailContainer();
  if (container) {
    const item = extractItem(container);
    if (item && signatureOf(item) !== lastSignature) {
      autoOpened = true;
      runLookup(item, false);
    }
    return;
  }
  const modal = findMealModal();
  if (modal) maybeBatchMenu(modal);
  hidePanelIfAutoOpened();
  lastSignature = null;
}

function scheduleScan(delay) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}

const observer = new MutationObserver(() => scheduleScan(300));
observer.observe(document.body, { childList: true, subtree: true });

// Radio/checkbox toggles don't add or remove nodes — catch them via a
// delegated change listener. (Cache-served, so toggling costs no API calls;
// the Refine button is the only thing that does.)
document.addEventListener(
  "change",
  (e) => {
    if (e.target.closest && e.target.closest(".card.item-details")) {
      scheduleScan(400);
    }
  },
  true
);

scan();
