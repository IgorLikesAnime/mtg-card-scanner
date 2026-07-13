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

// ---- mode toggle: identify by name (title) or by set code + collector number ----
let mode = "name";
function setMode(m) {
  mode = m;
  $("overlay").classList.toggle("mode-code", m === "code");
  $("modeName").classList.toggle("active", m === "name");
  $("modeCode").classList.toggle("active", m === "code");
  $("hint").textContent = m === "code"
    ? "Fill the box with the bottom-left block — include the №, set code & language"
    : "Get in close — fill the yellow band with the card's name";
  $("captureBtn").textContent = m === "code" ? "📸 Capture set / №" : "📸 Capture & identify";
  $("searchInput").placeholder = m === "code" ? "Set code, №, lang (e.g. NEO 100 ja)" : "Card name (edit & re-search)";
  $("candidate").style.display = "none";
  $("suggestions").style.display = "none";
}
$("modeName").addEventListener("click", () => setMode("name"));
$("modeCode").addEventListener("click", () => setMode("code"));

// ---- capture + OCR ----
$("captureBtn").addEventListener("click", async () => {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) { setStatus("Camera not ready yet."); return; }

  // full frame (kept for reference / potential re-crop)
  frameCanvas.width = vw; frameCanvas.height = vh;
  frameCanvas.getContext("2d").drawImage(video, 0, 0, vw, vh);

  // Measure the active capture box (title band, or the set/№ box) relative to
  // the stage so the OCR crop always matches what the user sees — in any layout.
  // Then map those fractions back to source pixels, accounting for object-fit:
  // cover's scale/crop (needed when the camera's aspect ratio differs).
  const stage = document.querySelector(".stage");
  const sRect = stage.getBoundingClientRect();
  const bRect = document.querySelector(mode === "code" ? ".numberband" : ".titleband").getBoundingClientRect();
  const fx = (bRect.left - sRect.left) / sRect.width;
  const fy = (bRect.top - sRect.top) / sRect.height;
  const fw = bRect.width / sRect.width;
  const fh = bRect.height / sRect.height;

  const stageAR = sRect.width / sRect.height;
  const vidAR = vw / vh;
  let visW = 1, visH = 1, cropX = 0, cropY = 0;
  if (vidAR >= stageAR) { visW = stageAR / vidAR; cropX = (1 - visW) / 2; }
  else { visH = vidAR / stageAR; cropY = (1 - visH) / 2; }

  // In name mode, trim band edges that inject junk glyphs: left card border
  // (reads as "I"/"|") and right mana cost. The set/№ box uses its full area.
  const inL = mode === "code" ? 0 : 0.03;
  const inR = mode === "code" ? 0 : 0.15;
  const sx = Math.round((cropX + (fx + fw * inL) * visW) * vw);
  const sy = Math.round((cropY + fy * visH) * vh);
  const sw = Math.round(fw * (1 - inL - inR) * visW * vw);
  const sh = Math.round(fh * visH * vh);
  const scale = 4;
  ocrCanvas.width = sw * scale; ocrCanvas.height = sh * scale;
  const octx = ocrCanvas.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.drawImage(frameCanvas, sx, sy, sw, sh, 0, 0, ocrCanvas.width, ocrCanvas.height);
  // set/№ text can be light-on-dark (black-bordered cards), so use polarity-aware
  // binarization there; the title band is dark-on-light -> adaptive threshold.
  (mode === "code" ? preprocessBlock : preprocessForOCR)(octx, ocrCanvas.width, ocrCanvas.height);

  // show the user exactly what the OCR sees (makes alignment issues obvious)
  const prev = $("ocrPreview");
  prev.width = ocrCanvas.width; prev.height = ocrCanvas.height;
  prev.getContext("2d").drawImage(ocrCanvas, 0, 0);
  prev.style.display = "block";

  setStatus(mode === "code" ? "Reading set / number…" : "Reading card name (OCR)…");
  $("captureBtn").disabled = true;
  try {
    const worker = await getWorker(mode);
    const { data } = await worker.recognize(ocrCanvas);
    if (mode === "code") await identifyByCode(data.text || "");
    else await identifyByName(data.text || "");
  } catch (err) {
    setStatus("OCR failed: " + err.message);
  } finally {
    $("captureBtn").disabled = false;
  }
});

async function identifyByName(text) {
  const cleaned = cleanName(text);
  $("searchInput").value = cleaned;
  if (cleaned.length < 2) { setStatus("Couldn't read a name — type it in and press Search."); showCandidate(null); return; }
  setStatus('OCR read: "' + cleaned + '" — matching…');
  await searchScryfall(cleaned);
}

