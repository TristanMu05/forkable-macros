// Background service worker: estimates macros via Gemini on behalf of the
// content script (host_permissions only apply here).
//
// Two paths:
//  - MACRO_BATCH: the whole visible menu, estimated in chunks of items per
//    call and cached, so item clicks are served instantly from cache.
//  - MACRO_LOOKUP: a single item. Served from cache when possible; calls the
//    API (with Google Search grounding) only on a cache miss or an explicit
//    refine request.

// The Gemini free tier allows only ~20 requests per DAY per key per model.
// To stretch that, calls rotate through a pool of key × model combinations —
// each pool has its own independent daily quota. Exhausted pools are parked
// and retried later.
//
// DIRECT MODE ONLY: put personal Gemini keys here. In team/server mode
// (WORKER_URL set below) leave this empty — keys live on the server.
const GEMINI_API_KEYS = [];
const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];
const POOLS = [];
for (const model of GEMINI_MODELS) {
  for (const key of GEMINI_API_KEYS) {
    POOLS.push({ key, model });
  }
}
const POOL_DEAD_MS = 30 * 24 * 60 * 60 * 1000; // park an unknown model ~forever

// Stable pool identity — survives reordering/adding keys (an index would not).
function poolId(pool) {
  return `${pool.model}|${pool.key.slice(-10)}`;
}

