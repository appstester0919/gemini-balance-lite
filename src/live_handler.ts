// src/live_handler.ts — Bridge between a browser WebSocket and the
// Gemini Live API via the GeminiLiveClient.
//
// NOTE: This file is intended to run under the Deno runtime. Deno
// auto-injects the `Deno` global at runtime; `deno check` and
// `deno run` both pick that up. Some LSPs flag `Deno` as "undefined"
// because they don't know about Deno's runtime globals — that's a
// false positive, the file compiles cleanly under `deno check`.
//
// Exposes one entry point: `handleLiveWebSocket(req)` which is called by
// deno_index.ts after `Deno.upgradeWebSocket(req)` succeeds. It:
//
//   1. Picks (or reuses) a Gemini API key from the request/env pool.
//   2. Creates a GeminiLiveClient bound to that key.
//   3. Bridges browser → upstream (with a one-time setup injection on
//      reconnect so the model preserves context across the 9-min rotate).
//   4. Bridges upstream → browser (verbatim passthrough).
//   5. Cleans up the session on either side closing.
//
// Reconnect contract with the browser
// -----------------------------------
// The browser is unaware of the 9-minute upstream rotation. To the
// browser, the WebSocket connection is continuous. On reconnect we
// transparently re-send the original setup message so the model knows
// to resume. The browser does NOT need to re-send setup.
//
// If the browser opens a fresh WebSocket after our session died, they
// can pass `?session=<id>` to reuse the key (and any resume handle we
// still have). Without it, we mint a new session.

import { GeminiLiveClient } from "./gemini_live_client.ts";
import { envKeys, keysFromHeaders, pickKey } from "./key_pool.ts";
import { mintSessionId, SessionLimitError, sessionManager, type SessionRecord } from "./session_manager.ts";

const DEFAULT_LIVE_MODEL = Deno.env.get("GMB_LIVE_MODEL") ??
  "models/gemini-2.5-flash-native-audio-preview-09-2025";
// Some clients use a different default. We accept either in ?model=.

export interface LiveUpgradeResult {
  response: Response;
  socket: WebSocket;
}

