/* MTG Card Scanner — cloud-vision client.
   Capture the whole card -> POST to your Cloudflare Worker, which asks Gemini to
   read the name + bottom-left collector number/set/language -> resolve the exact
   printing from Scryfall -> confirm/correct -> add -> export.
   List/export logic is carried over from the earlier version unchanged. */

"use strict";

const $ = (id) => document.getElementById(id);
const SCRYFALL = "https://api.scryfall.com";
const LANGS = ["en", "ja", "de", "fr", "it", "es", "pt", "ru", "ko", "zhs", "zht"];

const video = $("video");
const frameCanvas = $("frameCanvas");
const cropCanvas = document.createElement("canvas");

let stream = null;
let currentCard = null;   // resolved Scryfall card object to add
let prints = [];          // printings of the current card (for the picker)
let collected = [];

const setStatus = (m) => { $("status").textContent = m; };

// ---------- config ----------
// Hosted public tool: the Worker URL + app token ship with the app so anyone can scan out of
// the box. The token is NOT a secret (it's public here by design and only gates the Worker,
// which holds the real Gemini key server-side).
const WORKER_URL = "https://mtgcardscanner.amirmag1851.workers.dev";
const APP_TOKEN = "0c415ef93e153b9959314db675a064e9";
const getWorkerUrl = () => WORKER_URL.replace(/\/+$/, "");
const getToken = () => APP_TOKEN;

// ---------- camera ----------
$("startBtn").addEventListener("click", async () => {
  try {
    setStatus("Requesting camera…");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    $("startBtn").textContent = "Camera on";
    $("startBtn").disabled = true;
    $("captureBtn").disabled = false;
    setStatus("Fit the whole card in the box and Capture.");
  } catch (err) {
    setStatus("Camera error: " + err.message + " (allow camera access; needs HTTPS)");
  }
});

// ---------- capture -> Worker /identify ----------
$("captureBtn").addEventListener("click", () => {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) { setStatus("Camera not ready."); return; }

  frameCanvas.width = vw; frameCanvas.height = vh;
  frameCanvas.getContext("2d").drawImage(video, 0, 0, vw, vh);

  // map the card guide box back to source pixels through object-fit: cover
  const stage = document.querySelector(".stage");
  const sRect = stage.getBoundingClientRect();
  const bRect = document.querySelector(".cardbox").getBoundingClientRect();
  const fx = (bRect.left - sRect.left) / sRect.width, fy = (bRect.top - sRect.top) / sRect.height;
  const fw = bRect.width / sRect.width, fh = bRect.height / sRect.height;
  const stageAR = sRect.width / sRect.height, vidAR = vw / vh;
  let visW = 1, visH = 1, cropX = 0, cropY = 0;
  if (vidAR >= stageAR) { visW = stageAR / vidAR; cropX = (1 - visW) / 2; }
  else { visH = vidAR / stageAR; cropY = (1 - visH) / 2; }
  const sx = Math.round((cropX + fx * visW) * vw), sy = Math.round((cropY + fy * visH) * vh);
  const sw = Math.round(fw * visW * vw), sh = Math.round(fh * visH * vh);

  // downscale so the longest side is <= 1024 (keeps Gemini tokens/cost low)
  const scale = Math.min(1, 1024 / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
  cropCanvas.width = dw; cropCanvas.height = dh;
  cropCanvas.getContext("2d").drawImage(frameCanvas, sx, sy, sw, sh, 0, 0, dw, dh);

  const prev = $("capPreview");
  prev.width = dw; prev.height = dh;
  prev.getContext("2d").drawImage(cropCanvas, 0, 0);
  prev.style.display = "block";

  setStatus("Identifying…");
  document.body.classList.add("scanning");
  $("captureBtn").disabled = true;
  cropCanvas.toBlob((blob) => identify(blob), "image/jpeg", 0.8);
});

