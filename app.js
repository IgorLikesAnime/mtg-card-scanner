/* MTG Card Scanner — set-locked perceptual-hash recognition.
   Pick a set -> download+hash its card artworks (once, cached) -> match a camera
   shot against them by image (dHash+aHash Hamming distance). No OCR, language-
   independent. Data & images from Scryfall (CDN sends CORS, so canvas hashing
   works client-side). List/export logic unchanged from earlier versions. */

"use strict";

const $ = (id) => document.getElementById(id);
const video = $("video");
const frameCanvas = $("frameCanvas");
const SCRYFALL = "https://api.scryfall.com";

let stream = null;
let candidate = null;
let collected = [];
let ALL_SETS = [];
let refCards = [];        // [{id,name,set,collector_number,rarity,small,hash:Uint8Array}]
let currentSetName = "";

const setStatus = (m) => { $("status").textContent = m; };
const setSetStatus = (m) => { $("setStatus").textContent = m; };
const showBar = (on) => { $("learnBar").style.display = on ? "block" : "none"; if (!on) setFill(0); };
const setFill = (f) => { $("learnFill").style.width = Math.round(f * 100) + "%"; };

// ---------- camera ----------
$("startBtn").addEventListener("click", async () => {
  try {
    setStatus("Requesting camera…");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await reduceExposure(stream);
    $("startBtn").textContent = "Camera on";
    $("startBtn").disabled = true;
    if (refCards.length) { $("captureBtn").disabled = false; setStatus("Fill the box with a card's artwork and Capture."); }
    else setStatus("Camera on. Now load a set to match against.");
  } catch (err) {
    setStatus("Camera error: " + err.message + " (allow camera access, use https / localhost)");
  }
});

async function reduceExposure(stream) {
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    const adv = [];
    const lower = (c) => Math.round(c.min + (c.max - c.min) * 0.33);
    if (caps.brightness) adv.push({ brightness: lower(caps.brightness) });
    if (caps.exposureMode?.includes?.("continuous")) adv.push({ exposureMode: "continuous" });
    if (adv.length) await track.applyConstraints({ advanced: adv });
  } catch { /* unsupported */ }
}

// ---------- perceptual hashing (dHash 8x8 + aHash 8x8 = 128 bits) ----------
const hc = document.createElement("canvas");
const hctx = hc.getContext("2d", { willReadFrequently: true });

function grayResize(src, sx, sy, sw, sh, w, h) {
  hc.width = w; hc.height = h;
  hctx.imageSmoothingEnabled = true;
  hctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const d = hctx.getImageData(0, 0, w, h).data;
  const g = new Float64Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}

function hashRegion(src, sx, sy, sw, sh) {
  const dg = grayResize(src, sx, sy, sw, sh, 9, 8); // dHash source
  const ag = grayResize(src, sx, sy, sw, sh, 8, 8); // aHash source
  const bits = new Uint8Array(16);
  let bit = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    if (dg[y * 9 + x] < dg[y * 9 + x + 1]) bits[bit >> 3] |= (1 << (bit & 7));
    bit++;
  }
  let mean = 0; for (let i = 0; i < 64; i++) mean += ag[i]; mean /= 64;
  for (let i = 0; i < 64; i++) { if (ag[i] >= mean) bits[bit >> 3] |= (1 << (bit & 7)); bit++; }
  return bits;
}

const POP = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1]; return t; })();
function hamming(a, b) { let d = 0; for (let i = 0; i < 16; i++) d += POP[a[i] ^ b[i]]; return d; }
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => { const b = new Uint8Array(16); for (let i = 0; i < 16; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; };

function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("image load failed"));
    im.src = url;
  });
}

// ---------- set list + learning ----------
async function loadSetList() {
  try {
    const data = (await fetch(`${SCRYFALL}/sets`).then((r) => r.json())).data || [];
    const keep = new Set(["core", "expansion", "masters", "draft_innovation", "commander",
      "masterpiece", "funny", "starter", "box", "duel_deck", "from_the_vault",
      "premium_deck", "planechase", "archenemy", "spellbook", "arsenal", "alchemy"]);
    ALL_SETS = data.filter((s) => s.card_count > 0 && keep.has(s.set_type) && !s.digital)
      .sort((a, b) => (b.released_at || "").localeCompare(a.released_at || ""));
    const dl = $("setList");
    dl.innerHTML = "";
    ALL_SETS.forEach((s) => {
      const o = document.createElement("option");
      o.value = `${s.name} (${s.code.toUpperCase()})`;
      dl.appendChild(o);
    });
    setSetStatus(`Loaded ${ALL_SETS.length} sets. Type a set name or code, then Load set.`);
  } catch (e) {
    setSetStatus("Couldn't load set list: " + e.message);
  }
}

