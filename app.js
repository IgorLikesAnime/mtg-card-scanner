/* MTG Card Scanner — webcam capture -> OCR -> Scryfall confirm -> multi-format export.
   Minimal prototype. All logic client-side; only external calls are Scryfall (card data)
   and the Tesseract.js CDN (OCR engine, loaded in index.html). */

"use strict";

// ---- element refs ----
const $ = (id) => document.getElementById(id);
const video = $("video");
const frameCanvas = $("frameCanvas");
const ocrCanvas = $("ocrCanvas");
const statusEl = $("status");

let stream = null;
let candidate = null;          // current Scryfall card object awaiting confirmation
let collected = [];            // [{qty, foil, card}]  card = subset of Scryfall fields

const SCRYFALL = "https://api.scryfall.com";
const setStatus = (msg) => { statusEl.textContent = msg; };

// ---- camera ----
$("startBtn").addEventListener("click", async () => {
  try {
    setStatus("Requesting camera…");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await reduceExposure(stream); // best-effort: dim an over-bright webcam
    $("captureBtn").disabled = false;
    $("startBtn").textContent = "Camera on";
    $("startBtn").disabled = true;
    setStatus("Camera ready. Align a card and press Capture.");
  } catch (err) {
    setStatus("Camera error: " + err.message + " (allow camera access and use http://localhost)");
  }
});

// Best-effort: nudge an over-bright webcam darker. Camera controls are
// device-specific and often unsupported — failures are silently ignored.
async function reduceExposure(stream) {
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    const adv = [];
    const lowerThird = (c) => c.min + (c.max - c.min) * 0.33;
    if (caps.brightness) adv.push({ brightness: Math.round(lowerThird(caps.brightness)) });
    if (caps.exposureMode?.includes?.("manual") && caps.exposureTime)
      adv.push({ exposureMode: "manual", exposureTime: Math.round(lowerThird(caps.exposureTime)) });
    else if (caps.exposureMode?.includes?.("continuous"))
      adv.push({ exposureMode: "continuous" });
    if (caps.exposureCompensation) adv.push({ exposureCompensation: caps.exposureCompensation.min });
    if (adv.length) await track.applyConstraints({ advanced: adv });
  } catch { /* unsupported — software adaptive threshold handles the rest */ }
}

// ---- capture + OCR ----
$("captureBtn").addEventListener("click", async () => {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) { setStatus("Camera not ready yet."); return; }

  // full frame (kept for reference / potential re-crop)
  frameCanvas.width = vw; frameCanvas.height = vh;
  frameCanvas.getContext("2d").drawImage(video, 0, 0, vw, vh);

  // Measure the yellow title-band element relative to the stage, so the OCR
  // crop always matches exactly what the user sees — in any layout (desktop
  // landscape or phone portrait). Then map those fractions back to source
  // pixels, accounting for object-fit: cover's scale/crop (needed whenever the
  // camera's aspect ratio differs from the stage, e.g. 16:9 webcam, phone cam).
  const stage = document.querySelector(".stage");
  const sRect = stage.getBoundingClientRect();
  const bRect = document.querySelector(".titleband").getBoundingClientRect();
  const fx = (bRect.left - sRect.left) / sRect.width;
  const fy = (bRect.top - sRect.top) / sRect.height;
  const fw = bRect.width / sRect.width;
  const fh = bRect.height / sRect.height;

  const stageAR = sRect.width / sRect.height;
  const vidAR = vw / vh;
  let visW = 1, visH = 1, cropX = 0, cropY = 0;
  if (vidAR >= stageAR) { visW = stageAR / vidAR; cropX = (1 - visW) / 2; }
  else { visH = vidAR / stageAR; cropY = (1 - visH) / 2; }

  // crop the title band and upscale for OCR, trimming the edges that inject junk
  // glyphs: the left card border (reads as "I"/"|") and the right mana cost.
  const inL = 0.03, inR = 0.15;
  const sx = Math.round((cropX + (fx + fw * inL) * visW) * vw);
  const sy = Math.round((cropY + fy * visH) * vh);
  const sw = Math.round(fw * (1 - inL - inR) * visW * vw);
  const sh = Math.round(fh * visH * vh);
  const scale = 4;
  ocrCanvas.width = sw * scale; ocrCanvas.height = sh * scale;
  const octx = ocrCanvas.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.drawImage(frameCanvas, sx, sy, sw, sh, 0, 0, ocrCanvas.width, ocrCanvas.height);
  preprocessForOCR(octx, ocrCanvas.width, ocrCanvas.height);

  // show the user exactly what the OCR sees (makes alignment issues obvious)
  const prev = $("ocrPreview");
  prev.width = ocrCanvas.width; prev.height = ocrCanvas.height;
  prev.getContext("2d").drawImage(ocrCanvas, 0, 0);
  prev.style.display = "block";

  setStatus("Reading card name (OCR)…");
  $("captureBtn").disabled = true;
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(ocrCanvas);
    const cleaned = cleanName(data.text || "");
    $("searchInput").value = cleaned;
    if (cleaned.length < 2) { setStatus("Couldn't read a name — type it in and press Search."); showCandidate(null); return; }
    setStatus('OCR read: "' + cleaned + '" — matching…');
    await searchScryfall(cleaned);
  } catch (err) {
    setStatus("OCR failed: " + err.message);
  } finally {
    $("captureBtn").disabled = false;
  }
});

