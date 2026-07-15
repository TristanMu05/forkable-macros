// Forkable Macros — shared cache backend (Cloudflare Worker + KV).
//
// All coworkers' extensions talk to this Worker instead of Gemini directly:
//  - the Gemini API keys live here as secrets, never in the extension
//  - every dish is estimated ONCE globally, then served from KV to everyone
//
// Endpoints (all require `x-team-token` header or `?token=`):
//   POST /batch  {items:[{restaurant,name,description}], menuDate?}  (≤60)
//       → {ok, results:[{...}|null per item]}   estimates uncached items
//   POST /lookup {item:{restaurant,name,description,options?}, refine?:bool}
//       → {ok, result:{...}, approx?:bool}
//   POST /bulk   {items:[...], menuDate?} (≤300) → cached results only
//   GET  /tier/data → {ok, voteWeight, items, restaurants, votes,
//       availability, weekStart, ts}   (60s KV snapshot; ?fresh=1 rebuilds)
//   POST /tier/vote {kind:"item"|"restaurant", id, tier|null, voter}
//
// menuDate (YYYY-MM-DD, the delivery day being browsed) feeds per-day
// restaurant availability. Auth also accepts the optional VIP_TOKEN secret,
// whose votes carry 3x weight.
//   POST /admin/persist-cache  → strips the legacy 7d TTL off old entries
//   GET  /cache?token=…        → HTML cache viewer (&format=json for raw)
//
// Deploy: see DEPLOY.md. Secrets: GEMINI_API_KEYS (comma-separated),
// TEAM_TOKEN. KV binding: MACROS.

// Model tiers, best-first. The weekly batch sweep is only ~5 calls, so it
// gets the strongest flash model for better estimates; singles/refines are
// more frequent and run on the cheaper 2.5 family. Unavailable or overloaded
// models fall through to the next tier automatically via pool parking.
const BATCH_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];
const LOOKUP_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];
// Macro entries persist forever (no KV TTL): the tier lists are built from
// every item the team has ever seen, so nothing may expire out from under
// them. Stale-recipe drift is acceptable for this use.
const POOL_DEAD_MS = 30 * 24 * 60 * 60 * 1000;

// Tier votes. Score = index: 💩=0, F=1, D=2, C=3, B=4, A=5, S=6, Willis=7.
// An entity's placement is the plain average of its vote scores rounded to
// the nearest tier; no votes = C. (1×S + 1×💩 → 3 → C; 2×S + 1×💩 → 4 → B.)
const TIERS = ["P", "F", "D", "C", "B", "A", "S", "W"];

const JSON_SHAPE =
  '{"calories": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "confidence": "low|medium|high", "source": "<short phrase: where the numbers came from>", "notes": "<one short sentence about key assumptions>"}';

// ---------------------------------------------------------------------------
// Cache keys (mirror the extension's scheme)
// ---------------------------------------------------------------------------
function cacheKey(restaurant, name, options) {
  return (
    "macro:" +
    JSON.stringify([
      restaurant || "",
      name,
      options && options.length ? options : null,
    ])
      .toLowerCase()
      .replace(/\s+/g, " ")
  );
}

// ---------------------------------------------------------------------------
// Quota pools (key × model), state in KV
// ---------------------------------------------------------------------------
// Thinking models are slow (and time out at high demand) — trying them on
// every key serially can stall a batch chunk for many minutes. Give slow
// models ONE shot (first key), then fall through to the fast tier quickly.
const SLOW_MODELS = new Set(["gemini-3.5-flash", "gemini-3-flash-preview"]);