function resolveSet(text) {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const paren = t.match(/\(([^)]+)\)\s*$/);
  if (paren) { const s = ALL_SETS.find((x) => x.code.toLowerCase() === paren[1].toLowerCase()); if (s) return s; }
  return ALL_SETS.find((x) => x.code.toLowerCase() === t)
      || ALL_SETS.find((x) => x.name.toLowerCase() === t)
      || ALL_SETS.find((x) => x.name.toLowerCase().startsWith(t))
      || null;
}

async function learnSet(set) {
  currentSetName = set.name;
  $("captureBtn").disabled = true;
  const key = "hashset_" + set.code + "_v2";
  const cached = localStorage.getItem(key);
  if (cached) {
    refCards = JSON.parse(cached).map((c) => ({ ...c, hash: fromHex(c.hashHex) }));
    onSetReady(set, true);
    return;
  }
  setSetStatus(`Fetching ${set.name} card list…`);
  let url = `${SCRYFALL}/cards/search?q=${encodeURIComponent("set:" + set.code)}&unique=prints&order=set`;
  const list = [];
  try {
    while (url) {
      const j = await fetch(url).then((r) => r.json());
      for (const c of j.data || []) {
        const u = c.image_uris || c.card_faces?.[0]?.image_uris;
        if (u?.art_crop) list.push({ id: c.id, name: c.name, set: c.set, collector_number: c.collector_number, rarity: c.rarity, art: u.art_crop, small: u.small });
      }
      url = j.has_more ? j.next_page : null;
    }
  } catch (e) { setSetStatus("Set fetch failed: " + e.message); return; }

  showBar(true);
  refCards = [];
  for (let i = 0; i < list.length; i++) {
    setFill(i / list.length);
    setSetStatus(`Learning ${set.name}: ${i + 1}/${list.length}…`);
    try {
      const img = await loadImg(list[i].art);
      const h = hashRegion(img, 0, 0, img.naturalWidth, img.naturalHeight);
      refCards.push({ id: list[i].id, name: list[i].name, set: list[i].set, collector_number: list[i].collector_number, rarity: list[i].rarity, small: list[i].small, hash: h, hashHex: toHex(h) });
    } catch { /* skip unreadable image */ }
  }
  showBar(false);
  try {
    localStorage.setItem(key, JSON.stringify(refCards.map((c) =>
      ({ id: c.id, name: c.name, set: c.set, collector_number: c.collector_number, rarity: c.rarity, small: c.small, hashHex: c.hashHex }))));
  } catch { /* quota — keep in memory for this session */ }
  onSetReady(set, false);
}

function onSetReady(set, cached) {
  setSetStatus(`✅ ${set.name} ready — ${refCards.length} cards${cached ? " (cached)" : ""}.`);
  if (stream) { $("captureBtn").disabled = false; setStatus("Fill the box with a card's artwork and Capture."); }
  else setStatus("Set ready. Start the camera to scan.");
}

$("loadSetBtn").addEventListener("click", () => {
  const s = resolveSet($("setInput").value);
  if (!s) { setSetStatus("Set not found — pick one from the list."); return; }
  learnSet(s);
});
$("setInput").addEventListener("change", () => {
  const s = resolveSet($("setInput").value);
  if (s) learnSet(s);
});

// ---------- capture + match ----------
$("captureBtn").addEventListener("click", () => {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) { setStatus("Camera not ready."); return; }
  if (!refCards.length) { setStatus("Load a set first."); return; }

  frameCanvas.width = vw; frameCanvas.height = vh;
  frameCanvas.getContext("2d").drawImage(video, 0, 0, vw, vh);

  // map the art box element back to source pixels through object-fit: cover
  const stage = document.querySelector(".stage");
  const sRect = stage.getBoundingClientRect();
  const aRect = document.querySelector(".artbox").getBoundingClientRect();
  const fx = (aRect.left - sRect.left) / sRect.width, fy = (aRect.top - sRect.top) / sRect.height;
  const fw = aRect.width / sRect.width, fh = aRect.height / sRect.height;
  const stageAR = sRect.width / sRect.height, vidAR = vw / vh;
  let visW = 1, visH = 1, cropX = 0, cropY = 0;
  if (vidAR >= stageAR) { visW = stageAR / vidAR; cropX = (1 - visW) / 2; }
  else { visH = vidAR / stageAR; cropY = (1 - visH) / 2; }
  const sx = Math.round((cropX + fx * visW) * vw), sy = Math.round((cropY + fy * visH) * vh);
  const sw = Math.round(fw * visW * vw), sh = Math.round(fh * visH * vh);

  const prev = $("capPreview");
  prev.width = sw; prev.height = sh;
  prev.getContext("2d").drawImage(frameCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  prev.style.display = "block";

  const h = hashRegion(frameCanvas, sx, sy, sw, sh);
  const scored = refCards.map((c) => [hamming(h, c.hash), c]).sort((a, b) => a[0] - b[0]);
  const [dist, best] = scored[0];
  const conf = Math.max(0, Math.round((1 - dist / 128) * 100));
  showCandidate(cardFromRef(best));
  renderSuggestions(scored.slice(1, 6).map(([, c]) => ({ name: c.name })));
  setStatus(`Match: ${best.name} (~${conf}%). Wrong? Pick an alternative or search by name.`);
});