// Reusable Tesseract worker: restricts output to name characters (no digits/
// symbols) and treats the crop as one text line. Created once, reused per scan.
let ocrWorker = null;
async function getWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await Tesseract.createWorker("eng");
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: "7", // single text line
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',-",
  });
  return ocrWorker;
}

// Adaptive (local-mean) thresholding via an integral image. Each pixel is
// compared to the average of its neighborhood, so faint/overexposed text on a
// bright banner still binarizes to solid black, and uniform blown-out areas
// stay white. Far more robust to bright/uneven lighting than a global threshold.
function preprocessForOCR(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const gray = new Float64Array(n);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  // integral image (summed-area table), padded by 1 row/col
  const W = w + 1;
  const integ = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integ[(y + 1) * W + (x + 1)] = integ[y * W + (x + 1)] + rowSum;
    }
  }
  const rad = Math.max(6, Math.round(h * 0.35)); // window ~ text height
  const C = 10; // how much darker than local mean counts as "text"
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - rad), y2 = Math.min(h - 1, y + rad);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - rad), x2 = Math.min(w - 1, x + rad);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const s = integ[(y2 + 1) * W + (x2 + 1)] - integ[y1 * W + (x2 + 1)]
              - integ[(y2 + 1) * W + x1] + integ[y1 * W + x1];
      const mean = s / area;
      const p = y * w + x;
      const v = gray[p] < mean - C ? 0 : 255; // darker than local avg -> text
      const idx = p * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---- card matching (local fuzzy against the full Scryfall name catalog) ----
// OCR of Magic's display font is imperfect (Z->L, C->L, stray edge glyphs) and
// Scryfall's fuzzy endpoint rejects multi-error strings. So we match locally
// against every card name with an edit distance we control — tolerant of a
// wrong letter or two — then fetch the exact card for its set/printing details.

let CARD_NAMES = null;
async function loadCardNames() {
  if (CARD_NAMES) return CARD_NAMES;
  try {
    const cached = localStorage.getItem("scryfall_card_names_v1");
    if (cached) { CARD_NAMES = JSON.parse(cached); return CARD_NAMES; }
  } catch { /* ignore */ }
  const j = await fetch(`${SCRYFALL}/catalog/card-names`).then((r) => r.json());
  CARD_NAMES = j.data || [];
  try { localStorage.setItem("scryfall_card_names_v1", JSON.stringify(CARD_NAMES)); } catch { /* quota */ }
  return CARD_NAMES;
}