async function identify(blob) {
  try {
    const r = await fetch(getWorkerUrl() + "/identify", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", "x-app-token": getToken() },
      body: blob,
    });
    const j = await r.json();
    if (!r.ok || j.error) { setStatus("Identify failed: " + (j.error || r.status)); return; }
    await handleRead(j);
  } catch (e) {
    setStatus("Couldn't reach the scanner service: " + e.message + " (check your connection).");
  } finally {
    document.body.classList.remove("scanning");
    $("captureBtn").disabled = false;
  }
}

// ---------- resolve what Gemini read into an exact Scryfall printing ----------
async function handleRead(read) {
  const readStr = [read.name, read.set_code && `[${read.set_code.toUpperCase()} #${read.collector_number || "?"}]`,
    read.language && read.language !== "en" ? read.language.toUpperCase() : null]
    .filter(Boolean).join(" ");
  $("candRead").textContent = "Read: " + (readStr || "—") +
    (read.confidence != null ? ` (~${Math.round(read.confidence * 100)}%)` : "");
  $("searchInput").value = read.name || "";

  let card = null;
  if (read.set_code && read.collector_number) {
    card = await scryExact(read.set_code, read.collector_number, read.language);
  }
  if (!card && read.name) card = await scryNamed(read.name);
  if (!card) { setStatus("Couldn't resolve that card. Try Search by name."); showCandidate(null); return; }

  await setCurrentCard(card, read.foil);
  setStatus(`Identified: ${card.name}. Confirm printing/language, then Add.`);
}

async function scryGet(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.object === "error" ? null : j;
  } catch {
    return null;
  }
}
const scryExact = (set, num, lang) => {
  const base = `${SCRYFALL}/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(num)}`;
  return scryGet(lang && lang !== "en" ? `${base}/${lang}` : base).then((c) => c || scryGet(base));
};
const scryNamed = (name) => scryGet(`${SCRYFALL}/cards/named?fuzzy=${encodeURIComponent(name)}`);

// ---------- candidate + printing/language picker ----------
async function setCurrentCard(card, foilGuess) {
  currentCard = card;
  renderCandidate(card);
  await loadPrints(card);
  const finishes = card.finishes || [];
  const canFoil = finishes.includes("foil") || finishes.includes("etched");
  $("foilChk").disabled = !canFoil;
  $("foilChk").checked = canFoil && !!foilGuess;
  $("addBtn").disabled = false;
}

function cardImg(card) {
  return card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || "";
}

function renderCandidate(card) {
  $("candidate").style.display = "flex";
  if (!card) {
    $("candImg").removeAttribute("src");
    $("candName").textContent = "—";
    $("candSub").textContent = "No confirmed match yet.";
    $("addBtn").disabled = true;
    return;
  }
  $("candImg").src = cardImg(card);
  $("candName").textContent = card.name;
  $("candSub").textContent =
    `${card.set_name} (${(card.set || "").toUpperCase()}) · #${card.collector_number} · ${(card.lang || "en").toUpperCase()} · ${card.rarity || ""}`;
}

async function loadPrints(card) {
  prints = [];
  if (card.prints_search_uri) {
    const j = await scryGet(card.prints_search_uri);
    prints = (j && j.data) || [];
  }
  if (!prints.length) prints = [card];

  // language options (fixed common set); printing options come from prints list
  const langSel = $("langSelect");
  langSel.innerHTML = "";
  LANGS.forEach((l) => {
    const o = document.createElement("option");
    o.value = l; o.textContent = l.toUpperCase();
    langSel.appendChild(o);
  });
  langSel.value = LANGS.includes(card.lang) ? card.lang : "en";

  const pSel = $("printingSelect");
  pSel.innerHTML = "";
  prints.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${(p.set || "").toUpperCase()} #${p.collector_number} · ${p.set_name}`;
    pSel.appendChild(o);
  });
  const idx = prints.findIndex((p) => p.id === card.id);
  pSel.value = String(idx >= 0 ? idx : 0);
}

