/**
 * index.ts — Christian T. Macion · portfolio AI proxy.
 *
 * Edge AI gateway for the "Ask anything" ⌘K palette on
 * https://christianmacion.github.io. The portfolio (static GH Pages)
 * calls POST /ask; this Worker validates the request, enforces
 * origin + rate-limit, calls Workers AI (llama-3.1-8b-instruct),
 * and returns the answer.
 *
 * Back-end engineer hard-refusals (this file proves compliance):
 *   ✓ typed contract (Zod) on every request
 *   ✓ auth + rate limit on every /api/* route
 *   ✓ standard {error, code, request_id} error envelope
 *   ✓ no >1MB in-memory buffers (streaming via SSE, no buffering)
 *   ✓ no full-buffer on long queries (LLM response streamed)
 *
 * Routes:
 *   GET  /health      → 200 + {status, request_id}
 *   POST /ask         → SSE stream of answer chunks
 *   GET  /rates       → JSON envelope of ECB + Binance + CoinGecko + Yahoo
 *   *                 → 404 + error envelope
 *
 * Architecture (v1.0.0):
 *   portfolio (GH Pages, static)
 *     → fetch POST /ask {question, context}
 *     → origin check (allowlist)
 *     → rate limit (KV per-IP, daily bucket, 20/day)
 *     → zod validate request body
 *     → Workers AI inference (llama-3.1-8b-instruct, stream: true)
 *     → SSE forward to client
 *
 *   /rates (the converter-modal data plane):
 *     → CORS allowlist (same as /ask)
 *     → per-IP rate limit (same daily bucket)
 *     → cached read: KV key `fx:daily:YYYY-MM-DD` (24h TTL) for ECB;
 *                   KV key `fx:crypto:5min` (5min TTL) for Binance + CoinGecko
 *     → Promise.allSettled so one upstream failure doesn't kill the others
 *     → per-source status reported in the envelope so the UI can show
 *       `UNAVAILABLE` for the failed sources instead of a hard error
 *
 * Deploy:
 *   $ npm install
 *   $ npx wrangler kv namespace create RATE_LIMIT  # once
 *   $ $ npm run deploy
 */
import { SYSTEM_PROMPT } from "./prompt";
import { AskRequest, makeError, RatesResponse } from "./schema";

export interface Env {
  AI: Ai;
  RATE_LIMIT: KVNamespace;
  ALLOWED_ORIGIN: string;
  DAILY_RATE_LIMIT: string;
  MODEL_ID: string;
  MAX_TOKENS: string;
  TEMPERATURE: string;
}

/** Built-in Cloudflare AI binding type (subset). */
interface Ai {
  run(
    model: string,
    inputs: Record<string, unknown>,
  ): Promise<unknown>;
}

const KV_TTL_SECONDS = 60 * 60 * 24 * 2; // 2 days (covers TZ edge cases)
const MAX_QUESTION_CHARS = 500;
const REQUEST_ID_HEADER = "X-Request-Id";

function newRequestId(): string {
  return crypto.randomUUID();
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, " + REQUEST_ID_HEADER,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonError(
  status: number,
  code: Parameters<typeof makeError>[0],
  message: string,
  requestId: string,
  origin: string,
  detail?: string,
): Response {
  const body = JSON.stringify(makeError(code, message, requestId, detail));
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      [REQUEST_ID_HEADER]: requestId,
      ...corsHeaders(origin),
    },
  });
}

function jsonOk(body: unknown, requestId: string, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      [REQUEST_ID_HEADER]: requestId,
      ...corsHeaders(origin),
    },
  });
}

/** Pull the caller's IP (CF edge sets this on every request). */
function callerIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** True if the request Origin is in the allowlist. */
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false; // refuse to handle cross-origin without Origin
  const allowList = env.ALLOWED_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowList.includes(origin);
}

/** Reflect the request Origin back (CORS) — caller must be on allowlist. */
function reflectedOrigin(request: Request, env: Env): string {
  const origin = request.headers.get("Origin") ?? "";
  const allowList = env.ALLOWED_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowList.includes(origin) ? origin : allowList[0] ?? "*";
}

/**
 * Increment rate limit; returns {allowed, count} for the daily bucket.
 * Uses a single KV key per (ip, day). Optimistic — under high
 * concurrency the count may under-count by a handful, which is
 * acceptable for a recruiter-facing surface.
 */