// strip non-letters, then drop lone leading/trailing letters (mana pips, borders)
function cleanName(text) {
  const toks = text.replace(/[^A-Za-z',\- ]/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").filter(Boolean);
  while (toks.length > 1 && toks[0].length === 1) toks.shift();
  while (toks.length > 1 && toks[toks.length - 1].length === 1) toks.pop();
  return toks.join(" ");
}

// Levenshtein distance with an early-exit cutoff (returns max+1 if exceeded).
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1); cur[0] = i;
    const ac = a.charCodeAt(i - 1);
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// top-k closest real card names to the (cleaned) query
function bestMatches(query, names, k = 6) {
  const q = query.toLowerCase();
  if (q.length < 2) return [];
  const maxD = Math.max(2, Math.ceil(q.length * 0.5));
  const top = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (Math.abs(n.length - q.length) > maxD) continue;
    const d = lev(q, n.toLowerCase(), maxD);
    if (d > maxD) continue;
    const score = d / Math.max(q.length, n.length);
    if (top.length < k) { top.push({ name: n, score }); top.sort((x, y) => x.score - y.score); }
    else if (score < top[k - 1].score) { top[k - 1] = { name: n, score }; top.sort((x, y) => x.score - y.score); }
  }
  return top;
}

async function fetchExact(name) {
  let r = await fetch(`${SCRYFALL}/cards/named?exact=${encodeURIComponent(name)}`);
  if (r.ok) return r.json();
  r = await fetch(`${SCRYFALL}/cards/named?fuzzy=${encodeURIComponent(name)}`);
  return r.ok ? r.json() : null;
}

// ---- lookup ----
$("searchBtn").addEventListener("click", () => {
  const q = $("searchInput").value.trim();
  if (q) searchScryfall(q);
});

async function searchScryfall(query) {
  try {
    setStatus("Matching against Scryfall catalog…");
    const names = await loadCardNames();
    const matches = bestMatches(cleanName(query), names);
    if (!matches.length) {
      showCandidate(null); renderSuggestions([]);
      setStatus("No close match. Edit the name and press Search.");
      return;
    }
    const card = await fetchExact(matches[0].name);
    showCandidate(card);
    renderSuggestions(matches.slice(1));
    const pct = Math.round((1 - matches[0].score) * 100);
    setStatus(`Best match: ${matches[0].name} (~${pct}%). Wrong? Tap an alternative below or edit + Search.`);
  } catch (err) {
    setStatus("Lookup error: " + err.message);
  }
}

// clickable alternative-name chips under the candidate
function renderSuggestions(list) {
  const box = $("suggestions");
  box.innerHTML = "";
  if (!list || !list.length) { box.style.display = "none"; return; }
  const lbl = document.createElement("span");
  lbl.textContent = "Or:";
  lbl.style.cssText = "font-size:13px;color:#9aa2b5;align-self:center;";
  box.appendChild(lbl);
  list.forEach((m) => {
    const b = document.createElement("button");
    b.className = "secondary";
    b.style.cssText = "font-size:12px;padding:5px 9px;";
    b.textContent = m.name;
    b.addEventListener("click", async () => {
      $("searchInput").value = m.name;
      setStatus(`Loading ${m.name}…`);
      const card = await fetchExact(m.name);
      showCandidate(card);
      renderSuggestions(list.filter((x) => x.name !== m.name));
      setStatus(`Selected: ${m.name}. Confirm below.`);
    });
    box.appendChild(b);
  });
  box.style.display = "flex";
}

function showCandidate(card) {
  candidate = card;
  const box = $("candidate");
  box.style.display = "flex";
  if (!card) {
    $("candImg").removeAttribute("src");
    $("candName").textContent = "—";
    $("candSub").textContent = "No confirmed match yet.";
    $("addBtn").disabled = true;
    return;
  }
  const img = card.image_uris?.small
    || card.card_faces?.[0]?.image_uris?.small || "";
  $("candImg").src = img;
  $("candName").textContent = card.name;
  $("candSub").textContent = `${card.set_name} (${(card.set || "").toUpperCase()}) · #${card.collector_number} · ${card.rarity}`;
  $("foilChk").checked = false;
  $("qtyInput").value = 1;
  $("addBtn").disabled = false;
}

// ---- collected list ----
$("addBtn").addEventListener("click", () => {
  if (!candidate) return;
  const foil = $("foilChk").checked;
  const qty = Math.max(1, parseInt($("qtyInput").value, 10) || 1);
  const c = {
    id: candidate.id,
    name: candidate.name,
    set: candidate.set,
    set_name: candidate.set_name,
    collector_number: candidate.collector_number,
    rarity: candidate.rarity,
    lang: candidate.lang || "en",
  };
  // merge if same printing + finish already scanned
  const existing = collected.find((e) => e.card.id === c.id && e.foil === foil);
  if (existing) existing.qty += qty;
  else collected.push({ qty, foil, card: c });
  renderList();
  setStatus(`Added ${qty}× ${c.name}${foil ? " (foil)" : ""}.`);
  $("candidate").style.display = "none";
  $("suggestions").style.display = "none";
  candidate = null;
});

