# 🃏 MTG Card Scanner

Point your webcam at a Magic: The Gathering card, read its name with OCR, confirm
the match against the [Scryfall](https://scryfall.com) database, and export your
scans in a format your card‑tracking site can import.

This is a **minimal, browser‑based prototype**. It runs entirely in your browser —
the only external calls are to Scryfall (card data) and the Tesseract.js CDN (the
OCR engine).

## Why a web app (and not native Python + OpenCV)?

You're on **WSL2**, which has no direct access to the webcam (`/dev/video*` doesn't
exist). Getting OpenCV to see a USB camera there means `usbipd-win` passthrough and
custom kernel modules, and it often still fails. The browser, however, runs on
Windows and gets the camera for free via `getUserMedia`. So the app is a web page
served on `localhost`.

## Run it

```bash
cd /path/to/mtg-card-scanner
python3 serve.py
```

Then open **http://localhost:8000** in your browser (the script tries to open it for
you) and click **Allow** when asked for camera access.

> The camera only works over `http://localhost` or `https://` — opening
> `index.html` as a `file://` path will *not* get camera permission. Always go
> through the server.

No `pip install` needed — it uses only the Python standard library.

## Use it on your phone (GitHub Pages)

A phone camera exposes and focuses on a glossy card far better than a typical
webcam, and the app is mobile‑ready (portrait camera frame + card‑shaped guide on
small screens). iOS Safari needs **HTTPS** for camera access, so host the static
files on GitHub Pages:

1. Create a new **public** repo on GitHub (e.g. `mtg-card-scanner`).
2. From this folder, push it:
   ```bash
   git remote add origin https://github.com/<your-username>/mtg-card-scanner.git
   git push -u origin main
   ```
   (Pushing over HTTPS will prompt for your GitHub username + a Personal Access
   Token — create one at github.com → Settings → Developer settings → Tokens.)
3. In the repo: **Settings → Pages → Source: Deploy from a branch → `main` / `root`
   → Save**. After ~1 minute your site is live at
   `https://<your-username>.github.io/mtg-card-scanner/`.
4. Open that URL in **iPhone Safari**, tap **Start camera**, and **Allow**. Use
   *Add to Home Screen* for an app‑like icon.

Nothing runs on your PC — GitHub serves the page. Everything else (OCR, Scryfall
lookups, exports) still runs entirely in your phone's browser.

## How to use

1. **Start camera** → grant access.
2. Hold a card so it fills the dashed box, with the **title inside the yellow band**.
   Good, even lighting and a steady hand make OCR far more reliable.
3. **Capture & identify** → the app OCRs the title band and shows the best Scryfall
   match with its image, set, and collector number.
4. If the set/printing is wrong or OCR misread it, **edit the name field and press
   Search** (Scryfall's fuzzy match tolerates typos well).
5. Set **Foil** / **Qty**, then **Add to list**.
6. When done, click an **export** button.

## Two ways to identify a card

Use the **Identify by** toggle above the camera:

- **Name** (default) — OCRs the title and fuzzy-matches the English name catalog.
  Works on cards of any age, but defaults to the *most recent* printing and only
  reads English titles.
- **Set + №** — aim at the card's **bottom-left** corner and fill the blue box with
  the `123/274 · SET · LANG` line. The set code and collector number are printed the
  same in every language, so this pins the **exact printing** and works for
  **English, Japanese, French, Italian, German, and Spanish** cards alike. Only
  cards from ~2015 onward (the M15 frame) print this line — older cards use Name mode.

Either way you can correct a misread in the input field and press **Search**.

## Export formats

| Button          | File                        | Imports into            |
|-----------------|-----------------------------|-------------------------|
| ManaBox CSV     | `collection_manabox.csv`    | ManaBox (and generic)   |
| Moxfield CSV    | `collection_moxfield.csv`   | Moxfield                |
| Archidekt CSV   | `collection_archidekt.csv`  | Archidekt               |
| Deckbox CSV     | `collection_deckbox.csv`    | Deckbox                 |
| Scryfall JSON   | `collection_scryfall.json`  | custom tooling          |

Files download to your browser's Downloads folder. Each row carries the Scryfall ID
where the format supports it, so imports resolve to the exact printing.

## Files

- `index.html` — UI, camera view, and the card‑alignment overlay.
- `app.js` — capture → OCR (Tesseract.js) → Scryfall lookup → list → export.
- `serve.py` — zero‑dependency localhost server (opens the browser for you).

## Known limitations (it's a prototype)

- OCR reads only the **card name**; the printing defaults to the most recent one
  Scryfall returns. Use **edit + Search** to pin an older set.
- One card at a time; no batch/rapid‑fire scanning.
- No persistence — the scan list is in memory and clears on page reload. Export
  before you close the tab.
- Needs internet (Scryfall API + Tesseract.js CDN) and decent lighting.

## Ideas to extend

- Set‑symbol detection to auto‑pick the correct printing.
- Perceptual‑hash image matching against Scryfall bulk art for hands‑free scanning.
- `localStorage` persistence and an editable quantity column.
- A "scan another" hotkey for fast bulk entry.