// Free-tier daily quotas reset at midnight Pacific time.
function msUntilQuotaReset() {
  const laNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  const laMidnight = new Date(laNow);
  laMidnight.setHours(24, 0, 0, 0);
  return laMidnight.getTime() - laNow.getTime();
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Small chunks: thinking models are slow and can truncate huge outputs, and
// smaller chunks keep the progress indicator moving.
const BATCH_CHUNK_SIZE = 25;
const BATCH_DELAY_MS = 5000; // between chunk calls, to stay under RPM limits

// === TEAM SERVER MODE (see server/DEPLOY.md) ===============================
// When workerUrl is set, all estimates go through the shared Cloudflare
// Worker — the whole team shares one cache, and the GEMINI_API_KEYS above are
// unused. The URL and token live in config.local.js (gitignored — this repo
// is public); copy config.local.example.js to create it. Missing file =
// direct mode with the personal keys above.
try {
  importScripts("config.local.js");
} catch {
  // no config.local.js — direct mode
}
const WORKER_URL = (self.FKM_CONFIG || {}).workerUrl || "";
const TEAM_TOKEN = (self.FKM_CONFIG || {}).teamToken || "";
// ===========================================================================

const serverMode = () => !!WORKER_URL;

async function serverPost(path, payload) {
  const resp = await fetch(WORKER_URL + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-team-token": TEAM_TOKEN,
    },
    body: JSON.stringify(payload),
    // Generous: a chunk may legitimately take ~3 min when slow thinking
    // models get first shot. The server's own 75s-per-call timeout bounds
    // the true worst case; this is just the never-hang-forever backstop.
    signal: AbortSignal.timeout(240_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || `Macro server error (HTTP ${resp.status})`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
function cacheKey(restaurant, name, options) {
  // options === null/empty → the item's base/default configuration
  return (
    "cache2:" +
    JSON.stringify([
      restaurant || "",
      name,
      options && options.length ? options : null,
    ])
      .toLowerCase()
      .replace(/\s+/g, " ")
  );
}

async function getCached(key) {
  const entry = (await chrome.storage.local.get(key))[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.result;
  return null;
}

async function setCached(key, result) {
  await chrome.storage.local.set({ [key]: { ts: Date.now(), result } });
}

// ---------------------------------------------------------------------------
// Prompts & parsing
// ---------------------------------------------------------------------------
const JSON_SHAPE =
  '{"calories": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "confidence": "low|medium|high", "source": "<short phrase: where the numbers came from>", "notes": "<one short sentence about key assumptions>"}';

// item: { name, restaurant?, description?, options? (string[]) }
function buildPrompt(item) {
  const lines = [
    "You are a nutrition lookup assistant. Find or estimate the macros for this restaurant menu item as configured.",
    "",
  ];
  if (item.restaurant) lines.push(`Restaurant: ${item.restaurant}`);
  lines.push(`Item: ${item.name}`);
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.options?.length) {
    lines.push(`Selected options: ${item.options.join("; ")}`);
  }
  lines.push(
    "",
    `First, search Google for published nutrition data for this exact restaurant and item (e.g. "${item.restaurant ? item.restaurant + " " : ""}${item.name} nutrition calories", or the restaurant's own menu/nutrition page).`,
    "Prefer, in this order: (1) nutrition data published by the restaurant itself, (2) crowd-sourced entries for this exact restaurant and dish (MyFitnessPal, Nutritionix, etc.), (3) published data for a near-identical dish at a comparable restaurant, (4) only as a last resort, estimate from the listed ingredients.",
    "Account for the whole item as served, including the selected options.",
    `Respond with ONLY a JSON object, no markdown fences, in exactly this shape: ${JSON_SHAPE}`
  );
  return lines.join("\n");
}

function buildBatchPrompt(items) {
  const lines = [
    "You are a nutrition estimator. Estimate the macros for each of the following restaurant menu items, as listed, without optional add-ons.",
    "",
  ];
  items.forEach((it, i) => {
    lines.push(
      `${i + 1}. Restaurant: ${it.restaurant || "unknown"} | Item: ${it.name}${
        it.description ? ` | Description: ${it.description}` : ""
      }`
    );
  });
  lines.push(
    "",
    `Respond with ONLY a JSON array, no markdown fences, containing exactly ${items.length} objects in the same order as the items above, each in exactly this shape: ${JSON_SHAPE}`
  );
  return lines.join("\n");
}

function normalizeEntry(data) {
  return {
    calories: Math.round(Number(data.calories)),
    protein: Math.round(Number(data.protein_g)),
    carbs: Math.round(Number(data.carbs_g)),
    fat: Math.round(Number(data.fat_g)),
    confidence: data.confidence || "low",
    source: data.source || "",
    notes: data.notes || "",
  };
}

function parseResult(text) {
  // The model is told not to use fences, but strip them if it does anyway.
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(
      `Gemini returned an unparseable response: "${cleaned.slice(0, 140)}"`
    );
  }
  return normalizeEntry(JSON.parse(match[0]));
}

function parseBatch(text, expectedCount) {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Batch response had no JSON array.");
  const arr = JSON.parse(match[0]);
  if (!Array.isArray(arr) || arr.length !== expectedCount) {
    throw new Error(
      `Batch returned ${arr.length} entries, expected ${expectedCount}.`
    );
  }
  return arr.map(normalizeEntry);
}

// ---------------------------------------------------------------------------
// Gemini calls
// ---------------------------------------------------------------------------
async function getPoolState() {
  return (await chrome.storage.local.get("poolState")).poolState || {};
}

async function parkPool(pool, ms) {
  const state = await getPoolState();
  state[poolId(pool)] = { deadUntil: Date.now() + ms };
  await chrome.storage.local.set({ poolState: state });
}

// Decide how long to park a pool based on WHICH limit the 429 reports:
// per-minute limits recover in seconds; per-day limits reset at midnight PT.
async function parkDurationFor429(resp) {
  try {
    const err = (await resp.json()).error;
    const details = err?.details || [];
    const quotaId =
      details.find((d) => (d["@type"] || "").includes("QuotaFailure"))
        ?.violations?.[0]?.quotaId || "";
    const retryDelay =
      details.find((d) => (d["@type"] || "").includes("RetryInfo"))
        ?.retryDelay || "";
    const retryMs = (parseFloat(retryDelay) || 0) * 1000;
    if (/perday/i.test(quotaId)) return msUntilQuotaReset();
    return Math.max(retryMs, 60 * 1000);
  } catch {
    return 5 * 60 * 1000;
  }
}

async function callGemini(promptText, useSearch) {
  if (!POOLS.length) {
    throw new Error(
      "No API keys configured. Set WORKER_URL for team mode, or add keys to GEMINI_API_KEYS."
    );
  }
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.2 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  const state = await getPoolState();
  for (const pool of POOLS) {
    const parked = state[poolId(pool)];
    if (parked && parked.deadUntil > Date.now()) continue;
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${pool.model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": pool.key,
        },
        body: JSON.stringify(body),
      }
    );
    if (resp.status === 429) {
      // Park for as long as this specific limit actually lasts, then move on.
      await parkPool(pool, await parkDurationFor429(resp));
      continue;
    }
    if (resp.status === 404 || resp.status === 400) {
      // Model not available on this key — park it long-term.
      await parkPool(pool, POOL_DEAD_MS);
      continue;
    }
    if (resp.status >= 500) {
      // Temporary overload ("high demand") — park briefly, try the next pool.
      await parkPool(pool, 2 * 60 * 1000);
      continue;
    }
    if (!resp.ok) {
      let detail = "";
      try {
        detail = (await resp.json()).error?.message || "";
      } catch {}
      throw new Error(`Gemini error (HTTP ${resp.status})${detail ? ": " + detail : ""}`);
    }
    const data = await resp.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text || "").join("");
    if (!text) throw new Error("Gemini returned no answer.");
    // Grounded responses list the web pages the answer drew on.
    const sources = (candidate?.groundingMetadata?.groundingChunks || [])
      .map((c) => c.web)
      .filter((w) => w?.uri)
      .map((w) => ({ title: w.title || "source", uri: w.uri }))
      .slice(0, 3);
    return { text, sources };
  }
  throw new Error("RATE_LIMIT");
}

