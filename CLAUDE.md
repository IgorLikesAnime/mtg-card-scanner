# CLAUDE.md — project direction & context

Guidance for future Claude sessions on this repo. Read this first.

## 🧭 Handoff (2026-07-14)

**State:** the cloud-vision app is **deployed and live** as a **public tool (Mode B)** — anyone
can scan, no setup. **`main` is now the product** (the cloud-vision app was consolidated onto
`main`; the original perceptual-hash app is preserved in git history and on branch
`cloud-vision-gemini`). GitHub Pages serves `main`/root and the repo is **public**.

**Live:**
- App (GitHub Pages): <https://igorlikesanime.github.io/mtg-card-scanner/>
- Worker: `https://mtgcardscanner.amirmag1851.workers.dev`  (health: `/health` → `{ok:true}`)
- Model: `gemini-flash-lite-latest` (fast/cheap, less 503 overload; Google retired 2.0 and, for
  new keys, 2.5 — use `-latest` aliases to auto-roll forward). Set via the `GEMINI_MODEL` var.

**Verified:** Worker control flow (CORS/OPTIONS, token→401, bad origin→403, size guard) and the
**real Gemini path end-to-end** via live curl — the model resolves and only rejects non-image
bytes (400), i.e. a real photo works. Scryfall resolution against the live API.

**Mode B specifics (public tool):**
- `app.js` hardcodes `DEFAULT_WORKER_URL` + `DEFAULT_APP_TOKEN` so visitors scan with no config;
  Settings is now an optional "use your own Worker" override.
- The `APP_TOKEN` is **public by design** now (it ships in `app.js`) — it and the origin gate are
  only speed bumps. **The Gemini budget cap is the hard cost ceiling**; a per-IP rate limit
  (`RATE_LIMITER` binding, 15/60s) is the fairness layer. The Worker treats the binding as
  optional and falls back to the budget cap if it's absent.
- **The Gemini API key was never exposed** — it lives only as a Cloudflare Worker secret; repo +
  full git history scanned clean.

**Status (2026-07-14, later):** rate limiter **confirmed working** — `/identify` returns `429`
past the per-IP limit (`RATE_LIMITER` binding live, namespace `1001`, 15/60s); `/health` now also
returns `{"ok":true,"ratelimit":true}`. User is on Gemini **prepay** (credit balance = the hard
cost cap). Cost protection = prepay balance + per-IP rate limit.

## ✅ Done (2026-07-14) — UI refresh + Advanced section removed
Executed the deferred frontend plan (`~/.claude/plans/create-a-plan-to-crystalline-haven.md`).
Frontend only — `index.html` + `app.js`; worker/exports untouched.
- **Advanced/Settings removed:** deleted the `<details id="settings">` panel and all its JS wiring.
  `getWorkerUrl()`/`getToken()` now return plain constants `WORKER_URL`/`APP_TOKEN` (the
  `localStorage` override is **gone** — no per-user config path anymore). Grep for `settings`,
  `workerUrl`, `appToken`, `saveSettings`, `mtg_worker_url` etc. → zero refs.
- **UI redesign (revised after user feedback):** first pass used a neon-cyan "HUD" look; the user
  flagged it as reading AI-generated ("neon is a giveaway"). Final design is calm + near-monochrome:
  warm charcoal (`--bg #17181b`) with a **single muted brass accent** (`--accent #c2a063`, grounded
  in MTG gold borders) used only on primary actions (Capture/Add) + focus. No glows, gradients, or
  neon. Card guide is thin neutral-white corner brackets (plain camera-viewfinder look). **CSS is
  mobile-first** (base = phone: single column, full-width 52px buttons, 16px inputs to stop iOS
  zoom; desktop two-panel layered on at `min-width:861px`). Scanned-list table wrapped in
  `.twrap` (`overflow-x:auto`) so it can't blow out narrow phones.
- **Loading indicator:** a `body.scanning` class (added on capture, cleared in `identify()`'s
  `finally`) drives a reticle scan-line sweep **and** a status spinner; Capture is disabled
  mid-scan. Respects `prefers-reduced-motion`.
- **DOM contract preserved:** all IDs/classes the JS selects are intact; `.cardbox` stays nested
  in `.stage` with its `height:88%; aspect-ratio:63/88` geometry **unchanged** (crop math depends
  on it).
- **Shipped:** committed `index.html`+`app.js`+`CLAUDE.md` to `main` and pushed (2026-07-14);
  GitHub Pages rebuilds in ~1 min. UI reviewed locally by the user and approved.
- **Still worth a real device pass:** localhost can't exercise the identify path (Worker origin
  gate only trusts the Pages origin), so the **crop geometry + identify→add→export flow** should
  be confirmed once on the live URL / a phone camera. Nothing indicates a problem — just untested
  on-device.

