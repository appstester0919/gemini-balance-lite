// src/session_manager.ts — Tracks Live API session state for the WS proxy.
//
// One entry per browser→upstream Live API session. Holds:
//   - The **pinned** Gemini API key (picked at session start, never rotates
//     within the session — the 9-minute upstream rotate reuses the same
//     key to preserve the session_resumption handle).
//   - The current upstream GeminiLiveClient instance.
//   - The browser WebSocket (the one we accept from the client app).
//
// We also expose a soft cap on concurrent sessions — Gemini's free tier
// has per-key QPS limits, so allowing N browser sessions × 1 key each
// multiplies out fast. The cap is intentionally generous; raise it via
// GMB_MAX_LIVE_SESSIONS env var if you have paid keys.

import { GeminiLiveClient } from "./gemini_live_client.ts";

const DEFAULT_MAX_SESSIONS = 64;

export interface SessionRecord {
  id: string;
  apiKey: string;
  client: GeminiLiveClient;
  startedAt: number;
  upstreamReadyAt: number | null; // when setupComplete arrived
  reconnectCount: number;
  /**
   * Read-only listener WebSockets attached to this session. They receive
   * a verbatim fan-out of every upstream frame so a remote audience can
   * play back the translated audio. Speakers (the WebSocket that created
   * the session) are NOT in this set — they're handled separately by the
   * live_handler closure.
   */
  listeners: Set<WebSocket>;
}

class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private maxSessions: number;

  constructor() {
    const envCap = Number(Deno.env.get("GMB_MAX_LIVE_SESSIONS"));
    this.maxSessions = Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_MAX_SESSIONS;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  size(): number {
    return this.sessions.size;
  }

  capacity(): number {
    return this.maxSessions;
  }

  /** Throws if the cap is reached. */
  add(record: SessionRecord): void {
    if (this.sessions.size >= this.maxSessions) {
      throw new SessionLimitError(
        `Live session limit reached (${this.maxSessions}). ` +
          `Raise GMB_MAX_LIVE_SESSIONS or close idle sessions.`,
      );
    }
    // Ensure listeners set exists even if caller omitted it (defensive).
    if (!record.listeners) record.listeners = new Set<WebSocket>();
    this.sessions.set(record.id, record);
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * Attach a read-only listener WebSocket to a session. No-op if the
   * session doesn't exist (returns false). Returns true on success.
   */
  addListener(id: string, ws: WebSocket): boolean {
    const rec = this.sessions.get(id);
    if (!rec) return false;
    rec.listeners.add(ws);
    return true;
  }

  /** Detach a listener. Safe to call with a non-member ws. */
  removeListener(id: string, ws: WebSocket): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    rec.listeners.delete(ws);
  }

  /**
   * Snapshot of listener WebSockets for a session. Returns an empty set
   * if the session doesn't exist (callers can iterate safely).
   *
   * We hand back a NEW Set so the caller can mutate without affecting
   * the manager — and so fan-out loops can capture a stable view even
   * if a listener disconnects mid-iteration.
   */
  listenersFor(id: string): Set<WebSocket> {
    const rec = this.sessions.get(id);
    if (!rec) return new Set();
    return new Set(rec.listeners);
  }

  /** Snapshot — for /health-style endpoints. */
  list(): Array<
    Pick<
      SessionRecord,
      "id" | "apiKey" | "startedAt" | "upstreamReadyAt" | "reconnectCount"
    > & { listenerCount: number }
  > {
    return [...this.sessions.values()].map((r) => ({
      id: r.id,
      apiKey: `${r.apiKey.slice(0, 5)}…${r.apiKey.slice(-4)}`,
      startedAt: r.startedAt,
      upstreamReadyAt: r.upstreamReadyAt,
      reconnectCount: r.reconnectCount,
      listenerCount: r.listeners.size,
    }));
  }
}

export class SessionLimitError extends Error {
  override name = "SessionLimitError";
  status = 503;
}

// Single shared instance per Deno worker process.
export const sessionManager = new SessionManager();

// Crypto-quality session id. We accept anything the client sends as
// `?session=...` for resumption; if the client doesn't send one, we mint
// a new one.
export function mintSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
