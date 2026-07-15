# Forkable Macros

Chrome extension that shows estimated macros (calories, protein, carbs, fat) for
Forkable menu items in a side panel. Estimates come from Gemini
(`gemini-2.5-flash-lite`).

## Install (load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

After code changes, hit the reload icon on the extension card, then **refresh
the Forkable tab** (otherwise the old content script shows "extension was
updated — refresh").

## How it works (batch-first, rate-limit friendly)

- **Opening the menu browser** scrapes every meal card and batch-estimates
  them — one API call per ~25 items, skipping anything already cached.
  Estimates are kept forever in the shared cache (they also feed the tier
  lists below).
- **Clicking an item** is served instantly from that cache: zero API calls.
  The cached number is for the standard configuration.
- **"Refine for selected options"** button does one on-demand, search-grounded
  estimate for your exact protein/cheese/side choices (also cached per
  combination). This is the only thing that spends quota per click.
- The free-text box estimates anything (Enter to search, grounded).
- The panel shows the source of the numbers, any web pages the search-grounded
  answer drew on, and a Google "nutrition" search shortcut.

## Team mode (sharing with coworkers)

Out of the box the extension runs in direct mode (personal Gemini keys in
`background.js`) with a per-device cache — fine for one person, wrong for a
team. For team use, deploy the shared cache backend in `server/` (Cloudflare
Worker + KV, free tier; see `server/DEPLOY.md`), then copy
`config.local.example.js` to `config.local.js` and fill in the Worker URL and
team token. `config.local.js` is gitignored — this repo is public and the
token must never be committed. Every dish then gets estimated once globally —
the first person to browse the menu populates the cache for everyone.

## Tier lists

`docs/` is a static site (GitHub Pages) with two tabs — **Restaurants** and
**Food Items** — built from everything the team has ever seen on Forkable,
laid out as a classic tier list: **Willis ✨, S, A, B, C, D, F, 💩**.

Nothing is dragged: click an entry and a popup shows how many votes each tier
has; pick one to cast yours (tap it again to remove it, change it anytime).
Placement is automatic: the average of all vote scores (💩 = 0 … Willis = 7)
rounded to the nearest tier, and everything starts in C. So 1×S + 1×💩 stays
in C, while 2×S + 1×💩 climbs to B.

The page needs the team token once (stored in the browser); votes are stored
per anonymous browser id in the same Worker KV. Your own votes show instantly;
other people's take a minute or two to appear (the vote data is served from a
60-second snapshot to stay inside KV free-tier limits).

## Notes

- Secrets live outside the repo: Gemini keys as Worker secrets, the team
  token in gitignored `config.local.js` (extension) or localStorage (site).
- Numbers are estimates — the confidence badge and notes line tell you how
  solid each one is. Small local restaurants rarely publish macros, so
  "estimated from ingredients" is common and expected.
- If you still hit a rate-limit error, wait a minute; cached items always
  load instantly.