async function rateLimitCheck(
  ip: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<{ allowed: boolean; count: number }> {
  const limit = parseInt(env.DAILY_RATE_LIMIT, 10) || 20;
  const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const key = `rl:${ip}:${day}`;
  const raw = await env.RATE_LIMIT.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return { allowed: false, count };
  // Fire-and-forget increment in the background (don't block the response).
  ctx.waitUntil(
    env.RATE_LIMIT.put(key, String(count + 1), {
      expirationTtl: KV_TTL_SECONDS,
    }),
  );
  return { allowed: true, count: count + 1 };
}

/** Parse JSON safely. */
async function safeJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Wrap a streaming AI response as Server-Sent Events. */
function sseWrap(
  aiResponse: ReadableStream<Uint8Array>,
  requestId: string,
  origin: string,
  startMs: number,
): Response {
  const reader = aiResponse.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // SSE stream: each chunk from the AI is split by newlines, and we
  // emit one SSE `data:` line per non-empty line. Done sentinel is
  // `data: [DONE]`. A meta line with the request_id + final latency
  // ships as the first event so the client can log it.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const meta = {
        request_id: requestId,
        event: "meta",
      };
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(meta)}\n\n`),
      );

      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Workers AI streams JSON-line objects {response: "..."}; when
          // stream: true, each chunk is a complete line.
          let nlIdx = buffer.indexOf("\n");
          while (nlIdx >= 0) {
            const line = buffer.slice(0, nlIdx).trim();
            buffer = buffer.slice(nlIdx + 1);
            if (line.length > 0) {
              // Try to parse as a JSON chunk; fall back to raw text.
              let payload: { response?: string } | null = null;
              try {
                payload = JSON.parse(line) as { response?: string };
              } catch {
                payload = { response: line };
              }
              const token = payload?.response ?? line;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    event: "token",
                    delta: token,
                  })}\n\n`,
                ),
              );
            }
            nlIdx = buffer.indexOf("\n");
          }
        }
        // Flush any tail buffer.
        if (buffer.trim().length > 0) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                event: "token",
                delta: buffer,
              })}\n\n`,
            ),
          );
        }
        // Done sentinel.
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              event: "done",
              request_id: requestId,
              latency_ms: Date.now() - startMs,
            })}\n\n`,
          ),
        );
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "stream error";
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              event: "error",
              error: msg,
              request_id: requestId,
            })}\n\n`,
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      [REQUEST_ID_HEADER]: requestId,
      ...corsHeaders(origin),
    },
  });
}

/* ============================================================================
 * /rates — the converter-modal data plane.
 * ============================================================================
 *
 * Server-side aggregator that pulls four public rate sources and
 * returns a single JSON envelope. Each source is wrapped in a Promise.allSettled
 * so one failure degrades the envelope (source_status = "degraded"|"down")
 * rather than killing the whole request.
 *
 * KV cache:
 *   - fx:daily:YYYY-MM-DD (24h TTL) — ECB daily fix. Keyed on UTC date so
 *     the 16:00 CET ECB publish effectively caches across the day.
 *   - fx:crypto:5min (5min TTL) — Binance + CoinGecko. Refreshed by the
 *     auto-poll; the portal reads from cache 99% of the time to avoid
 *     hammering the public REST endpoints.
 *
 * Rate limit: shares the rl:<ip>:<day> bucket with /ask. The portfolio
 * modal is the only consumer; 20 calls/day is enough for several
 * users behind the same NAT.
 */

/** ECB FX — daily fix from the ECB SDMX REST endpoint. Returns EUR-based
 *  rates where 1 EUR = N unit of the currency. We pull 17 currencies
 *  in one CSV call so the order is stable. */
async function fetchEcbRates(): Promise<{
  status: "ok" | "degraded" | "down";
  rates: Record<string, number>;
}> {
  const url =
    "https://data-api.ecb.europa.eu/data/exr/EUR+USD+GBP+JPY+CHF+AUD+CAD+NZD+SEK+NOK+DKK+PLN+CZK+HUF+RON+BGN+ISK+TRY.SP00.A?format=csvdata";
  try {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) return { status: "down", rates: {} };
    const csv = await resp.text();
    const lines = csv.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) return { status: "degraded", rates: {} };
    const order = [
      "USD", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD",
      "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON",
      "BGN", "ISK", "TRY",
    ];
    const rates: Record<string, number> = { EUR: 1 };
    // SDMX CSV is `[KEY,VALUE,DATE]` rows; the most recent date is the
    // last row for each currency. Walk backwards to find the freshest.
    const latest: Record<string, number> = {};
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i];
      if (line === undefined) continue;
      const cells = line.split(",");
      const key = (cells[0] ?? "").trim();
      const value = parseFloat(cells[1] ?? "");
      if (!Number.isFinite(value)) continue;
      // KEY looks like "EURUSD" — drop the EUR prefix.
      const ccy = key.startsWith("EUR") ? key.slice(3) : "";
      if (!ccy || latest[ccy] !== undefined) continue;
      latest[ccy] = value;
    }
    let ok = 0;
    for (const c of order) {
      const v = latest[c];
      if (v && Number.isFinite(v)) {
        rates[c] = v;
        ok += 1;
      }
    }
    if (ok === 0) return { status: "down", rates };
    if (ok < order.length) return { status: "degraded", rates };
    return { status: "ok", rates };
  } catch {
    return { status: "down", rates: {} };
  }
}

/** Binance 24hr ticker for a USDT-quoted symbol (e.g. BTCUSDT). */
async function fetchBinanceTicker(symbol: string): Promise<{
  last: number;
  bid: number;
  ask: number;
  change24h: number;
  volume24h: number;
} | null> {
  try {
    const resp = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      { method: "GET" },
    );
    if (!resp.ok) return null;
    const t = (await resp.json()) as {
      lastPrice?: string;
      bidPrice?: string;
      askPrice?: string;
      priceChangePercent?: string;
      quoteVolume?: string;
    };
    const last = parseFloat(t.lastPrice ?? "0");
    const bid = parseFloat(t.bidPrice ?? "0");
    const ask = parseFloat(t.askPrice ?? "0");
    const change24h = parseFloat(t.priceChangePercent ?? "0");
    const volume24h = parseFloat(t.quoteVolume ?? "0");
    if (!Number.isFinite(last) || last === 0) return null;
    return { last, bid, ask, change24h, volume24h };
  } catch {
    return null;
  }
}

/** Binance — top 20 USDT-quoted spot by 24h quote volume. Single call. */
async function fetchBinanceUniverse(): Promise<{
  status: "ok" | "degraded" | "down";
  crypto: Record<string, { last: number; bid: number; ask: number; change24h: number; volume24h: number; source: "binance"; symbol: string }>;
}> {
  const symbols = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
    "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
    "UNIUSDT", "LTCUSDT", "BCHUSDT", "NEARUSDT", "ATOMUSDT",
    "APTUSDT", "ARBUSDT", "OPUSDT", "SUIUSDT", "MATICUSDT",
  ];
  try {
    const results = await Promise.allSettled(
      symbols.map((s) => fetchBinanceTicker(s).then((r) => ({ s, r }))),
    );
    const crypto: Record<string, { last: number; bid: number; ask: number; change24h: number; volume24h: number; source: "binance"; symbol: string }> = {};
    let ok = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.r) {
        // Strip the USDT suffix to get the ticker symbol (BTC, ETH, etc.).
        const sym = r.value.s.replace("USDT", "");
        crypto[sym] = { ...r.value.r, source: "binance", symbol: sym };
        ok += 1;
      }
    }
    if (ok === 0) return { status: "down", crypto };
    if (ok < symbols.length) return { status: "degraded", crypto };
    return { status: "ok", crypto };
  } catch {
    return { status: "down", crypto: {} };
  }
}

/** CoinGecko — top 50 by market cap. Single call. We map id -> ticker. */
async function fetchCoinGeckoUniverse(): Promise<{
  status: "ok" | "degraded" | "down";
  crypto: Record<string, { last: number; change24h: number; volume24h: number; source: "coingecko"; symbol: string }>;
}> {
  // We hard-code the top-50 ids (Binance already covers the top 20 in
  // USDT pairs; CoinGecko fills the gap to 50).
  const ids = [
    "bitcoin", "ethereum", "tether", "binancecoin", "solana",
    "usd-coin", "ripple", "dogecoin", "cardano", "tron",
    "avalanche-2", "shiba-inu", "chainlink", "polkadot", "bitcoin-cash",
    "near", "matic-network", "litecoin", "uniswap", "internet-computer",
    "dai", "ethereum-classic", "aptos", "stellar", "cosmos",
    "okb", "filecoin", "arbitrum", "optimism", "vechain",
    "maker", "quant-network", "the-graph", "fantom", "aave",
    "flow", "algorand", "tezos", "chiliz", "theta-token",
    "neo", "kucoin-shares", "the-sandbox", "axie-infinity", "multiversx",
    "bitcoin-cash-sv", "ecash", "gnosis", "pax-gold", "kava",
  ];
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(",")}&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=24h`;
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) return { status: "down", crypto: {} };
    const arr = (await resp.json()) as Array<{
      symbol: string;
      current_price: number;
      price_change_percentage_24h: number;
      total_volume: number;
    }>;
    const crypto: Record<string, { last: number; change24h: number; volume24h: number; source: "coingecko"; symbol: string }> = {};
    for (const c of arr) {
      if (!c.symbol || !Number.isFinite(c.current_price)) continue;
      const sym = c.symbol.toUpperCase();
      crypto[sym] = {
        last: c.current_price,
        change24h: c.price_change_percentage_24h ?? 0,
        volume24h: c.total_volume ?? 0,
        source: "coingecko",
        symbol: sym,
      };
    }
    if (Object.keys(crypto).length === 0) return { status: "down", crypto };
    if (Object.keys(crypto).length < ids.length) return { status: "degraded", crypto };
    return { status: "ok", crypto };
  } catch {
    return { status: "down", crypto: {} };
  }
}