function cardFromRef(rc) {
  return {
    id: rc.id, name: rc.name, set: rc.set, set_name: currentSetName,
    collector_number: rc.collector_number, rarity: rc.rarity,
    lang: $("langSelect").value, image_uris: { small: rc.small },
  };
}

// ---------- manual name fallback (fuzzy over the loaded set's names) ----------
$("searchBtn").addEventListener("click", () => {
  const q = $("searchInput").value.trim();
  if (q) searchByName(q);
});

function searchByName(query) {
  if (!refCards.length) { setStatus("Load a set first."); return; }
  const matches = bestMatches(cleanName(query), refCards.map((c) => c.name));
  if (!matches.length) { showCandidate(null); renderSuggestions([]); setStatus("No matching name in this set."); return; }
  const rc = refCards.find((c) => c.name === matches[0].name);
  showCandidate(cardFromRef(rc));
  renderSuggestions(matches.slice(1).map((m) => ({ name: m.name })));
  setStatus(`Name match: ${matches[0].name}. Confirm or pick an alternative.`);
}

function cleanName(text) {
  const toks = text.replace(/[^A-Za-z',\- ]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  while (toks.length > 1 && toks[0].length === 1) toks.shift();
  while (toks.length > 1 && toks[toks.length - 1].length === 1) toks.pop();
  return toks.join(" ");
}

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1); cur[0] = i;
    const ac = a.charCodeAt(i - 1); let best = i;
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

function bestMatches(query, names, k = 6) {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return [];
  const qTokens = q.split(" ").filter(Boolean);
  const maxD = Math.max(2, Math.ceil(q.length * 0.5));
  const top = [];
  for (const name of names) {
    const n = name.toLowerCase();
    const lenClose = Math.abs(n.length - q.length) <= maxD;
    const overlap = qTokens.some((t) => t.length >= 3 && n.includes(t));
    if (!lenClose && !overlap) continue;
    const d = lev(q, n, lenClose ? maxD : Math.max(q.length, n.length));
    let sim = 1 - d / Math.max(q.length, n.length);
    if (n === q) sim = 1;
    else if (qTokens.every((t) => n.split(" ").includes(t))) sim = Math.max(sim, 0.7 + 0.3 * sim);
    if (sim < 0.35 || (!overlap && sim < 0.7)) continue;
    const score = 1 - sim;
    if (top.length < k) { top.push({ name, score }); top.sort((a, b) => a.score - b.score); }
    else if (score < top[k - 1].score) { top[k - 1] = { name, score }; top.sort((a, b) => a.score - b.score); }
  }
  return top;
}

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
    b.className = "secondary"; b.style.cssText = "font-size:12px;padding:5px 9px;";
    b.textContent = m.name;
    b.addEventListener("click", () => {
      const rc = refCards.find((c) => c.name === m.name);
      if (!rc) return;
      $("searchInput").value = m.name;
      showCandidate(cardFromRef(rc));
      renderSuggestions(list.filter((x) => x.name !== m.name));
      setStatus(`Selected: ${m.name}. Confirm below.`);
    });
    box.appendChild(b);
  });
  box.style.display = "flex";
}

// ---------- candidate ----------
function renderCandidateInfo(card) {
  $("candImg").src = card.image_uris?.small || "";
  $("candName").textContent = card.name;
  $("candSub").textContent = `${card.set_name} (${(card.set || "").toUpperCase()}) · #${card.collector_number} · ${card.rarity}`;
}

function showCandidate(card) {
  candidate = card;
  $("candidate").style.display = "flex";
  if (!card) {
    $("candImg").removeAttribute("src");
    $("candName").textContent = "—";
    $("candSub").textContent = "No confirmed match yet.";
    $("addBtn").disabled = true;
    return;
  }
  renderCandidateInfo(card);
  $("foilChk").checked = false;
  $("qtyInput").value = 1;
  $("addBtn").disabled = false;
}

// ---------- collected list ----------
$("addBtn").addEventListener("click", () => {
  if (!candidate) return;
  const foil = $("foilChk").checked;
  const lang = $("langSelect").value;
  const qty = Math.max(1, parseInt($("qtyInput").value, 10) || 1);
  const c = { id: candidate.id, name: candidate.name, set: candidate.set, set_name: candidate.set_name,
    collector_number: candidate.collector_number, rarity: candidate.rarity, lang };
  const ex = collected.find((e) => e.card.id === c.id && e.foil === foil && e.card.lang === lang);
  if (ex) ex.qty += qty;
  else collected.push({ qty, foil, card: c });
  renderList();
  setStatus(`Added ${qty}× ${c.name}${foil ? " (foil)" : ""}${lang !== "en" ? " [" + lang.toUpperCase() + "]" : ""}.`);
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

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- exports ----------
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
loadSetList();