### ▶️ Deploy recap (how it was set up)
1. **Gemini key** at <https://aistudio.google.com/apikey> (budget cap set).
2. **Worker** via the **Cloudflare dashboard** (no Node on this box): Create Worker → paste
   `worker/worker.js` → vars `ALLOWED_ORIGIN` (`https://igorlikesanime.github.io`) +
   `GEMINI_MODEL` (`gemini-flash-latest`) → secrets `GEMINI_API_KEY` + `APP_TOKEN` → optional
   `RATE_LIMITER` rate-limit binding. (Or `wrangler deploy` — see `worker/README.md`.)
3. **GitHub Pages** — repo Settings → Pages → deploy from branch `cloud-vision-gemini` / root.
   Repo must be **public** (free-tier Pages) — it contains no secrets.
4. **Mode B** — token + Worker URL hardcoded in `app.js`; no per-user setup.

**Gotchas / env:** repo lives on the Windows filesystem at `/path/to/mtg-card-scanner`
(WSL). GitHub remote is `IgorLikesAnime/mtg-card-scanner` (the user's account). No Node on Windows
(a standalone Node was used only in the scratchpad for testing). ~3.7 GB of gitignored local build
artifacts from the offline attempt (`mtg.db`, `web/thumbs/`, `data/`, `.venv`) still sit in the
folder — harmless, clear if asked. Avoid `git add -A` here: it tries to scan the ~54k thumbnail
files and hangs — stage explicit paths.

## What this is

A phone MTG card scanner: point a phone camera at a card, identify it, build a list, export
to ManaBox/Moxfield/Archidekt/Deckbox/Scryfall. Card data comes from
[Scryfall](https://scryfall.com).

## Current direction: cloud vision (this branch)

**Identify by reading the card with a vision model, not by hashing art.** A multimodal model
(Google Gemini Flash) reads the **name** and the **bottom-left collector number + set code +
language**, which pins the exact printing. Scryfall resolves that to the canonical card.

Architecture (all client-side except the key proxy):

```
Phone browser (GitHub Pages, real HTTPS)   ->  Cloudflare Worker (holds Gemini key)  ->  Gemini
              |                                                                              |
              +-- resolve exact printing directly from api.scryfall.com  <------------------+
```

- **GitHub Pages** hosts the static app — free real HTTPS, so the phone camera works with no
  self-signed cert / QR / LAN hassle.
- **Cloudflare Worker** (`worker/`) is a thin Gemini proxy. It exists so the Gemini API key
  never reaches the browser and to avoid the browser→Gemini CORS problem. It gates requests by
  `Origin` + an `x-app-token` (abuse protection on the public URL).
- **Scryfall** calls are made directly from the browser (CORS-friendly, no key).

### Secrets — where they live
- `GEMINI_API_KEY`, `APP_TOKEN`: **Cloudflare Worker secrets only** (`wrangler secret put …`).
  Never in git.
- Worker URL + app token are entered in the app's **Settings** and kept in `localStorage`.
- The repo contains **no keys**.

### Key files
- `index.html`, `app.js` — the static phone app (camera → Worker → Scryfall → list → export).
- `worker/worker.js`, `worker/wrangler.toml`, `worker/README.md` — the Gemini proxy + deploy docs.
- Export/list code in `app.js` is carried over verbatim across every version — keep it stable.

### Gemini / Scryfall specifics
- Worker calls `v1beta/models/${GEMINI_MODEL}:generateContent` with the image as `inline_data`
  and a strict `responseSchema` → `{name, set_code?, collector_number?, language?, foil?,
  confidence?}`. Default model `gemini-flash-latest` (override via the `GEMINI_MODEL` var).
- Resolution: prefer `GET /cards/{set}/{collector_number}` (+ `/{lang}`); fall back to
  `GET /cards/named?fuzzy=`; browse printings via a card's `prints_search_uri`.
- Cost: a downscaled (≤1024px) card photo ≈1,300 tokens ≈ ~$0.0002/scan.

### Deploy flow
1. `cd worker && wrangler deploy` then `wrangler secret put GEMINI_API_KEY` / `APP_TOKEN`;
   set `ALLOWED_ORIGIN` in `wrangler.toml` to your Pages origin.
2. Enable GitHub Pages for this branch; open the `github.io` URL on the phone; fill Settings.

## Other branches (don't disturb without reason)
- `main` — original static app: set-locked perceptual-hash art matching (client-side, Scryfall).
- `rebuild-selfhosted` — a self-hosted, fully-offline attempt: a Python server (`run.py`) serves
  the app over self-signed HTTPS with a QR, backed by a prebuilt local SQLite DB
  (`setup.py` → `mtg.db`, ~54k artwork fingerprints + ~541k printings + bundled thumbnails).
  Accurate-ish but heavy and the in-hand accuracy was the reason we moved to cloud vision. The
  built DB/thumbnails are local + gitignored.

## Notes / gotchas
- Camera needs a secure context (HTTPS) — GitHub Pages provides it; `file://` won't get the camera.
- The vision route needs internet at scan time (Gemini + Scryfall). Fully-offline lives on
  `rebuild-selfhosted`.
- Older cards (pre-2014) lack the collector-number corner → name-based resolution + manual
  printing pick.
