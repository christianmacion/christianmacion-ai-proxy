# DEPLOY.md : christianmacion-ai-proxy

> 5 copy-paste steps to ship the Worker. Each step has a verify check before moving on.

## Pre-flight

```bash
# Confirm you are in the repo root
pwd   # should print .../christianmacion-ai-proxy

# Confirm the AI binding + model are referenced
grep -E 'AI|MODEL_ID' wrangler.toml
# expected: [[ai]] binding = "AI", MODEL_ID = "@cf/meta/llama-3.1-8b-instruct"
```

The KV id placeholder (`REPLACE_WITH_KV_NAMESPACE_ID` in `wrangler.toml`) is intentional.
Step 1 creates the namespace and Step 2 swaps the id.

---

## Step 1 — Create the KV namespace

```bash
npx wrangler kv namespace create RATE_LIMIT
```

Wrangler prints JSON:

```json
{
  "id": "abcd1234ef567890abcdef1234567890",
  "title": "RATE_LIMIT"
}
```

Copy the `id` value. You will paste it into `wrangler.toml` in Step 2.

**Verify**

```bash
# (optional) list namespaces to confirm
npx wrangler kv namespace list
# expected: includes RATE_LIMIT with the new id
```

---

## Step 2 — Paste the KV id into wrangler.toml

Open `wrangler.toml` in your editor. Replace:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

with:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "abcd1234ef567890abcdef1234567890"   # paste your real id
```

**Verify**

```bash
grep -A1 'RATE_LIMIT' wrangler.toml
# expected: id = "<32 hex chars>", no REPLACE_WITH placeholder
```

---

## Step 3 — Create the GitHub repo and add the remote

The Worker is in `~/Contingency/christianmacion-ai-proxy/` but it has no git remote
yet (per the 2026-08-10 AAR, Owner-owed).

```bash
# 3a. Create the empty repo on GitHub (gh CLI)
gh repo create christianmacion/christianmacion-ai-proxy \
  --public \
  --description "Edge AI gateway for the Christian T. Macion portfolio. Llama 3.1 8B on Workers AI, 20/day per-IP rate limit, origin allowlist." \
  --homepage https://christianmacion.github.io

# 3b. Add the remote and push main
cd ~/Contingency/christianmacion-ai-proxy
git remote add origin https://github.com/christianmacion/christianmacion-ai-proxy.git
git branch -M main
git push -u origin main
```

If `gh repo create` is not authenticated, do it manually:

1. Open <https://github.com/new>
2. Repository name: `christianmacion-ai-proxy`
3. Public, no README / .gitignore / license (we have them locally)
4. Click "Create repository"
5. Then run only the `git remote add origin ...` + `git push -u origin main` block above.

**Verify**

```bash
git remote -v
# expected: origin  https://github.com/christianmacion/christianmacion-ai-proxy.git (fetch + push)
git ls-remote origin main
# expected: prints the SHA of your latest local commit
```

---

## Step 4 — Authenticate Wrangler to your Cloudflare account

```bash
npx wrangler login
```

This opens a browser tab. Grant access. Wrangler stores the OAuth token under
`~/.config/.wrangler/config/default.toml` (not committed).

If you are already logged in, this is a no-op.

**Verify**

```bash
npx wrangler whoami
# expected: prints your Cloudflare account email + account id
```

---

## Step 5 — Typecheck, dry-run, deploy

```bash
# 5a. Typecheck the Worker
npm run typecheck
# expected: exit 0, no output

# 5b. Dry-run deploy (compiles + validates config without pushing)
npx wrangler deploy --dry-run --outfile=dist/worker.js
# expected: writes dist/worker.js, exit 0, no errors

# 5c. Real deploy
npx wrangler deploy
# expected: prints "Published christianmacion-ai-proxy (X.XX sec)"
#          URL: https://christianmacion-ai-proxy.<your-subdomain>.workers.dev
```

**Verify**

```bash
# Health
curl -fsS https://christianmacion-ai-proxy.<your-subdomain>.workers.dev/health
# expected: {"status":"ok","model":"@cf/meta/llama-3.1-8b-instruct","request_id":"..."}

# Ask (with origin gate; the portfolio is the only allowed origin in production)
curl -N -X POST https://christianmacion-ai-proxy.<your-subdomain>.workers.dev/ask \
  -H "Origin: https://christianmacion.github.io" \
  -H "Content-Type: application/json" \
  -d '{"question":"What does Christian work on?"}'
# expected: SSE stream with data: {"event":"meta"...} -> tokens -> data: {"event":"done"...}
```

When `wrangler deploy` ships the Worker, the front-end palette
(`CommandPalette.astro` `AI_PROXY_URL`) auto-resolves. No front-end rebuild needed.

---

## Post-deploy

1. Test from the portfolio: open `https://christianmacion.github.io`, press
   `Ctrl+K`, type `?what does Christian work on`, hit Enter. The answer
   should stream in.
2. Test the graceful degradation path: turn off the Worker in the Cloudflare
   dashboard (Settings -> Workers -> christianmacion-ai-proxy -> Disable).
   Re-open the palette, ask a question. The UI should show a clear offline
   state with a Retry button and an email fallback, not a cryptic error.
3. Re-enable the Worker and verify the palette is back to streaming.
4. Optional: tail logs via `npx wrangler tail` for the first hour.

---

## Rollback

```bash
# List the last 5 deploys
npx wrangler deployments list

# Roll back to a specific version (use the version-id from the list)
npx wrangler rollback <version-id>
```

If the rollback itself fails, redeploy the prior commit:

```bash
git checkout <prior-sha>
npm install
npx wrangler deploy
git checkout -
```

---

## Cost

- Workers AI free tier: 10,000 neurons/day. At ~1,000 neurons per
  llama-3.1-8b-instruct call, that is ~10 questions/day before pay-as-you-go
  kicks in (~$0.011 per 1k neurons).
- Rate limit cap: 20 / day / IP. Set in `[vars] DAILY_RATE_LIMIT`.
- KV reads + writes are also on the free tier for this volume.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `wrangler deploy` fails with "Invalid KV namespace id" | Step 2 was skipped or the id is wrong | Re-paste the id from Step 1 |
| `/ask` returns 403 | Origin gate: the request did not come from `christianmacion.github.io` | Curl with `-H "Origin: https://christianmacion.github.io"` |
| `/ask` returns 429 | Daily rate limit hit on your IP | Wait until UTC midnight, or raise `DAILY_RATE_LIMIT` |
| Front-end shows "AI temporarily unavailable" | Worker not deployed, DNS not propagated, or KV id missing | Re-run Steps 1-5 |
| `wrangler login` loops | OAuth token expired | `npx wrangler logout && npx wrangler login` |
