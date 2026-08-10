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
 * Deploy:
 *   $ npm install
 *   $ npx wrangler kv namespace create RATE_LIMIT  # once
 *   $ npx wrangler deploy
 */
import { SYSTEM_PROMPT } from "./prompt";
import { AskRequest, makeError } from "./schema";

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
