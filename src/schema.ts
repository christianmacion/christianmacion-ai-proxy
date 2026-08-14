/**
 * schema.ts — typed contracts for /ask and /health.
 *
 * Every /api/* route handler MUST validate input through a Zod schema
 * (binding to the 5-must-have "no untyped query params" hard-refusal
 * from back_end_engineer doctrine). The schema is the single source
 * of truth: front-end TypeScript types are derived from it.
 */
import { z } from "zod";

/**
 * /ask request body.
 * - `question`: 1-500 chars, trimmed. Long questions are silently
 *   truncated by the handler, not rejected (recruiter ergonomics).
 * - `context.page`: optional referrer page (analytics only).
 * - `context.session_id`: optional visitor fingerprint (e.g. crypto
 *   random per session) for rate-limit bucketing and dedupe. NEVER
 *   PII, NEVER persisted beyond 24h in KV.
 */
export const AskRequest = z.object({
  question: z
    .string()
    .min(1, "question must be non-empty")
    .max(500, "question must be 500 chars or fewer")
    .trim(),
  context: z
    .object({
      page: z.string().max(200).optional(),
      session_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{6,64}$/, "session_id must be 6-64 url-safe chars")
        .optional(),
    })
    .optional(),
});

export type AskRequest = z.infer<typeof AskRequest>;

/**
 * /ask success response (non-streaming). The streaming variant is
 * raw SSE; this shape is the JSON fallback for clients that opt out
 * of streaming (e.g. mobile on flaky networks).
 */
export const AskResponse = z.object({
  answer: z.string().min(1),
  request_id: z.string().uuid(),
  model: z.string(),
  cached: z.boolean(),
  latency_ms: z.number().int().nonnegative(),
});

export type AskResponse = z.infer<typeof AskResponse>;

/**
 * /rates response envelope.
 *
 * Server-side aggregator for the converter modal. Pulls ECB FX
 * (daily fix), Binance 24hr tickers (top 20 by vol), CoinGecko
 * top-50 by market cap, and Yahoo Finance for the 6 non-ECB
 * ASEAN + BRICS fiats (CNY, PHP, INR, IDR, MYR, THB).
 *
 * Failures are per-source: if Yahoo is rate-limited, the envelope
 * still returns with `source_status.yahoo = "degraded"` and the
 * caller can render `UNAVAILABLE` for missing rows.
 */
export const RatesResponse = z.object({
  request_id: z.string().uuid(),
  ts: z.string().datetime(),
  source_status: z.object({
    ecb: z.enum(["ok", "degraded", "down"]),
    binance: z.enum(["ok", "degraded", "down"]),
    coingecko: z.enum(["ok", "degraded", "down"]),
    yahoo: z.enum(["ok", "degraded", "down"]),
  }),
  fiat: z.record(z.string(), z.number().positive()),
  crypto: z.record(
    z.string(),
    z.object({
      last: z.number(),
      bid: z.number().optional(),
      ask: z.number().optional(),
      change24h: z.number().optional(),
      volume24h: z.number().optional(),
      source: z.enum(["binance", "coingecko"]),
      symbol: z.string(),
    }),
  ),
  stale: z.boolean(),
});

export type RatesResponse = z.infer<typeof RatesResponse>;

/**
 * Standard error envelope per back_end_engineer hard-refusal §4.
 * Every failure path emits this shape, with a 4xx/5xx status.
 */
export const ErrorEnvelope = z.object({
  error: z.string(),
  code: z.enum([
    "BAD_REQUEST",
    "VALIDATION_FAILED",
    "FORBIDDEN_ORIGIN",
    "RATE_LIMITED",
    "NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "AI_ERROR",
    "INTERNAL",
    "UPSTREAM_ERROR",
  ]),
  request_id: z.string().uuid(),
  detail: z.string().optional(),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** Build an error envelope (typed factory, not a runtime cast). */
export function makeError(
  code: ErrorEnvelope["code"],
  error: string,
  request_id: string,
  detail?: string,
): ErrorEnvelope {
  return detail === undefined
    ? { code, error, request_id }
    : { code, error, request_id, detail };
}
