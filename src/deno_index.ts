// src/deno_index.ts — Deno entry point for the Gemini Balance Lite proxy.
//
// Routes:
//   GET  /                        — banner
//   POST /verify                  — verify a batch of Gemini keys
//   POST /verify-audio            — TTS probe
//   POST /verify-audio-translate  — A->A pipeline probe
//   POST /verify-transcribe       — A->T probe
//   *    /v1/chat/completions     — OpenAI-compatible (delegated to handleRequest)
//   *    /v1/completions
//   *    /v1/embeddings
//   *    /v1/models
//   *    /v1/audio/transcriptions
//   *    /v1/audio/speech
//   *    (anything else)          — generic Gemini API proxy (delegated to handleRequest)
//
// NEW Live API WebSocket routes:
//   GET  /ws/live                 — Live API WS bridge (browser <-> Google Live API)
//   GET  /ws/live/status          — JSON snapshot of live session pool
//
// IMPORTANT: We deliberately keep all HTTP routing in handleRequest.js
// untouched. The Live WS routes are added here at the Deno entry point
// only — this preserves compatibility with the Cloudflare/Vercel/Netlify
// edge deployments (which do NOT route through this file).

import { handleRequest } from "./handle_request.js";
import { handleLiveStatus, handleLiveWebSocket } from "./live_handler.ts";

const PORT = Number(Deno.env.get("PORT")) || 8000;

function denoHandleRequest(req: Request): Promise<Response> | Response {
  const url = new URL(req.url);
  const pathname = url.pathname;
  console.log("Request URL:", req.url);

  // Live API WebSocket routes — must be matched BEFORE the HTTP catch-all
  // in handleRequest, because handleRequest would treat them as generic
  // Gemini API paths and proxy them as plain HTTPS.
  if (pathname === "/ws/live") {
    const upgrade = req.headers.get("upgrade")?.toLowerCase();
    if (upgrade === "websocket") {
      const { response, socket } = handleLiveWebSocket(req);
      // The response is the 101 Switching Protocols — Deno delivers the
      // upgraded socket automatically. We just need to NOT touch the
      // socket after returning.
      void socket;
      return response;
    }
    // Non-WS request to /ws/live — return a hint instead of 404.
    return new Response(
      JSON.stringify({
        error: "WebSocket required",
        hint: "Connect with `new WebSocket('ws://host/ws/live')` and send a JSON setup message.",
        status_endpoint: "/ws/live/status",
      }),
      { status: 426, headers: { "Content-Type": "application/json", "Upgrade": "websocket" } },
    );
  }

  if (pathname === "/ws/live/status") {
    return handleLiveStatus();
  }

  // Everything else — delegate to the existing HTTP router.
  return handleRequest(req);
}

Deno.serve({ port: PORT }, denoHandleRequest);