function friendlyError(err) {
  if (err.message === "RATE_LIMIT") {
    return new Error(
      "All free-tier quota pools are used up for now (each key+model allows ~20 requests/day). Cached items still work; quotas reset daily."
    );
  }
  return err;
}

async function estimateMacros(item) {
  const grounded = await callGemini(buildPrompt(item), true);
  try {
    return { ...parseResult(grounded.text), sources: grounded.sources };
  } catch (err) {
    // Search-grounded responses often come back as prose instead of JSON.
    // Don't throw the research away — have an ungrounded call (which reliably
    // honors JSON-only instructions) convert the prose answer into our shape.
    const convertPrompt =
      `Convert this nutrition answer into a JSON object. Respond with ONLY the JSON, no markdown fences, exactly this shape: ${JSON_SHAPE}` +
      "\n\nAnswer to convert:\n" +
      grounded.text;
    const converted = await callGemini(convertPrompt, false);
    return { ...parseResult(converted.text), sources: grounded.sources };
  }
}

// ---------------------------------------------------------------------------
// Single lookup: cache-first, API only on miss or explicit refine
// ---------------------------------------------------------------------------
async function lookupMacros(item, refine) {
  const exactKey = cacheKey(item.restaurant, item.name, item.options);
  const baseKey = cacheKey(item.restaurant, item.name, null);

  const exact = await getCached(exactKey);
  if (exact) return exact;

  if (!refine) {
    const base = await getCached(baseKey);
    if (base) {
      // Cached for the standard configuration; flag if options now differ.
      return { ...base, approx: !!item.options?.length };
    }
  }

  try {
    if (serverMode()) {
      const data = await serverPost("/lookup", { item, refine });
      const { approx, ...result } = data.result;
      await setCached(refine ? exactKey : baseKey, result);
      return data.result;
    }
    const result = await estimateMacros(item);
    await setCached(refine ? exactKey : baseKey, result);
    return result;
  } catch (err) {
    throw friendlyError(err);
  }
}

// ---------------------------------------------------------------------------
// Batch: estimate the whole menu in chunks, cache base configurations
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let runningBatchSig = null;

function notifyProgress(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs
    .sendMessage(tabId, { type: "BATCH_PROGRESS", ...payload })
    .catch(() => {}); // tab may have navigated away — fine
}

// Once the server has confirmed a menu fully cached, skip revalidation for a
// while — saves ~150 KV reads per page load across the whole team.
const BATCH_VALIDATED_TTL_MS = 12 * 60 * 60 * 1000;

