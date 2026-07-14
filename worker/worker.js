/* MTG Card Scanner — Cloudflare Worker (Gemini vision proxy).
 *
 * The GitHub Pages app posts a card photo here; this Worker calls Google Gemini
 * to read the card and returns structured JSON. The Gemini API key lives ONLY as
 * a Worker secret — it never reaches the browser — and this server-to-server call
 * sidesteps the browser->Gemini CORS problem entirely.
 *
 * Secrets / vars (set with `wrangler secret put` or in the dashboard):
 *   GEMINI_API_KEY  (secret)  - your Google AI Studio key
 *   APP_TOKEN       (secret)  - shared token the app must send (abuse gate)
 *   ALLOWED_ORIGIN  (var)     - your Pages origin, e.g. https://you.github.io
 *   GEMINI_MODEL    (var)     - optional, defaults to gemini-flash-latest
 *   RATE_LIMITER    (binding) - optional Workers Rate Limiting binding for per-IP abuse
 *                               control (see wrangler.toml). Treated as optional: if absent,
 *                               the Gemini budget cap is the hard spend backstop.
 *
 * Endpoints:
 *   OPTIONS *          -> CORS preflight
 *   GET  /health       -> { ok: true }
 *   POST /identify     -> body: raw JPEG bytes; header x-app-token
 *                         returns { name, set_code, collector_number, language, foil, confidence }
 */

const PROMPT = `You are identifying ONE Magic: The Gathering card from a photo.
Read exactly what is printed on the card. Return JSON with:
- name: the card's printed title (top of the card).
- set_code: the 3-5 letter set code from the bottom-left info line, lowercase (e.g. "mh3"). Omit if not legible.
- collector_number: the collector number from the bottom-left, e.g. from "0123/281" return "123" (drop leading zeros and the total). Omit if not legible.
- language: the language of the printed text as a Scryfall code: en, ja, de, fr, it, es, pt, ru, ko, zhs, zht. Default "en".
- foil: true only if the card is clearly foil/holographic.
- confidence: 0-1, your certainty about the name.
Only output the JSON object.`;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    set_code: { type: "string" },
    collector_number: { type: "string" },
    language: { type: "string" },
    foil: { type: "boolean" },
    confidence: { type: "number" },
  },
  required: ["name"],
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-app-token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = env.ALLOWED_ORIGIN || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowed || origin) });
    }
    if (url.pathname === "/health") {
      // `ratelimit` reflects whether the RATE_LIMITER binding is visible to this code —
      // handy for confirming a deploy picked up both the new code and the binding.
      return json({ ok: true, ratelimit: !!env.RATE_LIMITER }, 200, allowed || origin);
    }
    if (url.pathname !== "/identify" || request.method !== "POST") {
      return json({ error: "not found" }, 404, allowed || origin);
    }

    // --- abuse gate: only our Pages origin, and only with the shared token ---
    if (allowed && origin && origin !== allowed) {
      return json({ error: "forbidden origin" }, 403, allowed);
    }
    if (!env.APP_TOKEN || request.headers.get("x-app-token") !== env.APP_TOKEN) {
      return json({ error: "unauthorized" }, 401, allowed || origin);
    }

    // --- per-IP rate limit (best-effort; the Gemini budget cap is the hard backstop) ---
    // Active only when a RATE_LIMITER binding is configured, so a dashboard-only deploy that
    // skips the binding still works — protected by the budget cap. See wrangler.toml.
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return json({ error: "rate limited — too many scans, wait a moment and retry" }, 429, allowed || origin);
      }
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "server not configured (no GEMINI_API_KEY)" }, 500, allowed || origin);
    }

    // --- read the posted image ---
    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 6 * 1024 * 1024) {
      return json({ error: "bad image size" }, 400, allowed || origin);
    }
    const b64 = arrayBufferToBase64(buf);
    const mime = request.headers.get("Content-Type") || "image/jpeg";

    // --- call Gemini ---
    const model = env.GEMINI_MODEL || "gemini-flash-latest";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
    };

    let gRes;
    try {
      gRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: "gemini fetch failed: " + e.message }, 502, allowed || origin);
    }
    if (!gRes.ok) {
      const detail = await gRes.text();
      return json({ error: "gemini error " + gRes.status, detail: detail.slice(0, 500) }, 502, allowed || origin);
    }

    const data = await gRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return json({ error: "no result from gemini" }, 502, allowed || origin);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "unparseable gemini output", raw: text.slice(0, 500) }, 502, allowed || origin);
    }
    return json(parsed, 200, allowed || origin);
  },
};
