// src/gemini_live_client.ts — Outbound WebSocket client for the Gemini Live API.
//
// Endpoint (verified 2026-09-02 from https://ai.google.dev/api/live):
//   wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage
//       .v1beta.GenerativeService.BidiGenerateContent?key=<API_KEY>
//
// Server messages of interest:
//   - setupComplete                  — handshake done
//   - serverContent                  — model audio/text chunks
//   - goAway                         — server-initiated disconnect signal
//   - sessionResumptionUpdate        — handle for transparent reconnect
//   - toolCall                       — model wants to call a function
//
// Reconnect strategy:
//   The Gemini Live API enforces a ~10-minute maximum session duration
//   (verified via the `GoAway` server message + public docs). We proactively
//   reconnect at the 9-minute mark to stay safely under that cap. On
//   reconnect we transparently re-issue the original setup message with the
//   session_resumption handle the server last sent us, so the model
//   preserves conversational context across the boundary.
//
// All public surface is callback-driven — this client does no I/O of its
// own beyond the WebSocket. The caller (live_handler.ts) wires the
// callbacks to the client WebSocket.

const LIVE_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Hard limit on a single upstream connection. The 10-min cap is enforced
// by the Live API (see session_resumption + goAway server messages);
// we proactively rotate at 9 min to leave a 1-min safety margin.
export const MAX_UPSTREAM_SESSION_MS = 9 * 60 * 1000;

// How long to wait for the new upstream socket after triggering a rotate.
const RECONNECT_TIMEOUT_MS = 15_000;
// How long to wait after sending the rotate-trigger message before we
// forcibly close. Gives the model time to flush its turn.
const DRAIN_GRACE_MS = 1_500;

export interface LiveClientCallbacks {
  /** Called for every JSON-or-text message received from the upstream Live API. */
  onUpstreamMessage: (raw: string) => void;
  /** Called when the upstream socket closes (cleanly or not). */
  onUpstreamClose: (code: number, reason: string) => void;
  /** Called when an upstream error occurs. */
  onUpstreamError: (err: Event | Error) => void;
  /** Called once the new upstream socket is open after a rotate, BEFORE we re-send setup. */
  onReconnected?: () => void;
}

export interface LiveClientOptions {
  apiKey: string;
  /** Last session_resumption handle we received. Used for transparent rotate. */
  resumeHandle?: string | null;
  /** Logger (defaults to console). */
  logger?: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private startedAt = 0;
  private rotateTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private draining = false;
  private closed = false;
  private resumeHandle: string | null;
  private apiKey: string;
  private log: (...args: unknown[]) => void;
  private warn: (...args: unknown[]) => void;
  private errLog: (...args: unknown[]) => void;
  private callbacks: LiveClientCallbacks;

  constructor(options: LiveClientOptions, callbacks: LiveClientCallbacks) {
    this.apiKey = options.apiKey;
    this.resumeHandle = options.resumeHandle ?? null;
    this.callbacks = callbacks;
    const l = options.logger ?? console;
    this.log = l.log.bind(l);
    this.warn = l.warn.bind(l);
    this.errLog = l.error.bind(l);
  }

  /** Open the upstream socket and arm the 9-minute rotate timer. */
  connect(): void {
    if (this.closed) {
      throw new Error("GeminiLiveClient: cannot connect() after close()");
    }
    const url = `${LIVE_WS_BASE}?key=${encodeURIComponent(this.apiKey)}`;
    this.log(`[live] connecting to upstream (resume=${this.resumeHandle ? "yes" : "no"})`);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.startedAt = Date.now();

    ws.addEventListener("open", () => this.handleOpen());
    ws.addEventListener("message", (ev) => this.handleMessage(ev));
    ws.addEventListener("close", (ev) => this.handleClose(ev));
    ws.addEventListener("error", (ev) => this.callbacks.onUpstreamError(ev));
  }

