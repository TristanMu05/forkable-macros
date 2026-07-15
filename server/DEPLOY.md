# Deploying the shared macro cache (Cloudflare Worker)

One-time setup, ~10 minutes. Free tier covers 400 users easily
(100k requests/day; the whole team's weekly menu costs ~5 Gemini calls total).

## 1. Create the Worker

```powershell
cd server
npm install -g wrangler        # if you don't have it
npx wrangler login             # opens browser, log into/create a free Cloudflare account
npx wrangler kv namespace create MACROS
```

Copy the `id` it prints into `wrangler.toml` (replace `PASTE_KV_NAMESPACE_ID_HERE`).

## 2. Set secrets

```powershell
npx wrangler secret put GEMINI_API_KEYS
# paste all keys comma-separated, e.g.:  AQ.key1,AQ.key2,AQ.key3

npx wrangler secret put TEAM_TOKEN
# invent a long random string, e.g. from:  [guid]::NewGuid().ToString("N")

npx wrangler secret put VIP_TOKEN
# optional: a second accepted code — tier-list votes cast with it weigh 3x
```

## 3. Deploy

```powershell
npx wrangler deploy
```

It prints your Worker URL, e.g. `https://forkable-macros.yourname.workers.dev`.

## 4. Point the extension at it

Copy `config.local.example.js` (repo root) to `config.local.js` and fill in:

```js
self.FKM_CONFIG = {
  workerUrl: "https://forkable-macros.yourname.workers.dev",
  teamToken: "<the same token you set above>",
};
```

`config.local.js` is gitignored so the token never lands in the public repo;
include it in the folder/zip you actually hand to coworkers. Make sure
`GEMINI_API_KEYS` in `background.js` stays empty, then reload the extension.

## 5. Distribute to coworkers

Easiest at 400 people: zip the extension folder (without `server/`) and
publish it **unlisted on the Chrome Web Store** ($5 one-time developer fee) so
people install with one click and get updates automatically. Load-unpacked
works but doesn't auto-update.

## Notes

- The TEAM_TOKEN keeps random internet traffic out. Coworkers can technically
  extract it from the extension — that's fine, it only lets them use your
  cache, which is the point.
- Watch quota: refines are per dish+option combo (cached globally), so Monday
  spikes could exhaust the free pools. If that happens, enable billing on one
  Gemini key — this usage is well under $1/month — or add more keys to the
  GEMINI_API_KEYS secret.
- KV writes are limited to 1,000/day on the free tier; a weekly menu writes
  ~250 once. Fine. Tier-list votes are one write each — a first-day voting
  frenzy above ~700 votes could hit the cap; it resets daily.
- KV **list** operations are only ~1k/day free, which is why `/tier/data`
  serves a snapshot rebuilt at most once per minute instead of listing keys
  per pageview.

## Tier-list page (GitHub Pages)

The site in `docs/` is static and talks straight to the Worker (`/tier/data`,
`/tier/vote`) — deploy is just: push this repo to GitHub, then Settings →
Pages → Deploy from branch → `main` / `docs`. Visitors enter the TEAM_TOKEN
once (stored in localStorage). After deploying a Worker with old cache
entries, run the one-time TTL strip so existing items persist forever:

```powershell
curl.exe -X POST "https://<your-worker>/admin/persist-cache?token=<TEAM_TOKEN>"
# repeat while it reports remaining > 0
```