function renderList() {
  const tbody = $("tbody");
  $("count").textContent = collected.reduce((n, e) => n + e.qty, 0);
  if (collected.length === 0) {
    $("emptyMsg").style.display = "block";
    $("table").style.display = "none";
    tbody.innerHTML = "";
    return;
  }
  $("emptyMsg").style.display = "none";
  $("table").style.display = "table";
  tbody.innerHTML = "";
  collected.forEach((e, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="num">${e.qty}</td>` +
      `<td>${escapeHtml(e.card.name)}</td>` +
      `<td>${(e.card.set || "").toUpperCase()} #${escapeHtml(e.card.collector_number)}</td>` +
      `<td>${e.foil ? "✨" : ""}</td>`;
    const td = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "remove"; btn.textContent = "✕";
    btn.addEventListener("click", () => { collected.splice(i, 1); renderList(); });
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- exports ----
document.querySelectorAll(".exports button").forEach((b) =>
  b.addEventListener("click", () => exportAs(b.dataset.fmt)));

// RFC-4180-ish CSV cell escaping (card names can contain commas, e.g. "Borrowing 100,000 Arrows")
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

function exportAs(fmt) {
  if (collected.length === 0) { setStatus("Nothing to export yet."); return; }
  let text, filename, mime = "text/csv";

  if (fmt === "manabox") {
    const header = ["Name", "Set code", "Set name", "Collector number", "Foil",
      "Rarity", "Quantity", "Scryfall ID", "Condition", "Language"];
    const rows = collected.map((e) => [e.card.name, e.card.set, e.card.set_name,
      e.card.collector_number, e.foil ? "foil" : "normal", e.card.rarity, e.qty,
      e.card.id, "near_mint", e.card.lang]);
    text = toCSV([header, ...rows]); filename = "collection_manabox.csv";

  } else if (fmt === "moxfield") {
    const header = ["Count", "Name", "Edition", "Condition", "Language", "Foil", "Collector Number"];
    const rows = collected.map((e) => [e.qty, e.card.name, e.card.set,
      "Near Mint", e.card.lang, e.foil ? "foil" : "", e.card.collector_number]);
    text = toCSV([header, ...rows]); filename = "collection_moxfield.csv";

  } else if (fmt === "archidekt") {
    const header = ["Quantity", "Name", "Finish", "Condition", "Edition Code",
      "Collector Number", "Scryfall ID"];
    const rows = collected.map((e) => [e.qty, e.card.name, e.foil ? "Foil" : "Normal",
      "NM", e.card.set, e.card.collector_number, e.card.id]);
    text = toCSV([header, ...rows]); filename = "collection_archidekt.csv";

  } else if (fmt === "deckbox") {
    const header = ["Count", "Name", "Edition", "Card Number", "Condition", "Language", "Foil"];
    const rows = collected.map((e) => [e.qty, e.card.name, e.card.set_name,
      e.card.collector_number, "Near Mint", "English", e.foil ? "foil" : ""]);
    text = toCSV([header, ...rows]); filename = "collection_deckbox.csv";

  } else if (fmt === "scryfall") {
    text = JSON.stringify(collected.map((e) => ({
      quantity: e.qty, foil: e.foil, scryfall_id: e.card.id, name: e.card.name,
      set: e.card.set, set_name: e.card.set_name, collector_number: e.card.collector_number,
      rarity: e.card.rarity, lang: e.card.lang,
    })), null, 2);
    filename = "collection_scryfall.json"; mime = "application/json";
  } else { return; }

  const blob = new Blob([text], { type: mime });
  const a = $("dl");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  setStatus(`Exported ${collected.length} line(s) → ${filename}`);
}

renderList();
loadCardNames().catch(() => {}); // warm the name catalog while the user aligns a card
