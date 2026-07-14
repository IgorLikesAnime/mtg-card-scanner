# 🃏 MTG Card Scanner

**[▶️ Open the scanner](https://igorlikesanime.github.io/mtg-card-scanner/)** — point your phone
at a Magic: The Gathering card and it identifies the **exact printing** (any set, any language),
builds a list, and exports it to ManaBox, Moxfield, Archidekt, Deckbox, or Scryfall.

No install, no sign-up, no API key. It runs in your phone's browser.

## Why it's accurate

Instead of fragile artwork matching, a **vision model reads the card** — its name and the
bottom-left **collector number + set code + language**. That pins the precise printing, and
[Scryfall](https://scryfall.com) fills in the canonical card details, image, and IDs.

## How to use it

1. Open **[the scanner](https://igorlikesanime.github.io/mtg-card-scanner/)** on your phone.
2. **Start camera** and allow access.
3. Fit the **whole card** inside the on-screen box, then **📸 Capture & identify**.
4. Check the match. If it's off, **Search by name** or adjust the **Printing / Language**.
5. Set **Foil** / **Qty**, then **➕ Add to list**.
6. Scan as many as you like, then tap an **export** button.

> **Tip:** your list lives in the page while it's open — **export before you close the tab.**

## Export formats

| Button        | File                       | Imports into          |
|---------------|----------------------------|-----------------------|
| ManaBox CSV   | `collection_manabox.csv`   | ManaBox (and generic) |
| Moxfield CSV  | `collection_moxfield.csv`  | Moxfield              |
| Archidekt CSV | `collection_archidekt.csv` | Archidekt             |
| Deckbox CSV   | `collection_deckbox.csv`   | Deckbox               |
| Scryfall JSON | `collection_scryfall.json` | custom tooling        |

Each row carries the Scryfall ID (where the target supports it), so imports resolve to the
exact printing you scanned.

## Good to know

- **Camera & internet:** the scanner needs a modern phone camera and a connection (it reads the
  card via Google Gemini and looks it up on Scryfall).
- **Your photos:** each captured card image is sent to Google (Gemini) for identification, then
  discarded. Your scanned list stays in your browser and is never uploaded anywhere.
- **Very old cards** (pre‑2014) have no collector-number corner, so the scanner falls back to a
  name search and a manual printing pick.
- Best results: fill the box with the card, hold steady, and avoid glare on foils.

## Run your own

The whole thing is a static web app plus one small serverless proxy. If you'd rather host your
own copy (your own Gemini key, your own limits), it's two pieces:

- **The app** (`index.html`, `app.js`) — static files; host them anywhere with HTTPS
  (GitHub Pages works great and is free).
- **A Cloudflare Worker** (`worker/`) — a thin proxy that holds your Gemini API key so it never
  reaches the browser, and reads each card via Gemini.

Full walkthrough: **[`worker/README.md`](worker/README.md)**. In brief: create a Gemini key,
deploy the Worker (dashboard or `wrangler`), set `ALLOWED_ORIGIN` to your site's origin, add
your `GEMINI_API_KEY` + a shared `APP_TOKEN` as secrets, then publish the app. Set a **Gemini
budget cap** and add the optional **rate-limit binding** so a public URL can't run up your bill.

## How it works

```
Your phone (browser, HTTPS)          Cloudflare Worker (holds the Gemini key)
  capture the card   ──POST /identify──▶  Google Gemini reads the card
  show the match     ◀── {name, set, collector#, lang} ──
  resolve printing   ──▶ api.scryfall.com  ──▶  exact card + image + IDs
  confirm → list → export
```

- The **app** is served over HTTPS so the phone camera works — nothing to install.
- The **Cloudflare Worker** is the only server piece; it keeps the API key server-side and
  handles the browser↔Gemini call. Scryfall lookups happen directly from your browser.

## Project layout

- `index.html`, `app.js` — the static scanner (camera → Worker → Scryfall → list → export).
- `worker/` — the Cloudflare Worker Gemini proxy + deploy instructions.
- `CLAUDE.md` — architecture & direction notes for contributors.

## Credits

Card data and images from **[Scryfall](https://scryfall.com)**. Card identification by
**Google Gemini**. Magic: The Gathering is a trademark of Wizards of the Coast; this project is
unaffiliated fan tooling.