  /** Forward a JSON-or-text message from the browser down to the Live API. */
  send(raw: string): void {
    if (this.closed) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.warn("[live] send() called while upstream not open — dropping");
      return;
    }
    this.ws.send(raw);
  }

  /** Force-close the upstream socket. Idempotent. */
  close(): void {
    this.closed = true;
    this.clearRotateTimer();
    this.clearReconnectTimer();
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close(1000, "client closed");
      } catch (_) {
        // ignore
      }
    }
    this.ws = null;
  }

  // ---- internal ----

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    this.log(`[live] upstream open after ${Date.now() - this.startedAt}ms`);
    if (this.callbacks.onReconnected) {
      try {
        this.callbacks.onReconnected();
      } catch (e) {
        this.errLog("[live] onReconnected callback threw:", e);
      }
    }
    // Arm the 9-minute proactive rotate.
    this.armRotateTimer();
  }

  private handleMessage(ev: MessageEvent): void {
    // The Live API can deliver text JSON frames or binary (rare). We always
    // surface text — the handler layer is responsible for parsing.
    let raw: string;
    if (typeof ev.data === "string") {
      raw = ev.data;
    } else if (ev.data instanceof Blob) {
      // Defensive: very rare for Live API but possible for audio.
      ev.data.text().then((t) => this.callbacks.onUpstreamMessage(t)).catch((e) =>
        this.errLog("[live] blob->text failed:", e)
      );
      return;
    } else {
      raw = String(ev.data);
    }
    // Track the latest session_resumption handle so the next rotate is
    // transparent to the client.
    try {
      const parsed = JSON.parse(raw);
      const handle = parsed?.sessionResumptionUpdate?.newHandle ?? parsed?.session_resumption_update?.new_handle;
      if (typeof handle === "string" && handle.length > 0) {
        this.resumeHandle = handle;
      }
    } catch (_) {
      // Non-JSON, ignore.
    }
    this.callbacks.onUpstreamMessage(raw);
  }

  private handleClose(ev: CloseEvent): void {
    this.clearRotateTimer();
    if (this.draining) {
      // The proactive-rotate close we triggered. Schedule reconnect.
      this.draining = false;
      this.scheduleReconnect();
      return;
    }
    this.callbacks.onUpstreamClose(ev.code, ev.reason);
  }

  private armRotateTimer(): void {
    this.clearRotateTimer();
    this.rotateTimer = setTimeout(() => this.beginRotate("9-minute proactive rotate"), MAX_UPSTREAM_SESSION_MS) as unknown as number;
  }

  private clearRotateTimer(): void {
    if (this.rotateTimer !== null) {
      clearTimeout(this.rotateTimer);
      this.rotateTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private beginRotate(reason: string): void {
    if (this.closed) return;
    if (this.draining) return; // already rotating
    this.log(`[live] ${reason} — beginning transparent rotate`);
    this.draining = true;
    // Give the model time to flush whatever turn it's in. After that we
    // tear down the upstream socket — handleClose() will see draining=true
    // and schedule the reconnect.
    setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        // Already gone — fire reconnect directly.
        this.draining = false;
        this.scheduleReconnect();
        return;
      }
      try {
        this.ws.close(1000, "rotate");
      } catch (e) {
        this.errLog("[live] rotate close() failed:", e);
      }
    }, DRAIN_GRACE_MS);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.clearReconnectTimer();
    // Exponential backoff up to 8s.
    const delay = Math.min(8000, 500 * 2 ** Math.min(this.reconnectAttempts, 4));
    this.reconnectAttempts++;
    this.log(`[live] scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.connect();
      } catch (e) {
        this.errLog("[live] reconnect failed:", e);
        this.scheduleReconnect();
      }
    }, delay) as unknown as number;

    // Cap total reconnect wait so we don't hang the client forever.
    setTimeout(() => {
      if (this.closed) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.errLog("[live] reconnect timeout — closing client session");
        this.callbacks.onUpstreamClose(1011, "reconnect timeout");
        this.close();
      }
    }, RECONNECT_TIMEOUT_MS + delay);
  }

  /** Public so the handler layer can build a session_resumption-tagged setup message. */
  getResumeHandle(): string | null {
    return this.resumeHandle;
  }

  isDraining(): boolean {
    return this.draining;
  }
}