function buildPools(env, models) {
  const keys = (env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  const pools = [];
  for (const model of models) {
    const usable = SLOW_MODELS.has(model) ? keys.slice(0, 1) : keys;
    for (const key of usable) pools.push({ key, model });
  }
  return pools;
}

const poolId = (p) => `${p.model}|${p.key.slice(-10)}`;

function msUntilQuotaReset() {
  const laNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  const laMidnight = new Date(laNow);
  laMidnight.setHours(24, 0, 0, 0);
  return laMidnight.getTime() - laNow.getTime();
}

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

async function callGemini(env, promptText, useSearch, models = LOOKUP_MODELS) {
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.2 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  const state = (await env.MACROS.get("poolState", "json")) || {};
  let stateChanged = false;
  const park = (pool, ms) => {
    state[poolId(pool)] = { deadUntil: Date.now() + ms };
    stateChanged = true;
  };

  try {
    for (const pool of buildPools(env, models)) {
      const parked = state[poolId(pool)];
      if (parked && parked.deadUntil > Date.now()) continue;
      let resp;
      try {
        resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${pool.model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": pool.key,
            },
            body: JSON.stringify(body),
            // Thinking models can take minutes on big batches; don't let a
            // hung call stall the whole chunk — fail over to the next pool.
            signal: AbortSignal.timeout(75_000),
          }
        );
      } catch {
        park(pool, 2 * 60 * 1000);
        continue;
      }
      if (resp.status === 429) {
        park(pool, await parkDurationFor429(resp));
        continue;
      }
      if (resp.status === 404 || resp.status === 400) {
        park(pool, POOL_DEAD_MS);
        continue;
      }
      if (resp.status >= 500) {
        park(pool, 2 * 60 * 1000);
        continue;
      }
      if (!resp.ok) throw new Error(`Gemini error (HTTP ${resp.status})`);
      const data = await resp.json();
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text || "").join("");
      if (!text) throw new Error("Gemini returned no answer.");
      const sources = (candidate?.groundingMetadata?.groundingChunks || [])
        .map((c) => c.web)
        .filter((w) => w?.uri)
        .map((w) => ({ title: w.title || "source", uri: w.uri }))
        .slice(0, 3);
      return { text, sources };
    }
    throw new Error("RATE_LIMIT");
  } finally {
    if (stateChanged) await env.MACROS.put("poolState", JSON.stringify(state));
  }
}