async function runBatch(items, sig, tabId, menuDate) {
  try {
    if (serverMode()) {
      const { batchValidated } = await chrome.storage.local.get("batchValidated");
      if (
        batchValidated &&
        batchValidated.sig === sig &&
        Date.now() - batchValidated.ts < BATCH_VALIDATED_TTL_MS
      ) {
        notifyProgress(tabId, { done: items.length, total: items.length, finished: true });
        return;
      }
    }
    // In server mode the shared KV is the source of truth: pull the whole
    // menu from it in ONE round trip, then only the actual misses go through
    // the (slow) estimation chunks. The local cache is just a read-through
    // copy and can be stale — it must never decide what to skip.
    let pending = items;
    if (serverMode()) {
      try {
        // menuDate rides along so the server can record which restaurants
        // are available on the day whose menu this is.
        const data = await serverPost("/bulk", { items, menuDate });
        const results = data.results || [];
        const missing = [];
        await Promise.all(
          items.map((it, idx) =>
            results[idx]
              ? setCached(cacheKey(it.restaurant, it.name, null), results[idx])
              : void missing.push(it)
          )
        );
        pending = missing;
      } catch {
        // bulk endpoint unreachable — fall back to chunk-by-chunk validation
      }
    } else {
      pending = [];
      for (const it of items) {
        if (!(await getCached(cacheKey(it.restaurant, it.name, null)))) {
          pending.push(it);
        }
      }
    }
    let done = items.length - pending.length;
    let complete = true; // false if any chunk fails or comes back partial
    notifyProgress(tabId, { done, total: items.length, finished: pending.length === 0 });
    if (serverMode() && pending.length === 0) {
      await chrome.storage.local.set({ batchValidated: { sig, ts: Date.now() } });
      return;
    }
    const chunks = [];
    for (let i = 0; i < pending.length; i += BATCH_CHUNK_SIZE) {
      chunks.push(pending.slice(i, i + BATCH_CHUNK_SIZE));
    }
    // Small random start delay: two browsers racing the same uncached menu
    // at least don't fire at the identical instant.
    if (serverMode() && chunks.length > 1) {
      await sleep(Math.random() * 5000);
    }

    // Estimates one chunk (with one retry); returns true if quota stalled.
    const runChunk = async (chunk) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          notifyProgress(tabId, { done, total: items.length, working: true });
          let results;
          let stalled = false;
          if (serverMode()) {
            const data = await serverPost("/batch", { items: chunk, menuDate });
            results = data.results || [];
            stalled = !!data.stalled;
          } else {
            const { text } = await callGemini(buildBatchPrompt(chunk), false);
            results = parseBatch(text, chunk.length).map((r) => ({
              ...r,
              sources: [],
            }));
          }
          await Promise.all(
            chunk.map((it, j) =>
              results[j]
                ? setCached(cacheKey(it.restaurant, it.name, null), results[j])
                : null
            )
          );
          const landed = results.filter(Boolean).length;
          if (landed < chunk.length) complete = false;
          done += landed;
          notifyProgress(tabId, { done, total: items.length, working: true });
          return stalled;
        } catch (err) {
          if (err.message === "RATE_LIMIT") return true;
          if (attempt === 0) {
            await sleep(2000);
          } else {
            complete = false;
            console.warn("Macro batch chunk failed:", err.message);
          }
        }
      }
      return false;
    };

    // All chunks fly in parallel (lightly staggered so the burst doesn't trip
    // per-minute limits at t=0) — total time ≈ the slowest single chunk
    // instead of the sum of all of them.
    const outcomes = await Promise.all(
      chunks.map(async (chunk, idx) => {
        await sleep(idx * 1500);
        return runChunk(chunk);
      })
    );

    if (outcomes.some(Boolean)) {
      console.warn("Macro batch stalled: quota pools exhausted.");
      notifyProgress(tabId, { done, total: items.length, stalled: true });
      return;
    }
    notifyProgress(tabId, { done, total: items.length, finished: true });
    if (serverMode() && complete) {
      await chrome.storage.local.set({
        batchValidated: { sig, ts: Date.now() },
      });
    }
  } finally {
    if (runningBatchSig === sig) runningBatchSig = null;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
// Start completely fresh on every install/update: the local cache is just a
// read-through copy of the shared server cache, and stale entries (old key
// schemes, server-side purges) cause wrong "already cached" decisions.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.clear();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "MACRO_LOOKUP") {
    lookupMacros(msg.item, !!msg.refine)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
  if (msg.type === "MACRO_BATCH") {
    // The date is part of the signature: the same menu browsed for a
    // different delivery day must still hit the server (availability).
    const sig =
      (msg.menuDate || "") + "|" +
      msg.items.map((i) => `${i.restaurant}|${i.name}`).sort().join(";");
    if (runningBatchSig !== sig) {
      runningBatchSig = sig;
      runBatch(msg.items, sig, _sender.tab?.id, msg.menuDate);
    }
    sendResponse({ ok: true });
  }
});
