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
3. Fit the **whole card** inside the on-screen frame, then **Capture & identify**.
4. Check the match. If it's off, **Search by name** or adjust the **Printing / Language**.
5. Set **Foil** / **Qty**, then **Add to list**.
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
  card with an AI vision service and looks it up on Scryfall).
- **Your photos:** each captured card image is sent to a cloud vision service for identification,
  then discarded. Your scanned list stays in your browser and is never uploaded anywhere.
- **Very old cards** (pre‑2014) have no collector-number corner, so the scanner falls back to a
  name search and a manual printing pick.
- Best results: fill the frame with the card, hold steady, and avoid glare on foils.

## How it works

```
Your phone (browser, HTTPS)          Secure proxy (holds the API key)
  capture the card   ──POST /identify──▶  an AI vision model reads the card
  show the match     ◀── {name, set, collector#, lang} ──
  resolve printing   ──▶ api.scryfall.com  ──▶  exact card + image + IDs
  confirm → list → export
```

- The **app** is a single static page served over HTTPS so the phone camera works — nothing to
  install and no build step.
- A small **secure proxy** (a Cloudflare Worker) is the only server piece; it keeps the API key
  server-side and makes the vision call. Scryfall lookups happen directly from your browser.

## Project layout

- `index.html`, `app.js` — the static scanner (camera → proxy → Scryfall → list → export).
- `worker/` — the secure vision proxy and its deploy instructions.
- `CLAUDE.md` — dense architecture notes and contributor/agent constraints.

## Contributing

Contributions are welcome! A few things that keep this project simple:

- **No build, no framework, no dependencies.** The app is vanilla HTML/CSS/JS served as static
  files; please keep it that way so GitHub Pages can serve it directly.
- **Two moving parts only:** the static app and the Cloudflare Worker. Changes to card
  identification usually touch `worker/worker.js`; UI changes touch `index.html` / `app.js`.
- **Open a PR** describing what you changed and how you tested it. Keep the export formats stable —
  people rely on them importing cleanly.

See `CLAUDE.md` for the architecture details, exact commands, and known quirks.

## Credits

Card data and images from **[Scryfall](https://scryfall.com)**. Magic: The Gathering is a
trademark of Wizards of the Coast; this project is unaffiliated fan tooling.