export function handleLiveWebSocket(req: Request): LiveUpgradeResult {
  const url = new URL(req.url);
  const clientProvidedSessionId = url.searchParams.get("session");
  const modelFromQuery = url.searchParams.get("model");
  const resumeHandleFromQuery = url.searchParams.get("resume");

  // 1) Validate upgrade + pick key BEFORE we call Deno.upgradeWebSocket
  //    so we can fail with a clean HTTP error if anything is wrong.
  const upgradeHeader = req.headers.get("upgrade");
  if (upgradeHeader?.toLowerCase() !== "websocket") {
    return errResult(426, "Upgrade required — this endpoint expects WebSocket.");
  }

  const fromRequest = keysFromHeaders(req.headers);
  const pool = fromRequest.length > 0 ? fromRequest : envKeys();
  if (pool.length === 0) {
    return errResult(
      503,
      "No Gemini API keys available. Set GMB_KEYS or send x-goog-api-key / Authorization.",
    );
  }

  // 2) Session-limit gate (BEFORE upgrade). Cheap, runs synchronously.
  if (!clientProvidedSessionId && sessionManager.size() >= sessionManager.capacity()) {
    return errResult(
      503,
      `Live session limit reached (${sessionManager.capacity()}). ` +
        `Raise GMB_MAX_LIVE_SESSIONS or close idle sessions.`,
    );
  }

  const apiKey = pickKey(pool);
  const sessionId = clientProvidedSessionId ?? mintSessionId();
  const modelInjected = modelFromQuery ?? DEFAULT_LIVE_MODEL;

  // 3) Upgrade.
  const { socket, response } = Deno.upgradeWebSocket(req);
  const log = (...args: unknown[]) => console.log(`[live:${sessionId.slice(0, 6)}]`, ...args);
  const warn = (...args: unknown[]) => console.warn(`[live:${sessionId.slice(0, 6)}]`, ...args);
  const errLog = (...args: unknown[]) => console.error(`[live:${sessionId.slice(0, 6)}]`, ...args);

  // 4) Build the upstream client. We construct it first, THEN register
  //    the session, so the session record always references a real
  //    client. If registration fails (rare race), we tear down cleanly.
  const originalSetupRef: { value: string | null } = { value: null };
  const firstMessageSentRef: { value: boolean } = { value: false };
  // Will be wired after we know the record exists — captured by closure.
  let recordRef: SessionRecord | undefined;

  const upstream = new GeminiLiveClient(
    {
      apiKey,
      resumeHandle: resumeHandleFromQuery ?? null,
      logger: { log, warn, error: errLog },
    },
    {
      onUpstreamMessage: (raw) => {
        // 1) Speaker: existing 1:1 path.
        try {
          if (socket.readyState === WebSocket.OPEN) socket.send(raw);
        } catch (e) {
          errLog("socket.send failed:", e);
        }
        // 2) Listeners: fan-out the same raw frame to every attached
        //    listener socket. We defensively snapshot the set so a
        //    disconnect mid-iteration can't trip us, and we wrap each
        //    send in try/catch — a slow/dead listener must NEVER break
        //    the speaker path. If send() throws, evict that listener.
        const listeners = sessionManager.listenersFor(sessionId);
        for (const l of listeners) {
          if (l.readyState !== WebSocket.OPEN) {
            sessionManager.removeListener(sessionId, l);
            continue;
          }
          try {
            l.send(raw);
          } catch (e) {
            warn(`listener send failed, evicting: ${(e as Error)?.message ?? e}`);
            sessionManager.removeListener(sessionId, l);
          }
        }
      },
      onUpstreamClose: (code, reason) => {
        warn(`upstream closed code=${code} reason="${reason}"`);
        // If we were not proactively rotating (draining flag set inside
        // GeminiLiveClient), propagate the close to the browser.
        if (!upstream.isDraining()) {
          try {
            socket.close(code === 1000 ? 1011 : code, reason);
          } catch (_) {
            // ignore
          }
        }
      },
      onUpstreamError: (ev) => {
        errLog("upstream error:", ev);
      },
      onReconnected: () => {
        // After a 9-minute rotate, re-send the ORIGINAL setup message
        // so the model preserves context. Live API allows re-sending
        // setup on the new connection as long as it's the first message.
        if (originalSetupRef.value) {
          try {
            upstream.send(originalSetupRef.value);
            log("re-injected original setup on reconnect");
            if (recordRef) recordRef.reconnectCount++;
          } catch (e) {
            errLog("failed to re-inject setup:", e);
          }
        }
      },
    },
  );

  // 5) Register the session. If this throws (race condition where two
  //    simultaneous upgrades both passed the cap check), close the
  //    socket immediately.
  try {
    sessionManager.add({
      id: sessionId,
      apiKey,
      client: upstream,
      startedAt: Date.now(),
      upstreamReadyAt: Date.now(),
      reconnectCount: 0,
      listeners: new Set<WebSocket>(),
    });
  } catch (e) {
    if (e instanceof SessionLimitError) {
      try {
        socket.close(1013, "session limit reached");
      } catch (_) {
        // ignore
      }
      return {
        response: new Response(e.message, { status: e.status }),
        socket: { close() {}, send() {}, readyState: WebSocket.CLOSED } as unknown as WebSocket,
      };
    }
    throw e;
  }
  recordRef = sessionManager.get(sessionId);

  // 6) Browser → upstream bridge.
  socket.addEventListener("message", (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : "";
    if (!raw) return;

    if (!firstMessageSentRef.value) {
      // Sniff and remember the first setup message verbatim. Inject the
      // configured model + sessionResumption handle so we always proxy
      // a sane setup and so the 9-min rotate can be transparent.
      try {
        const parsed = JSON.parse(raw);
        if (parsed.setup && typeof parsed.setup === "object") {
          if (!parsed.setup.model) parsed.setup.model = modelInjected;
          // Tag session resumption transparently. This is what allows
          // the rotate to preserve context. Only add if the client
          // didn't already specify one.
          if (!parsed.setup.sessionResumption) {
            parsed.setup.sessionResumption = resumeHandleFromQuery
              ? { handle: resumeHandleFromQuery }
              : {};
          }
          originalSetupRef.value = JSON.stringify(parsed);
          firstMessageSentRef.value = true;
          upstream.send(originalSetupRef.value);
          return;
        }
      } catch (_) {
        // Not JSON, or not a setup — fall through to passthrough.
      }
      firstMessageSentRef.value = true;
    }

    upstream.send(raw);
  });

  // 7) Open upstream.
  try {
    upstream.connect();
  } catch (e) {
    errLog("upstream connect() threw:", e);
    try {
      socket.close(1011, "upstream connect failed");
    } catch (_) {
      // ignore
    }
  }

  // 8) Cleanup on browser close.
  socket.addEventListener("close", () => {
    log("browser socket closed — tearing down session");
    upstream.close();
    sessionManager.delete(sessionId);
  });

  socket.addEventListener("error", (ev) => {
    errLog("browser socket error:", ev);
  });

  return { response, socket };
}