// Tesseract workers — one per mode (different page-seg + character whitelist),
// created once and reused. Name mode: single line of letters. Code mode: a
// small multi-line block of digits + uppercase letters + the "/" separator.
const ocrWorkers = {};
async function getWorker(m) {
  if (ocrWorkers[m]) return ocrWorkers[m];
  const w = await Tesseract.createWorker("eng");
  await w.setParameters(m === "code"
    ? { tessedit_pageseg_mode: "6", tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/ " }
    : { tessedit_pageseg_mode: "7", tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',-" });
  ocrWorkers[m] = w;
  return w;
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

// Global Otsu binarization with automatic polarity: the minority pixel class is
// treated as ink and rendered black-on-white. Handles the set/№ line whether it
// is dark-on-light (white-bordered cards) or light-on-dark (black-bordered).
function preprocessBlock(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    gray[p] = g; hist[g]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = n - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thr = t; }
  }
  let below = 0;
  for (let p = 0; p < n; p++) if (gray[p] <= thr) below++;
  const textIsDark = below <= n - below; // fewer dark pixels => dark is the ink
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const isText = (gray[p] <= thr) === textIsDark;
    const v = isText ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
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

// top-k closest real card names to the (cleaned) query. Combines whole-string
// edit distance with token awareness: an exact name wins outright, names that
// contain all the query's words are boosted (so a partial read like "Courier"
// surfaces "Crosstown Courier"), and unrelated long names are filtered out.
function bestMatches(query, names, k = 6) {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return [];
  const qTokens = q.split(" ").filter(Boolean);
  const maxD = Math.max(2, Math.ceil(q.length * 0.5));
  const top = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const n = name.toLowerCase();
    const lenClose = Math.abs(n.length - q.length) <= maxD;
    const overlap = qTokens.some((t) => t.length >= 3 && n.includes(t));
    if (!lenClose && !overlap) continue; // prune the bulk of the catalog fast
    const d = lev(q, n, lenClose ? maxD : Math.max(q.length, n.length));
    let sim = 1 - d / Math.max(q.length, n.length);
    if (n === q) sim = 1;
    else if (qTokens.every((t) => n.split(" ").includes(t))) sim = Math.max(sim, 0.7 + 0.3 * sim);
    if (sim < 0.35) continue;
    if (!overlap && sim < 0.7) continue; // drop unrelated long-name filler
    const score = 1 - sim;
    if (top.length < k) { top.push({ name, score }); top.sort((a, b) => a.score - b.score); }
    else if (score < top[k - 1].score) { top[k - 1] = { name, score }; top.sort((a, b) => a.score - b.score); }
  }
  return top;
}

async function fetchExact(name) {
  let r = await fetch(`${SCRYFALL}/cards/named?exact=${encodeURIComponent(name)}`);
  if (r.ok) return r.json();
  r = await fetch(`${SCRYFALL}/cards/named?fuzzy=${encodeURIComponent(name)}`);
  return r.ok ? r.json() : null;
}

// ---- identify by set code + collector number (language-independent) ----
// The set code and collector number are printed identically in every language,
// so reading them pins the exact printing in EN/JP/FR/DE/IT/ES via one API call.

// real set codes, cached — used to validate the OCR'd set token so junk words
// (THE, OF, COAST from the copyright line) are never mistaken for a set code.
let SET_CODES = null;
async function loadSetCodes() {
  if (SET_CODES) return SET_CODES;
  try {
    const cached = localStorage.getItem("scryfall_set_codes_v1");
    if (cached) { SET_CODES = new Set(JSON.parse(cached)); return SET_CODES; }
  } catch { /* ignore */ }
  const data = (await fetch(`${SCRYFALL}/sets`).then((r) => r.json())).data || [];
  const codes = data.map((s) => s.code.toUpperCase());
  SET_CODES = new Set(codes);
  try { localStorage.setItem("scryfall_set_codes_v1", JSON.stringify(codes)); } catch { /* quota */ }
  return SET_CODES;
}

function parseSetNumber(text, codes) {
  const t = text.toUpperCase().replace(/[|]/g, "/");
  const tokens = t.split(/[^A-Z0-9]+/).filter(Boolean);
  // collector number: digits before a "/" (e.g. 0123/274), else first number
  let num = null;
  const slash = t.match(/(\d{1,5})\s*\/\s*\d{1,5}/);
  if (slash) num = slash[1];
  else { const n = tokens.find((tk) => /^\d{1,5}$/.test(tk)); if (n) num = n; }
  if (num) num = num.replace(/^0+(?=\d)/, ""); // strip leading zeros
  // set code: only accept a token that is an actual Scryfall set code
  const set = tokens.find((tk) => codes && codes.has(tk)) || null;
  // language code as printed on the card -> Scryfall lang
  const langMap = { EN: "en", JP: "ja", JA: "ja", FR: "fr", DE: "de", IT: "it",
    ES: "es", SP: "es", PT: "pt", RU: "ru", KO: "ko", CS: "zhs", CT: "zht" };
  let lang = null;
  for (const tk of tokens) { if (langMap[tk]) { lang = langMap[tk]; break; } }
  return { set, num, lang };
}

async function lookupBySetNumber(set, num, lang) {
  const base = `${SCRYFALL}/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(num)}`;
  try {
    let r = await fetch(lang ? `${base}/${lang}` : base);
    if (r.ok) return r.json();
    if (lang) { r = await fetch(base); if (r.ok) return r.json(); } // fall back to any language
  } catch { /* network */ }
  return null;
}

async function identifyByCode(text) {
  const codes = await loadSetCodes();
  const { set, num, lang } = parseSetNumber(text, codes);
  $("searchInput").value = [set, num, lang].filter(Boolean).join(" ");
  renderSuggestions([]);
  if (!set || !num) {
    showCandidate(null);
    setStatus(`Couldn't read set/№ (set="${set || "?"}", №="${num || "?"}"). Include the set-code line, or use Name mode — older cards don't print a set code.`);
    return;
  }
  setStatus(`Read ${set.toUpperCase()} #${num}${lang ? " (" + lang + ")" : ""} — looking up…`);
  const card = await lookupBySetNumber(set, num, lang);
  if (card) { showCandidate(card); setStatus(`Found ${card.printed_name || card.name} — ${set.toUpperCase()} #${num}. Confirm below.`); }
  else { showCandidate(null); setStatus(`No card for ${set.toUpperCase()} #${num}${lang ? "/" + lang : ""}. Edit the field and Search, or try Name mode.`); }
}

// ---- lookup ----
$("searchBtn").addEventListener("click", () => {
  const q = $("searchInput").value.trim();
  if (!q) return;
  if (mode === "code") identifyByCode(q); else searchScryfall(q);
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

function renderCandidateInfo(card) {
  const img = card.image_uris?.small
    || card.card_faces?.[0]?.image_uris?.small || "";
  $("candImg").src = img;
  // show the localized printed name (if any) alongside the English name
  $("candName").textContent = (card.printed_name && card.printed_name !== card.name)
    ? `${card.printed_name} · ${card.name}` : card.name;
  const langTag = card.lang && card.lang !== "en" ? " · " + card.lang.toUpperCase() : "";
  $("candSub").textContent = `${card.set_name} (${(card.set || "").toUpperCase()}) · #${card.collector_number} · ${card.rarity}${langTag}`;
}

function showCandidate(card) {
  candidate = card;
  $("candidate").style.display = "flex";
  if (!card) {
    $("candImg").removeAttribute("src");
    $("candName").textContent = "—";
    $("candSub").textContent = "No confirmed match yet.";
    $("printSelect").style.display = "none";
    $("addBtn").disabled = true;
    return;
  }
  renderCandidateInfo(card);
  $("foilChk").checked = false;
  $("qtyInput").value = 1;
  $("addBtn").disabled = false;
  loadPrintings(card);
}

// Populate the printing dropdown so the user can pick the exact set — the
// reliable way to get the right printing without OCR'ing tiny set codes.
let currentPrintings = [];
async function loadPrintings(card) {
  const sel = $("printSelect");
  sel.style.display = "none"; sel.innerHTML = ""; currentPrintings = [];
  // for a non-English match (Set + № mode) the exact printing is already known
  if (!card.prints_search_uri || (card.lang && card.lang !== "en")) return;
  try {
    const data = (await fetch(card.prints_search_uri).then((r) => r.json())).data || [];
    if (data.length <= 1) return;
    currentPrintings = data;
    data.forEach((c, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = `${c.set_name} (${(c.set || "").toUpperCase()}) · #${c.collector_number} · ${(c.released_at || "").slice(0, 4)}`;
      if (c.id === card.id) o.selected = true;
      sel.appendChild(o);
    });
    sel.style.display = "block";
  } catch { /* ignore */ }
}

$("printSelect").addEventListener("change", () => {
  const c = currentPrintings[+$("printSelect").value];
  if (c) { candidate = c; renderCandidateInfo(c); }
});

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
// warm the catalogs while the user aligns a card
loadCardNames().catch(() => {});
loadSetCodes().catch(() => {});
