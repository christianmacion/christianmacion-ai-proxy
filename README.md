# christianmacion-ai-proxy

Edge AI gateway for [christianmacion.github.io](https://christianmacion.github.io). The portfolio's "Ask anything" ⌘K palette calls this Worker; the Worker calls Cloudflare Workers AI (llama-3.1-8b-instruct) and streams the answer back as Server-Sent Events.

## Why this exists

A static site on GitHub Pages cannot run a server-side AI call. Three options were considered:

1. **Direct browser call to a third-party API** — leaks the API key, blocked.
2. **Cloudflare Pages Functions on the same origin** — requires migrating the site off GitHub Pages, blocked.
3. **Separate Cloudflare Worker as a proxy** — selected. The portfolio holds a URL, no key.

The Worker is the proxy. The portfolio (static GH Pages) calls the Worker; the Worker calls Workers AI; the answer streams back.

## Routes

| Method | Path     | Auth     | Rate limit | Description |
|--------|----------|----------|------------|-------------|
| GET    | `/health`| none     | none       | Liveness probe; returns `{status, model, request_id}`. |
| POST   | `/ask`   | origin   | 20 / day / IP | Streamed AI answer (SSE). |
| OPTIONS | `*`     | n/a      | n/a        | CORS preflight. |

## Architecture

```
portfolio (GH Pages, static)
  ↓ fetch POST /ask {question, context}
  ↓ Origin: https://christianmacion.github.io
christianmacion-ai-proxy (this Worker)
  ├ origin check (allowlist against env.ALLOWED_ORIGIN)
  ├ rate limit (KV per-IP, daily bucket)
  ├ zod validate request body
  ├ Workers AI inference (llama-3.1-8b-instruct, stream: true)
  └ SSE forward: data: {event, delta, request_id, latency_ms}
```

## Hard refusals honored

- **Typed contract on every endpoint** — `src/schema.ts` Zod schemas.
- **Auth + rate limit on every public endpoint** — origin gate + KV rate limit on `/ask`.
- **JSONL streaming pipeline** — `stream: true` + SSE; no full-buffer in memory.
- **Standard error envelope** — `{error, code, request_id}` on every failure path.

## Deploy

```bash
# 1. install
npm install

# 2. create the KV namespace (once)
npx wrangler kv namespace create RATE_LIMIT
# → paste the returned `id` into wrangler.toml [[kv_namespaces]] id

# 3. typecheck
npx tsc --noEmit

# 4. deploy
npx wrangler deploy
# → https://christianmacion-ai-proxy.<account>.workers.dev
```

## Smoke test

```bash
# health
curl -s https://christianmacion-ai-proxy.<account>.workers.dev/health

# ask
curl -N -X POST https://christianmacion-ai-proxy.<account>.workers.dev/ask \
  -H "Origin: https://christianmacion.github.io" \
  -H "Content-Type: application/json" \
  -d '{"question":"What does Christian do?"}'
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `ALLOWED_ORIGIN` | `https://christianmacion.github.io,http://localhost:4321` | Comma-separated. Add localhost:4321 for dev. |
| `DAILY_RATE_LIMIT` | `20` | Per-IP daily bucket. |
| `MODEL_ID` | `@cf/meta/llama-3.1-8b-instruct` | Workers AI model binding. |
| `MAX_TOKENS` | `400` | Per-answer cap (≈ 300 words). |
| `TEMPERATURE` | `0.6` | Snappy but not robotic. |

## NDA posture (binding)

The system prompt is the only knowledge the model has. The prompt in `src/prompt.ts` is NDA-safe by construction — it aggregates only public-facing paragraphs from `/`, `/about`, `/experience`, `/methodology`, and `/skills`. No NDA-protected employer names, no proprietary data, no strategy internals.

If a visitor asks something NDA-protected, the model is instructed to say: *"I can only share publicly-known info. For private details, contact Christian directly."*

## Cost

Workers AI free tier: 10,000 neurons/day. At ~1,000 neurons per llama-3.1-8b-instruct call, that's ~10 questions/day before pay-as-you-go kicks in ($0.011 / 1k neurons). 20/IP/day × N IPs caps the per-day ceiling at the rate-limit threshold.

## License

MIT. See `/LICENSE`.