// ---------------------------------------------------------------------------
// Prompts & parsing (mirrors the extension)
// ---------------------------------------------------------------------------
function buildPrompt(item) {
  const lines = [
    "You are a nutrition lookup assistant. Find or estimate the macros for this restaurant menu item as configured.",
    "",
  ];
  if (item.restaurant) lines.push(`Restaurant: ${item.restaurant}`);
  lines.push(`Item: ${item.name}`);
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.options?.length) lines.push(`Selected options: ${item.options.join("; ")}`);
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
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Unparseable response: "${cleaned.slice(0, 140)}"`);
  return normalizeEntry(JSON.parse(match[0]));
}

function parseBatch(text, expectedCount) {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Batch response had no JSON array.");
  const arr = JSON.parse(match[0]);
  if (!Array.isArray(arr) || arr.length !== expectedCount) {
    throw new Error(`Batch returned ${arr.length} entries, expected ${expectedCount}.`);
  }
  return arr.map(normalizeEntry);
}

async function estimateSingle(env, item) {
  const grounded = await callGemini(env, buildPrompt(item), true);
  try {
    return { ...parseResult(grounded.text), sources: grounded.sources };
  } catch {
    const convertPrompt =
      `Convert this nutrition answer into a JSON object. Respond with ONLY the JSON, no markdown fences, exactly this shape: ${JSON_SHAPE}` +
      "\n\nAnswer to convert:\n" +
      grounded.text;
    const converted = await callGemini(env, convertPrompt, false);
    return { ...parseResult(converted.text), sources: grounded.sources };
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-team-token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });

async function handleBatch(env, body) {
  const items = (body.items || []).slice(0, 60);
  if (!items.length) return json({ ok: false, error: "No items." }, 400);
  await recordAvailability(env, body.menuDate, items);

  const results = await Promise.all(
    items.map((it) => env.MACROS.get(cacheKey(it.restaurant, it.name, null), "json"))
  );
  const missingIdx = results
    .map((r, i) => (r ? null : i))
    .filter((i) => i !== null);

  if (missingIdx.length) {
    const missing = missingIdx.map((i) => items[i]);
    try {
      const { text } = await callGemini(env, buildBatchPrompt(missing), false, BATCH_MODELS);
      const estimates = parseBatch(text, missing.length);
      await Promise.all(
        missingIdx.map((itemIdx, j) => {
          const r = { ...estimates[j], sources: [] };
          results[itemIdx] = r;
          const it = items[itemIdx];
          return env.MACROS.put(
            cacheKey(it.restaurant, it.name, null),
            JSON.stringify(r)
          );
        })
      );
    } catch (err) {
      if (err.message === "RATE_LIMIT") {
        return json({ ok: true, results, stalled: true });
      }
      return json({ ok: false, error: err.message }, 502);
    }
  }
  return json({ ok: true, results });
}

// Read-only bulk cache fetch: returns the cached result (or null) for every
// item in one round trip. No estimation — clients send misses to /batch.
async function handleBulk(env, body) {
  const items = (body.items || []).slice(0, 300);
  if (!items.length) return json({ ok: false, error: "No items." }, 400);
  await recordAvailability(env, body.menuDate, items);
  const results = await Promise.all(
    items.map((it) =>
      it?.name
        ? env.MACROS.get(cacheKey(it.restaurant, it.name, null), "json")
        : null
    )
  );
  return json({ ok: true, results });
}

async function handleLookup(env, body) {
  const item = body.item;
  if (!item?.name) return json({ ok: false, error: "No item." }, 400);
  const refine = !!body.refine;
  const exactKey = cacheKey(item.restaurant, item.name, item.options);
  const baseKey = cacheKey(item.restaurant, item.name, null);

  const exact = await env.MACROS.get(exactKey, "json");
  if (exact) return json({ ok: true, result: exact });

  if (!refine) {
    const base = await env.MACROS.get(baseKey, "json");
    if (base) {
      return json({ ok: true, result: { ...base, approx: !!item.options?.length } });
    }
  }

  try {
    const result = await estimateSingle(env, item);
    await env.MACROS.put(refine ? exactKey : baseKey, JSON.stringify(result));
    return json({ ok: true, result });
  } catch (err) {
    const msg =
      err.message === "RATE_LIMIT"
        ? "All free-tier quota pools are used up for now. Try again later."
        : err.message;
    return json({ ok: false, error: msg }, 502);
  }
}

// ---------------------------------------------------------------------------
// Restaurant availability by day, crowdsourced from menu browsing: the
// extension stamps every /bulk and /batch upload with the delivery date whose
// menu it scraped, and the restaurant names get unioned into one small KV
// entry per date (avail:YYYY-MM-DD). The tier page shows the current
// Saturday-to-Friday week — so the day filter "resets" every Saturday —
// and older entries just stop being read.
// ---------------------------------------------------------------------------
const normName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

const laToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekDates() {
  // Saturday-anchored week containing today (LA time): Sat..Fri
  const today = laToday();
  const sinceSat = (new Date(today + "T00:00:00Z").getUTCDay() + 1) % 7;
  const start = addDays(today, -sinceSat);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function validMenuDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return null;
  const t = new Date(s + "T00:00:00Z").getTime();
  // Sanity window: a mis-scraped date would pollute a KV key forever.
  return !Number.isNaN(t) && Math.abs(t - Date.now()) < 21 * 86400_000 ? s : null;
}

async function recordAvailability(env, menuDate, items) {
  const date = validMenuDate(menuDate);
  if (!date) return;
  const names = new Set(items.map((it) => normName(it?.restaurant)).filter(Boolean));
  if (!names.size) return;
  const key = "avail:" + date;
  const existing = (await env.MACROS.get(key, "json")) || [];
  const merged = new Set([...existing, ...names]);
  if (merged.size === existing.length) return; // nothing new — save the write
  await env.MACROS.put(key, JSON.stringify([...merged].sort()));
}

// ---------------------------------------------------------------------------
// Tier lists: permanent per-voter votes on items and restaurants.
//
// One KV key per (entity, voter): vote:<i|r>:<b64url(id)>:<voterId>, with the
// tier both as the value and as list metadata {t} — so aggregation needs only
// key LISTS, never per-key gets. Re-voting overwrites the same key (no races
// between voters), removing a vote deletes it.
//
// GET /tier/data serves a KV snapshot rebuilt at most once per 60s: KV allows
// only ~1k list ops/day free, so per-pageview listing would not survive the
// team. Freshly cast votes therefore take up to ~2 min to show up for OTHERS;
// the page overlays the caller's own votes locally so their view is instant.
// ---------------------------------------------------------------------------
const SNAPSHOT_KEY = "tierSnapshot";
const SNAPSHOT_FRESH_MS = 60_000;

const b64u = (s) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64u = (s) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0)
    )
  );

async function listAll(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.MACROS.list({ prefix, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function buildTierData(env) {
  const items = [];
  const restaurants = new Set();
  for (const k of await listAll(env, "macro:")) {
    try {
      const [restaurant, name, options] = JSON.parse(k.name.slice("macro:".length));
      if (options || !name) continue; // option-refine combos aren't tier entries
      items.push({ id: JSON.stringify([restaurant || "", name]), restaurant: restaurant || "", name });
      if (restaurant) restaurants.add(restaurant);
    } catch {}
  }
  items.sort(
    (a, b) => a.restaurant.localeCompare(b.restaurant) || a.name.localeCompare(b.name)
  );

  const votes = [];
  for (const k of await listAll(env, "vote:")) {
    const m = k.name.match(/^vote:(i|r):([A-Za-z0-9_-]+):([A-Za-z0-9-]+)$/);
    const tier = k.metadata?.t;
    if (!m || !TIERS.includes(tier)) continue;
    try {
      votes.push({
        kind: m[1], id: unb64u(m[2]), voter: m[3], tier,
        w: Number(k.metadata?.w) || 1,
      });
    } catch {}
  }

  const week = weekDates();
  const availability = {};
  await Promise.all(
    week.map(async (date) => {
      const names = await env.MACROS.get("avail:" + date, "json");
      if (names?.length) availability[date] = names;
    })
  );

  return {
    items, restaurants: [...restaurants].sort(), votes,
    availability, weekStart: week[0], ts: Date.now(),
  };
}

async function handleTierData(env, url, voteWeight) {
  if (url.searchParams.get("fresh") !== "1") {
    const snap = await env.MACROS.get(SNAPSHOT_KEY, "json");
    if (snap && Date.now() - snap.ts < SNAPSHOT_FRESH_MS) {
      return json({ ok: true, voteWeight, ...snap });
    }
  }
  const data = await buildTierData(env);
  await env.MACROS.put(SNAPSHOT_KEY, JSON.stringify(data));
  return json({ ok: true, voteWeight, ...data });
}

async function handleTierVote(env, body, weight) {
  const kind =
    body.kind === "restaurant" ? "r" : body.kind === "item" ? "i" : null;
  const id = typeof body.id === "string" ? body.id.slice(0, 300) : "";
  const voter =
    typeof body.voter === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.voter)
      ? body.voter
      : "";
  const tier = body.tier == null ? null : String(body.tier);
  if (!kind || !id || !voter) return json({ ok: false, error: "Bad vote." }, 400);
  if (tier !== null && !TIERS.includes(tier)) {
    return json({ ok: false, error: "Unknown tier." }, 400);
  }
  const key = `vote:${kind}:${b64u(id)}:${voter}`;
  if (tier === null) await env.MACROS.delete(key);
  else await env.MACROS.put(key, tier, { metadata: { t: tier, w: weight } });
  // The tierSnapshot is deliberately NOT invalidated here — see the note above.
  return json({ ok: true });
}

// One-time migration: entries written before the persist-forever change still
// carry their 7d expiration; re-putting them strips it. Capped per call to
// stay under the ~1k KV ops/invocation limit — run again if remaining > 0.
async function handlePersistCache(env) {
  const stale = (await listAll(env, "macro:")).filter((k) => k.expiration != null);
  const batch = stale.slice(0, 400);
  await Promise.all(
    batch.map(async (k) => {
      const v = await env.MACROS.get(k.name);
      if (v != null) await env.MACROS.put(k.name, v);
    })
  );
  return json({ ok: true, rewritten: batch.length, remaining: stale.length - batch.length });
}

// ---------------------------------------------------------------------------
// Cache viewer: GET /cache?token=... renders everything cached as a table
// (add &format=json for raw data). Also shows quota-pool health.
// ---------------------------------------------------------------------------
const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function handleCacheView(env, url) {
  const keys = await listAll(env, "macro:");

  const entries = await Promise.all(
    keys.map(async (k) => {
      const v = (await env.MACROS.get(k.name, "json")) || {};
      let restaurant = "",
        name = k.name,
        options = null;
      try {
        [restaurant, name, options] = JSON.parse(k.name.slice("macro:".length));
      } catch {}
      return { restaurant: restaurant || "", name, options, ...v };
    })
  );
  entries.sort(
    (a, b) =>
      a.restaurant.localeCompare(b.restaurant) || a.name.localeCompare(b.name)
  );

  if (url.searchParams.get("format") === "json") {
    return json({ ok: true, count: entries.length, entries });
  }

  const poolState = (await env.MACROS.get("poolState", "json")) || {};
  const now = Date.now();
  const parked = Object.entries(poolState)
    .filter(([, v]) => v.deadUntil > now)
    .map(
      ([id, v]) =>
        `${escHtml(id)} (back in ${Math.ceil((v.deadUntil - now) / 60000)} min)`
    );

  const rows = entries
    .map(
      (e) => `<tr>
        <td>${escHtml(e.restaurant) || "<i>&middot;</i>"}</td>
        <td>${escHtml(e.name)}</td>
        <td>${e.options ? escHtml(e.options.join(", ")) : "<i>base</i>"}</td>
        <td class="n">${e.calories ?? ""}</td>
        <td class="n">${e.protein ?? ""}</td>
        <td class="n">${e.carbs ?? ""}</td>
        <td class="n">${e.fat ?? ""}</td>
        <td>${escHtml(e.confidence)}</td>
        <td title="${escHtml(e.notes)}">${escHtml(e.source)}</td>
      </tr>`
    )
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Forkable Macros cache</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#1e1733;color:#f0edf7;margin:24px}
h1{font-size:18px} .meta{color:#9b8fc4;font-size:13px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #372b5a}
th{color:#b79bff;position:sticky;top:0;background:#1e1733}
td.n{text-align:right;font-variant-numeric:tabular-nums}
tr:hover{background:#261d44} i{color:#9b8fc4}
</style></head><body>
<h1>Forkable Macros shared cache</h1>
<div class="meta">${entries.length} entries &middot; ${
    parked.length ? "parked pools: " + parked.join(", ") : "all quota pools healthy"
  }</div>
<table><thead><tr><th>Restaurant</th><th>Item</th><th>Options</th><th>kcal</th><th>P</th><th>C</th><th>F</th><th>Conf</th><th>Source</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });
    const url = new URL(request.url);
    const token =
      request.headers.get("x-team-token") || url.searchParams.get("token");
    // VIP_TOKEN (optional secret) is a second valid code whose votes weigh 3x.
    const isVip = !!env.VIP_TOKEN && token === env.VIP_TOKEN;
    if (token !== env.TEAM_TOKEN && !isVip) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }
    const voteWeight = isVip ? 3 : 1;
    if (request.method === "GET" && url.pathname === "/cache") {
      return handleCacheView(env, url);
    }
    if (request.method === "GET" && url.pathname === "/tier/data") {
      return handleTierData(env, url, voteWeight);
    }
    if (request.method !== "POST") return json({ ok: false, error: "POST only." }, 405);
    // Tolerate empty bodies (e.g. bare POST /admin/persist-cache) — every
    // handler validates the fields it needs anyway.
    const body = await request.json().catch(() => ({}));
    if (url.pathname === "/batch") return handleBatch(env, body);
    if (url.pathname === "/bulk") return handleBulk(env, body);
    if (url.pathname === "/lookup") return handleLookup(env, body);
    if (url.pathname === "/tier/vote") return handleTierVote(env, body, voteWeight);
    if (url.pathname === "/admin/persist-cache") return handlePersistCache(env);
    return json({ ok: false, error: "Not found." }, 404);
  },
};
