# CLAUDE.md — project direction & context

Guidance for future Claude sessions on this repo. Read this first.

## 🧭 Handoff (2026-07-14)

**State:** the cloud-vision app is **deployed and live** as a **public tool (Mode B)** — anyone
can scan, no setup. Branch `cloud-vision-gemini`. `main` (original set-lock app) and
`rebuild-selfhosted` (complete offline package, commit `b3bb8a5`) are intact.

**Live:**
- App (GitHub Pages): <https://igorlikesanime.github.io/mtg-card-scanner/>
- Worker: `https://mtgcardscanner.amirmag1851.workers.dev`  (health: `/health` → `{ok:true}`)
- Model: `gemini-flash-latest` (Google retired 2.0 and, for new keys, 2.5 — use the `-latest`
  alias to auto-roll forward). `GEMINI_MODEL` var overrides it.

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

**Open items:** confirm the `RATE_LIMITER` binding is actually added on the Worker (dashboard →
Settings → Bindings). Consider bring-your-own-key if cost/abuse ever becomes a problem.

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
