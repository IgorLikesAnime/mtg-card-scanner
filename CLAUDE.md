# CLAUDE.md — agent guide for mtg-card-scanner

Dense, actionable context for AI coding sessions. Read this first. For the human-facing overview,
see `README.md`.

## What this is
- Phone MTG card scanner: camera → Cloudflare Worker (Gemini vision proxy) → Scryfall → collected
  list → export (ManaBox/Moxfield/Archidekt/Deckbox/Scryfall).
- **Live & public.** App: <https://igorlikesanime.github.io/mtg-card-scanner/> · Worker:
  `https://mtgcardscanner.amirmag1851.workers.dev`. `main` is the product; GitHub Pages serves
  `main`/root. Repo is public and contains **no secrets**.

## Stack & structure
- **No build, no framework, no package.json, no tests.** Vanilla static app + one Worker.
- `index.html` — single-file app: inline `<style>` + markup, loads `app.js`.
- `app.js` — camera → `POST {WORKER_URL}/identify` → Scryfall resolve → list → export. `"use strict"`,
  plain script (not ESM), `$ = id => getElementById`.
- `worker/worker.js` — Cloudflare Worker, ESM (`export default { async fetch }`). `worker/wrangler.toml`,
  `worker/README.md`.
- Config in `app.js`: constants `WORKER_URL` + `APP_TOKEN` (public by design — no Settings/localStorage
  override; that path was removed).

## Commands
- **Local preview (UI only):** `python3 -m http.server 8000` → http://localhost:8000 (localhost = secure
  context, so camera works). No Node on this box; use Python to serve. Identify won't run locally — see Quirks.
- **Worker deploy:** `cd worker && wrangler deploy` then `wrangler secret put GEMINI_API_KEY` and
  `wrangler secret put APP_TOKEN` (or use the Cloudflare dashboard).
- **Worker health:** `curl https://mtgcardscanner.amirmag1851.workers.dev/health` → `{"ok":true,"ratelimit":true}`.
- **Ship the app:** commit `index.html`/`app.js` to `main` and push; Pages rebuilds in ~1 min.
- **No lint/test/build exist.** Verify manually (see Verification).

## Coding standards
- Keep it **dependency-free and no-build** — must stay directly serveable by GitHub Pages.
- 2-space indent, double quotes, semicolons; small helper functions; match existing style.
- CSS lives **inline in `index.html`** and is **mobile-first**: base rules = phone (single column,
  full-width buttons, 16px inputs to stop iOS zoom); desktop two-panel layers on at `@media (min-width:861px)`.
- **Design constraint:** one muted accent (`--accent #c2a063` brass on `--bg #17181b` charcoal). No
  neon, glows, or gradients (a neon-cyan first pass was rejected as looking AI-generated).
- Worker: server-to-server only; never leak `GEMINI_API_KEY` to the client.

## ⚠️ DOM contract (breaking these breaks `app.js`)
- `app.js` selects fixed IDs/classes: `video, frameCanvas, status, startBtn, captureBtn, .stage,
  .cardbox, capPreview, candidate, candImg, candName, candSub, candRead, searchInput, searchBtn,
  suggestions, langSelect, printingSelect, foilChk, qtyInput, addBtn, count, emptyMsg, table, tbody,
  .exports (buttons carry data-fmt), dl`. Restyle/move freely, but keep the IDs/classes.
- **`.cardbox` MUST stay nested inside `.stage`.** The capture crop math reads `getBoundingClientRect()`
  of both to map the guide box to source pixels — re-test capture after any layout change.
- **Export/list code in `app.js` is carried over verbatim across versions — keep it byte-stable.**
- `body.scanning` class (added on capture, cleared in `identify()`'s `finally`) drives the scan-line +
  spinner and disables Capture mid-scan.

## Worker specifics (`worker/worker.js`)
- Endpoints: `OPTIONS *` (CORS preflight) · `GET /health` · `POST /identify` (raw JPEG body,
  `x-app-token` header) → `{name, set_code?, collector_number?, language?, foil?, confidence?}`.
- Env: `GEMINI_API_KEY` (secret), `APP_TOKEN` (secret), `ALLOWED_ORIGIN` (var, the Pages origin),
  `GEMINI_MODEL` (var; code default `gemini-flash-latest`, live var set to `gemini-flash-lite-latest`),
  `RATE_LIMITER` (optional binding, 15 req / 60s per IP; falls back to Gemini budget cap if absent).
- Gates `/identify`: `Origin` must equal `ALLOWED_ORIGIN` (else 403) **and** `x-app-token` must match
  (else 401). Image size guard: 1 byte–6 MB (else 400).
- Cost: `APP_TOKEN` is a public speed-bump; real ceiling = Gemini **prepay balance** + per-IP rate limit.
- Calls `v1beta/models/${model}:generateContent` with the image as `inline_data`, `temperature:0`,
  strict `responseSchema`. Scryfall resolve order: `GET /cards/{set}/{num}` (+`/{lang}`) →
  `GET /cards/named?fuzzy=` → browse `prints_search_uri`. ~1,300 tokens ≈ ~$0.0002/scan.

## Quirks / guardrails
- **Never `git add -A`** here — it tries to scan ~54k gitignored thumbnails and hangs. Stage explicit
  paths (`git add index.html app.js …`).
- Repo lives on the **Windows filesystem via WSL** (under `/mnt/c/`), so expect Windows FS
  performance/permissions quirks. Remote: `IgorLikesAnime/mtg-card-scanner`.
- ~3.7 GB of gitignored local artifacts (`mtg.db`, `web/thumbs/`, `data/`, `.venv`) linger from an old
  offline attempt — harmless, ignore.
- **Camera needs HTTPS/localhost;** `file://` won't get it. Identify needs internet (Gemini + Scryfall).
- **localhost can't run identify** — the Worker's origin gate only trusts the Pages origin. Test the full
  scan on the live URL / a real phone.
- Pre-2014 cards lack the collector corner → name-based resolution + manual printing pick.
- Don't touch `worker/`, `wrangler.toml`, or export functions without a clear reason.

## Other branches (don't disturb without reason)
- `rebuild-selfhosted` — **local-only** (not on GitHub): abandoned fully-offline attempt (Python
  server + prebuilt SQLite art fingerprints). Heavier and less accurate in-hand; superseded by
  cloud vision. `main` is the only remote branch.

## Verification (no test suite)
1. **No dead refs:** `grep -nE "settings|workerUrl|appToken|saveSettings" index.html app.js` → none.
2. **DOM contract intact:** every `$("…")` ID exists in `index.html`; `.cardbox` still inside `.stage`.
3. **Worker up:** `curl …/health` → `{"ok":true,...}`.
4. **Full flow (device/live only):** scan a real card on the live URL — identifies, cropped preview
   matches the guide box, Add works, an export downloads.
