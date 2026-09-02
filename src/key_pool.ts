// src/key_pool.ts — Shared API key pool for Deno proxy.
//
// Refactored from the random-pick logic in src/openai.mjs (which only handled
// comma-separated keys from the Authorization header on HTTP). This module
// supports three sources, in priority order:
//
//   1. Comma-separated keys from `x-goog-api-key` request header
//      (forwarded by the gemini-balance-ui Next.js proxy at LB time).
//   2. Comma-separated keys from `Authorization: Bearer ...` header.
//   3. Deno.env.get("GMB_KEYS") — the Deno Deploy env var. This is the only
//      source that works when Deno is hit directly (not via the Next.js
//      proxy), e.g. for the Live API WS proxy which the Next.js app does
//      not yet wrap.
//
// Random pick per request — matches the existing openai.mjs behaviour so
// load-balancing characteristics are unchanged.

const FALLBACK_ENV_KEYS = ["GMB_KEYS", "GEMINI_API_KEYS", "GEMINI_API_KEY"];

function parseKeyString(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function envKeys(): string[] {
  for (const name of FALLBACK_ENV_KEYS) {
    const v = Deno.env.get(name);
    const parsed = parseKeyString(v);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

export function keysFromHeaders(headers: Headers): string[] {
  const xGoog = parseKeyString(headers.get("x-goog-api-key"));
  if (xGoog.length > 0) return xGoog;

  const auth = headers.get("authorization");
  if (auth) {
    const bearer = auth.split(" ")[1] ?? "";
    const fromBearer = parseKeyString(bearer);
    if (fromBearer.length > 0) return fromBearer;
  }
  return [];
}

export function pickKey(keys: string[]): string {
  if (keys.length === 0) {
    throw new Error("No Gemini API keys available (neither header nor GMB_KEYS env).");
  }
  return keys[Math.floor(Math.random() * keys.length)];
}

// Single entry point — pick a key from the request, falling back to env.
export function selectKey(request: Request): string {
  const fromRequest = keysFromHeaders(request.headers);
  const pool = fromRequest.length > 0 ? fromRequest : envKeys();
  if (pool.length === 0) {
    throw new Error(
      "No Gemini API keys available. Set GMB_KEYS env var or send " +
        "x-goog-api-key / Authorization header.",
    );
  }
  return pickKey(pool);
}

// Exposed for tests / observability.
export function poolSize(request?: Request): number {
  const fromRequest = request ? keysFromHeaders(request.headers) : [];
  const pool = fromRequest.length > 0 ? fromRequest : envKeys();
  return pool.length;
}
