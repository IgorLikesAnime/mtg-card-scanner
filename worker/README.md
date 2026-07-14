# Gemini vision proxy (Cloudflare Worker)

This tiny Worker holds your Gemini API key and forwards card photos to Google Gemini,
returning structured JSON. It exists so the key never ships to the browser and so the
browser→Gemini CORS problem disappears.

## One-time setup

1. **Get a Gemini API key** at <https://aistudio.google.com/apikey>. **Set a spending/budget
   cap while you're there** — if you make the app public, every visitor's scan spends this
   key, so the budget cap is your hard ceiling on cost. The default model is
   `gemini-flash-latest` (override with the `GEMINI_MODEL` var).
2. **Install Wrangler & log in:**
   ```bash
   npm install -g wrangler
   wrangler login
   ```
3. **Pick an app token** — any random string (e.g. `openssl rand -hex 16`). The app must
   send this, so it's a simple abuse gate on the public Worker URL.
4. **Set the origin** — edit `ALLOWED_ORIGIN` in `wrangler.toml` to your GitHub Pages origin
   (no trailing slash), e.g. `https://igorlikesanime.github.io`.
5. **Deploy & set secrets:**
   ```bash
   cd worker
   wrangler deploy
   wrangler secret put GEMINI_API_KEY   # paste your Gemini key
   wrangler secret put APP_TOKEN        # paste the same token you'll enter in the app
   ```
   `wrangler deploy` prints your Worker URL, e.g.
   `https://mtg-scanner-vision.<you>.workers.dev`.

6. In the web app's **Settings**, paste that **Worker URL** and the **App token**. (If you're
   shipping the app publicly, hardcode these as `DEFAULT_WORKER_URL` / `DEFAULT_APP_TOKEN` in
   `app.js` instead so visitors don't have to enter anything.)

## Rate limiting (recommended for a public URL)

Because a public app spends *your* Gemini quota, cap how fast one client can hit `/identify`.
The Worker uses a **`RATE_LIMITER`** binding if present and safely falls back to the Gemini
budget cap if it's absent — so this is optional but recommended.

- **wrangler:** already configured in `wrangler.toml` under `[[ratelimits]]` (15 requests /
  60s per IP). Adjust `limit` / `period` (period must be `10` or `60`) to taste.
- **Cloudflare dashboard:** Worker → **Settings → Bindings → Add → Rate limiting**, name it
  `RATE_LIMITER`, set limit `15`, period `60`, then redeploy.

The token gate and origin check are only speed bumps once the app is public (the token ships in
the page and the `Origin` header can be spoofed), so the budget cap + rate limit are what
actually bound abuse.

## Local testing

```bash
cd worker
printf 'GEMINI_API_KEY="…"\nAPP_TOKEN="test"\nALLOWED_ORIGIN=""\n' > .dev.vars   # gitignored
wrangler dev
# in another shell:
curl -s -X POST http://localhost:8787/identify \
  -H "x-app-token: test" -H "Content-Type: image/jpeg" \
  --data-binary @some-card.jpg | jq
curl -s http://localhost:8787/health
```

(`ALLOWED_ORIGIN=""` disables the origin check for local curl; keep it set in production.)

## API

- `POST /identify` — body: raw JPEG bytes; header `x-app-token: <APP_TOKEN>`.
  Returns `{ name, set_code?, collector_number?, language?, foil?, confidence? }`.
- `GET /health` — `{ ok: true }`.

Secrets (`GEMINI_API_KEY`, `APP_TOKEN`) live only in Cloudflare, never in git.