async function onPickerChange() {
  const p = prints[parseInt($("printingSelect").value, 10)] || currentCard;
  const lang = $("langSelect").value;
  setStatus("Loading printing…");
  const card = (await scryExact(p.set, p.collector_number, lang)) || p;
  currentCard = card;
  renderCandidate(card);
  const finishes = card.finishes || [];
  $("foilChk").disabled = !(finishes.includes("foil") || finishes.includes("etched"));
  if ($("foilChk").disabled) $("foilChk").checked = false;
  setStatus(`${card.name} — ${(card.set || "").toUpperCase()} #${card.collector_number} [${(card.lang || "en").toUpperCase()}].`);
}
$("langSelect").addEventListener("change", onPickerChange);
$("printingSelect").addEventListener("change", onPickerChange);

// ---------- manual name search fallback (Scryfall) ----------
$("searchBtn").addEventListener("click", doSearch);
$("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

async function doSearch() {
  const q = $("searchInput").value.trim();
  if (!q) return;
  setStatus("Searching…");
  const j = await scryGet(`${SCRYFALL}/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=released`);
  const results = (j && j.data) || [];
  if (!results.length) { setStatus("No cards found for that name."); return; }
  await setCurrentCard(results[0]);
  renderSuggestions(results.slice(1, 6));
  setStatus(`Found: ${results[0].name}. Confirm or pick an alternative.`);
}

function renderSuggestions(list) {
  const box = $("suggestions");
  box.innerHTML = "";
  if (!list || !list.length) { box.style.display = "none"; return; }
  const lbl = document.createElement("span");
  lbl.textContent = "Or:";
  lbl.style.cssText = "font-size:13px;color:#9aa2b5;align-self:center;";
  box.appendChild(lbl);
  list.forEach((c) => {
    const b = document.createElement("button");
    b.className = "secondary"; b.style.cssText = "font-size:12px;padding:5px 9px;";
    b.textContent = `${c.name} (${(c.set || "").toUpperCase()})`;
    b.addEventListener("click", async () => {
      await setCurrentCard(c);
      renderSuggestions(list.filter((x) => x.id !== c.id));
      setStatus(`Selected: ${c.name}. Confirm below.`);
    });
    box.appendChild(b);
  });
  box.style.display = "flex";
}

function showCandidate(card) { renderCandidate(card); if (!card) { prints = []; currentCard = null; } }

// ---------- collected list ----------
$("addBtn").addEventListener("click", () => {
  if (!currentCard) return;
  const foil = $("foilChk").checked;
  const qty = Math.max(1, parseInt($("qtyInput").value, 10) || 1);
  const c = { id: currentCard.id, name: currentCard.name, set: currentCard.set,
    set_name: currentCard.set_name, collector_number: currentCard.collector_number,
    rarity: currentCard.rarity, lang: currentCard.lang || "en", img: cardImg(currentCard) };
  const ex = collected.find((e) => e.card.id === c.id && e.foil === foil);
  if (ex) ex.qty += qty;
  else collected.push({ qty, foil, card: c });
  renderList();
  setStatus(`Added ${qty}× ${c.name}${foil ? " (foil)" : ""} [${(c.lang || "en").toUpperCase()}].`);
  $("candidate").style.display = "none";
  $("suggestions").style.display = "none";
  currentCard = null; prints = [];
});

function renderList() {
  hideSetTip();
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
      `<td class="thumb">${e.card.img ? `<img src="${escapeHtml(e.card.img)}" alt="" loading="lazy" />` : ""}</td>` +
      `<td class="num">${e.qty}</td>` +
      `<td>${escapeHtml(e.card.name)}</td>` +
      `<td class="setcell"><span class="settag" tabindex="0" data-setname="${escapeHtml(e.card.set_name || "")}" aria-label="Set: ${escapeHtml(e.card.set_name || (e.card.set || "").toUpperCase())}">${(e.card.set || "").toUpperCase()} #${escapeHtml(e.card.collector_number)}</span></td>` +
      `<td>${(e.card.lang || "en").toUpperCase()}</td>` +
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

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- set-name tooltip (hover on desktop, tap/focus on mobile) ----------
// One floating bubble appended to <body> so it escapes the list's overflow clipping;
// its position is computed from the trigger's rect each time it's shown.
let setTipEl = null;
function hideSetTip() { if (setTipEl) setTipEl.classList.remove("show"); }
function showSetTip(tag) {
  const name = tag.dataset.setname;
  if (!name) return;
  if (!setTipEl) {
    setTipEl = document.createElement("div");
    setTipEl.className = "settip";
    document.body.appendChild(setTipEl);
  }
  setTipEl.textContent = name;
  setTipEl.classList.add("show");
  const r = tag.getBoundingClientRect();
  const tw = setTipEl.offsetWidth, th = setTipEl.offsetHeight;
  let left = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
  let top = r.top - th - 8;
  if (top < 6) top = r.bottom + 8;   // flip below if there's no room above
  setTipEl.style.left = Math.round(left) + "px";
  setTipEl.style.top = Math.round(top) + "px";
}
(function wireSetTip() {
  const tb = $("tbody");
  tb.addEventListener("mouseover", (e) => { const t = e.target.closest(".settag"); if (t) showSetTip(t); });
  tb.addEventListener("mouseout", (e) => { if (e.target.closest(".settag")) hideSetTip(); });
  tb.addEventListener("focusin", (e) => { const t = e.target.closest(".settag"); if (t) showSetTip(t); });
  tb.addEventListener("focusout", hideSetTip);
  tb.addEventListener("click", (e) => { const t = e.target.closest(".settag"); if (t) { e.stopPropagation(); showSetTip(t); } });
  document.addEventListener("click", hideSetTip);
  window.addEventListener("scroll", hideSetTip, true);
})();

// ---------- exports (carried over unchanged) ----------
document.querySelectorAll(".exports button").forEach((b) =>
  b.addEventListener("click", () => exportAs(b.dataset.fmt)));

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

function exportAs(fmt) {
  if (collected.length === 0) { setStatus("Nothing to export yet."); return; }
  let text, filename, mime = "text/csv";

  if (fmt === "manabox") {
    const header = ["Name", "Set code", "Set name", "Collector number", "Foil", "Rarity", "Quantity", "Scryfall ID", "Condition", "Language"];
    const rows = collected.map((e) => [e.card.name, e.card.set, e.card.set_name, e.card.collector_number,
      e.foil ? "foil" : "normal", e.card.rarity, e.qty, e.card.id, "near_mint", e.card.lang]);
    text = toCSV([header, ...rows]); filename = "collection_manabox.csv";

  } else if (fmt === "moxfield") {
    const header = ["Count", "Name", "Edition", "Condition", "Language", "Foil", "Collector Number"];
    const rows = collected.map((e) => [e.qty, e.card.name, e.card.set, "Near Mint", e.card.lang, e.foil ? "foil" : "", e.card.collector_number]);
    text = toCSV([header, ...rows]); filename = "collection_moxfield.csv";

  } else if (fmt === "archidekt") {
    const header = ["Quantity", "Name", "Finish", "Condition", "Edition Code", "Collector Number", "Scryfall ID"];
    const rows = collected.map((e) => [e.qty, e.card.name, e.foil ? "Foil" : "Normal", "NM", e.card.set, e.card.collector_number, e.card.id]);
    text = toCSV([header, ...rows]); filename = "collection_archidekt.csv";

  } else if (fmt === "deckbox") {
    const header = ["Count", "Name", "Edition", "Card Number", "Condition", "Language", "Foil"];
    const rows = collected.map((e) => [e.qty, e.card.name, e.card.set_name, e.card.collector_number, "Near Mint", e.card.lang, e.foil ? "foil" : ""]);
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

// ---------- init ----------
renderList();