/**
 * Health/status HTTP endpoint for the Live API proxy. Returns the current
 * session count + capacity + configured model. Useful for monitoring and
 * for tests to assert the proxy is wired correctly without spinning up a
 * full WebSocket dance.
 */
export function handleLiveStatus(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      endpoint: "/ws/live",
      model: DEFAULT_LIVE_MODEL,
      sessions: sessionManager.list(),
      capacity: sessionManager.capacity(),
      max_upstream_session_ms: 9 * 60 * 1000,
    }, null, 2),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Read-only listener status endpoint. Returns one entry per active session
 * with its current listener count — lets us verify fan-out is wired
 * correctly without standing up a real speaker/listener WebSocket dance.
 */
export function handleListenersStatus(): Response {
  const sessions = sessionManager.list().map((r) => ({
    id: r.id,
    listenerCount: r.listenerCount,
  }));
  return new Response(
    JSON.stringify({ ok: true, sessions }, null, 2),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Upgrade a browser listener WebSocket for `?session=<id>` and register
 * it with the session manager. The listener receives a verbatim fan-out
 * of every upstream frame (binary PCM audio for audio responses). It does
 * NOT need to (and should not) send anything — if it does, we ignore it.
 *
 * Returns a 400/404 Response WITHOUT upgrading if the session id is
 * missing/unknown, so callers can surface a clean error.
 */
export function handleListenWebSocket(req: Request): Response {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session");
  if (!sessionId) {
    return new Response(
      JSON.stringify({ error: "Missing required query parameter: session" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const upgradeHeader = req.headers.get("upgrade");
  if (upgradeHeader?.toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({
        error: "WebSocket required",
        hint: "Connect with `new WebSocket('ws://host/ws/listen?session=<id>')`",
      }),
      { status: 426, headers: { "Content-Type": "application/json", "Upgrade": "websocket" } },
    );
  }
  if (!sessionManager.has(sessionId)) {
    return new Response(
      JSON.stringify({ error: "Unknown session", sessionId }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const log = (...args: unknown[]) => console.log(`[listen:${sessionId.slice(0, 6)}]`, ...args);
  const warn = (...args: unknown[]) => console.warn(`[listen:${sessionId.slice(0, 6)}]`, ...args);

  // Register BEFORE any event fires. addListener is idempotent for a given
  // socket identity; if it returns false the session vanished, which is a
  // race we close cleanly.
  if (!sessionManager.addListener(sessionId, socket)) {
    try {
      socket.close(1011, "session vanished");
    } catch (_) { /* ignore */ }
    return new Response(
      JSON.stringify({ error: "session vanished during upgrade" }),
      { status: 410, headers: { "Content-Type": "application/json" } },
    );
  }
  log(`listener attached (now ${sessionManager.get(sessionId)?.listeners.size ?? "?"})`);

  // Listeners are read-only — we discard anything the browser sends. If a
  // future feature needs listener→upstream messages (raise-hand, questions,
  // etc.) it goes through a separate control channel, not this socket.
  socket.addEventListener("message", () => { /* ignore */ });

  socket.addEventListener("close", () => {
    sessionManager.removeListener(sessionId, socket);
    log(`listener detached`);
  });
  socket.addEventListener("error", (ev) => {
    warn(`listener socket error:`, ev);
    sessionManager.removeListener(sessionId, socket);
  });

  return response;
}

function errResult(status: number, message: string): LiveUpgradeResult {
  return {
    response: new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    socket: { close() {}, send() {}, readyState: WebSocket.CLOSED } as unknown as WebSocket,
  };
}
