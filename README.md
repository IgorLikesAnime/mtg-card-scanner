# 🃏 MTG Card Scanner

Pick the set you're scanning, point your camera at each card's **artwork**, and the
app identifies it by **image** — the same perceptual-hash approach that Delver Lens
and ManaBox use — then exports your scans for your card-tracking site.

Runs entirely in your browser; the only external calls are to
[Scryfall](https://scryfall.com) for card data and images.

## Why image matching, not OCR?

Earlier versions read the card's title with OCR (Tesseract). Magic's stylized
display font, through a phone camera, is right at the edge of what OCR can do, so it
misread names and couldn't handle other languages. Real scanner apps don't OCR —
they compare a **fingerprint of the card's picture** (a perceptual hash) against a
database of known cards. That's font-proof and **language-independent** (a Japanese
card has the same art as the English one). To keep it accurate and fast, matching is
**scoped to one set at a time** ("set-locking", like Delver Lens) — ~300 candidates
instead of 90,000.

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

Nothing runs on your PC — GitHub serves the page. Everything else (matching,
Scryfall calls, exports) runs entirely in your phone's browser.

## How to use

1. **Load a set** — type the set name or code (e.g. `Return to Ravnica` or `rtr`) and
   press **Load set**. The first time, it downloads and fingerprints that set's
   ~300 artworks (a progress bar shows it); after that the set is cached and instant.
2. **Start camera** → grant access.
3. Line the card's **artwork** up inside the blue box and **Capture & match**. It
   compares your shot to the set and shows the closest card with a confidence %.
4. If it's wrong, **tap one of the alternative names**, or type the name in the
   **Search by name** box (fuzzy-matched within the loaded set).
5. Set **Lang** (for non-English copies — the art is identical across languages),
   **Foil**, **Qty**, then **Add to list**.
6. When done, click an **export** button.

Because you tell it the set, the **exact printing** (set + collector number) is
always correct — no printing guesswork.

## Tips for good matches

- Fill the blue box with just the **artwork**, reasonably square-on and in focus.
- Even lighting; avoid glare on the art.
- Set-locking is what makes it accurate — always load the right set first. To scan a
  mixed pile, group by set.

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

- `index.html` — UI: set picker, camera view, art guide box, result, list, export.
- `app.js` — set fetch + artwork hashing (dHash+aHash), capture → match → export.
- `serve.py` — zero‑dependency localhost server for local dev (opens the browser).

## How the matching works

Each card's Scryfall `art_crop` image is reduced to a 128‑bit perceptual hash
(64‑bit difference hash + 64‑bit average hash). Your captured artwork gets the same
hash, and the card with the smallest **Hamming distance** within the loaded set
wins. Hashes are cached per set in `localStorage`, so a set is fingerprinted once.

## Known limitations

- **You pick the set** — matching is scoped to it (that's what makes it accurate).
  A random mixed pile means switching sets; group by set for speed.
- Needs a reasonably **square-on, in-focus** shot of the artwork; heavy glare or
  extreme angles hurt matching.
- Language is inferred from the **Lang** selector, not the card (art can't tell them
  apart) — set it for non-English copies.
- No persistence — the scan list clears on reload. Export before closing.
- Needs internet (Scryfall API + card images).

## Ideas to extend

- Auto card-detection + perspective correction (OpenCV.js) for hands-free scanning.
- A larger/rotation-robust hash, or art + full-card hashes combined.
- `localStorage` persistence of the scan list; a "scan another" hotkey for speed.
- Optional global (no set-lock) mode from a prebuilt hash database.