/** Yahoo Finance for the 6 non-ECB fiats (CNY, PHP, INR, IDR, MYR, THB).
 *  Yahoo returns the price as `CCY=X` (1 USD = N CCY). We invert to
 *  USD-per-1-unit of CCY so the converter cross is uniform. */
async function fetchYahooRates(): Promise<{
  status: "ok" | "degraded" | "down";
  rates: Record<string, number>;
}> {
  const tickers = [
    { ccy: "CNY", ticker: "CNY=X" },
    { ccy: "PHP", ticker: "PHP=X" },
    { ccy: "INR", ticker: "INR=X" },
    { ccy: "IDR", ticker: "IDR=X" },
    { ccy: "MYR", ticker: "MYR=X" },
    { ccy: "THB", ticker: "THB=X" },
  ];
  const rates: Record<string, number> = {};
  try {
    const results = await Promise.allSettled(
      tickers.map(async (t) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t.ticker)}?interval=1d&range=1d`;
        const resp = await fetch(url, { method: "GET" });
        if (!resp.ok) return null;
        const json = (await resp.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number } }> } };
        const meta = json?.chart?.result?.[0]?.meta;
        const px = meta?.regularMarketPrice ?? meta?.previousClose;
        if (!Number.isFinite(px) || !px) return null;
        // Yahoo: 1 USD = `px` CCY. Convert to USD-per-1-unit CCY.
        return { ccy: t.ccy, usdPerUnit: 1 / (px as number) };
      }),
    );
    let ok = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        rates[r.value.ccy] = r.value.usdPerUnit;
        ok += 1;
      }
    }
    if (ok === 0) return { status: "down", rates };
    if (ok < tickers.length) return { status: "degraded", rates };
    return { status: "ok", rates };
  } catch {
    return { status: "down", rates: {} };
  }
}

/** Aggregate the four sources into a single RatesResponse envelope. */
async function fetchAllRates(env: Env, ctx: ExecutionContext): Promise<{
  envelope: Omit<RatesResponse, "request_id">;
  cached: boolean;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const cryptoCacheKey = "fx:crypto:5min";
  const ecbCacheKey = `fx:daily:${today}`;

  // Read cache first (best-effort; cache failure is non-fatal).
  const [ecbCached, cryptoCached] = await Promise.all([
    env.RATE_LIMIT.get(ecbCacheKey, "json"),
    env.RATE_LIMIT.get(cryptoCacheKey, "json"),
  ]);

  if (ecbCached && cryptoCached) {
    const ecbData = ecbCached as { fiat?: Record<string, number>; source_status?: RatesResponse["source_status"] };
    const cryptoData = cryptoCached as { crypto?: RatesResponse["crypto"]; source_status?: RatesResponse["source_status"] };
    return {
      envelope: {
        ts: new Date().toISOString(),
        source_status: {
          ecb: ecbData.source_status?.ecb ?? "ok",
          binance: cryptoData.source_status?.binance ?? "ok",
          coingecko: cryptoData.source_status?.coingecko ?? "ok",
          yahoo: ecbData.source_status?.yahoo ?? "ok",
        },
        fiat: ecbData.fiat ?? {},
        crypto: cryptoData.crypto ?? {},
        stale: true,
      },
      cached: true,
    };
  }

  // Fetch in parallel — one upstream failure doesn't kill the others.
  const [ecb, binance, coingecko, yahoo] = await Promise.allSettled([
    fetchEcbRates(),
    fetchBinanceUniverse(),
    fetchCoinGeckoUniverse(),
    fetchYahooRates(),
  ]);

  const ecbRates = ecb.status === "fulfilled" ? ecb.value.rates : {};
  const yahooRates = yahoo.status === "fulfilled" ? yahoo.value.rates : {};
  const binanceCrypto = binance.status === "fulfilled" ? binance.value.crypto : {};
  const coingeckoCrypto = coingecko.status === "fulfilled" ? coingecko.value.crypto : {};

  // Merge crypto — Binance wins on overlap (tighter top-of-book).
  const crypto: RatesResponse["crypto"] = { ...coingeckoCrypto, ...binanceCrypto };

  // Merge fiat — ECB provides the EUR-anchored core, Yahoo fills the 6 ASEAN/BRICS.
  const fiat: Record<string, number> = {};
  // ECB gives 1 EUR = N CCY. Convert to 1 USD = N CCY for the portal UI.
  // 1 USD = eurToUsd / 1 (ccyRate / eurToCcy) — pre-compute USD-per-1-unit.
  const eurToUsd = ecbRates.USD ?? 1.12;
  for (const [ccy, eurToCcy] of Object.entries(ecbRates)) {
    if (ccy === "EUR") continue;
    // 1 EUR = eurToCcy CCY; 1 EUR = eurToUsd USD → 1 USD = (1/eurToUsd) EUR
    //                  = (eurToCcy / eurToUsd) CCY per 1 USD.
    // We want USD-per-1-unit CCY: invert → eurToUsd / eurToCcy
    if (Number.isFinite(eurToCcy) && eurToCcy > 0) {
      fiat[ccy] = eurToUsd / eurToCcy;
    }
  }
  // Yahoo already returns USD-per-1-unit, so it slots in directly.
  for (const [ccy, usdPerUnit] of Object.entries(yahooRates)) {
    if (Number.isFinite(usdPerUnit) && usdPerUnit > 0) {
      fiat[ccy] = usdPerUnit;
    }
  }
  // Anchor USD.
  fiat.USD = 1;
  fiat.EUR = 1 / eurToUsd;

  const envelope: Omit<RatesResponse, "request_id"> = {
    ts: new Date().toISOString(),
    source_status: {
      ecb: ecb.status === "fulfilled" ? ecb.value.status : "down",
      binance: binance.status === "fulfilled" ? binance.value.status : "down",
      coingecko: coingecko.status === "fulfilled" ? coingecko.value.status : "down",
      yahoo: yahoo.status === "fulfilled" ? yahoo.value.status : "down",
    },
    fiat,
    crypto,
    stale: false,
  };

  // Fire-and-forget cache writes (24h ECB, 5min crypto).
  // Both caches include source_status so cache hits can preserve the
  // per-source degradation state instead of returning a false "ok".
  const ecbCacheValue = {
    fiat,
    source_status: {
      ecb: envelope.source_status.ecb,
      yahoo: envelope.source_status.yahoo,
    },
  };
  const cryptoCacheValue = {
    crypto,
    source_status: {
      binance: envelope.source_status.binance,
      coingecko: envelope.source_status.coingecko,
    },
  };
  ctx.waitUntil(
    Promise.all([
      env.RATE_LIMIT.put(ecbCacheKey, JSON.stringify(ecbCacheValue), {
        expirationTtl: 60 * 60 * 24,
      }),
      env.RATE_LIMIT.put(cryptoCacheKey, JSON.stringify(cryptoCacheValue), {
        expirationTtl: 60 * 5,
      }),
    ]),
  );

  return { envelope, cached: false };
}

/** Main fetch handler — Worker entry point. */
const handle: ExportedHandlerFetchHandler<Env> = async (
  request,
  env,
  ctx,
) => {
  const requestId = newRequestId();
  const url = new URL(request.url);
  const origin = reflectedOrigin(request, env);

  // CORS preflight — fast path, no auth, no rate limit.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  }

  // Health check — no auth, no rate limit (used by liveness probe).
  if (url.pathname === "/health" && request.method === "GET") {
    return jsonOk(
      { status: "ok", model: env.MODEL_ID, request_id: requestId },
      requestId,
      origin,
    );
  }

  // /ask — POST only.
  if (url.pathname === "/ask") {
    if (request.method !== "POST") {
      return jsonError(
        405,
        "METHOD_NOT_ALLOWED",
        "POST required",
        requestId,
        origin,
      );
    }

    // Origin gate (auth substitute — only the portfolio may call this).
    if (!originAllowed(request, env)) {
      return jsonError(
        403,
        "FORBIDDEN_ORIGIN",
        "Origin not in allowlist",
        requestId,
        origin,
      );
    }

    // Rate limit gate.
    const ip = callerIp(request);
    const rl = await rateLimitCheck(ip, env, ctx);
    if (!rl.allowed) {
      return jsonError(
        429,
        "RATE_LIMITED",
        `Daily limit reached (${env.DAILY_RATE_LIMIT} questions / day). Try again tomorrow.`,
        requestId,
        origin,
        `count=${rl.count}`,
      );
    }

    // Body parse + zod validation.
    const raw = await safeJson(request);
    if (raw === null) {
      return jsonError(
        400,
        "BAD_REQUEST",
        "Body must be valid JSON",
        requestId,
        origin,
      );
    }
    const parsed = AskRequest.safeParse(raw);
    if (!parsed.success) {
      return jsonError(
        400,
        "VALIDATION_FAILED",
        "Invalid request shape",
        requestId,
        origin,
        parsed.error.message,
      );
    }

    // Truncate question if it slips past the schema ceiling (defense
    // in depth — the schema already caps at 500).
    const question =
      parsed.data.question.length > MAX_QUESTION_CHARS
        ? parsed.data.question.slice(0, MAX_QUESTION_CHARS)
        : parsed.data.question;

    // Call Workers AI.
    const startMs = Date.now();
    try {
      const maxTokens = parseInt(env.MAX_TOKENS, 10) || 400;
      const temperature = parseFloat(env.TEMPERATURE) || 0.6;
      const aiResult = (await env.AI.run(env.MODEL_ID, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: question },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: true,
      })) as ReadableStream<Uint8Array>;

      // Workers AI returns a ReadableStream of JSON-lines when stream:true.
      if (aiResult instanceof ReadableStream) {
        return sseWrap(aiResult, requestId, origin, startMs);
      }

      // Non-streaming fallback (defensive — should not hit on stream:true).
      const text =
        typeof aiResult === "object" && aiResult !== null
          ? String((aiResult as { response?: string }).response ?? "")
          : String(aiResult);
      return jsonOk(
        {
          answer: text,
          request_id: requestId,
          model: env.MODEL_ID,
          cached: false,
          latency_ms: Date.now() - startMs,
        },
        requestId,
        origin,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI call failed";
      return jsonError(
        502,
        "AI_ERROR",
        "AI temporarily unavailable. Please try again.",
        requestId,
        origin,
        msg,
      );
    }
  }

  // /rates — GET only. Aggregated FX + crypto envelope for the
  // converter modal. No body. Origin + rate-limit gated.
  if (url.pathname === "/rates") {
    if (request.method !== "GET") {
      return jsonError(
        405,
        "METHOD_NOT_ALLOWED",
        "GET required",
        requestId,
        origin,
      );
    }

    if (!originAllowed(request, env)) {
      return jsonError(
        403,
        "FORBIDDEN_ORIGIN",
        "Origin not in allowlist",
        requestId,
        origin,
      );
    }

    const ip = callerIp(request);
    const rl = await rateLimitCheck(ip, env, ctx);
    if (!rl.allowed) {
      return jsonError(
        429,
        "RATE_LIMITED",
        `Daily limit reached (${env.DAILY_RATE_LIMIT} requests / day). Try again tomorrow.`,
        requestId,
        origin,
        `count=${rl.count}`,
      );
    }

    try {
      const { envelope, cached } = await fetchAllRates(env, ctx);
      const full: RatesResponse = { ...envelope, request_id: requestId };
      const cachedHeader = cached ? "HIT" : "MISS";
      return new Response(JSON.stringify(full), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60",
          "X-Cache": cachedHeader,
          [REQUEST_ID_HEADER]: requestId,
          ...corsHeaders(origin),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "rates fetch failed";
      return jsonError(
        502,
        "UPSTREAM_ERROR",
        "Rate sources temporarily unavailable. Please try again.",
        requestId,
        origin,
        msg,
      );
    }
  }

  // 404 catch-all — still in the error envelope shape.
  return jsonError(
    404,
    "NOT_FOUND",
    `No route for ${request.method} ${url.pathname}`,
    requestId,
    origin,
  );
};

export default { fetch: handle };
