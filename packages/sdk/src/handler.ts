import type { IncomingMessage, ServerResponse } from "node:http";
import { occurrenceKey } from "./receiver.js";
import { MemoryDedupeStore, type DedupeStore } from "./dedupe.js";
import { SessionStops, isStopPrompt } from "./stop.js";
import type {
  AgentSessionCreatedEvent,
  AgentSessionPromptedEvent,
  AppWebhookEnvelope,
  DataEvent,
  OAuthAppRevokedEvent,
  PermissionChangeEvent,
  PingEvent,
} from "./types.js";
import { verifyWebhook, type HeaderSource, type WebhookVerificationFailure } from "./webhooks.js";

export type SessionContext = {
  /** Aborted when the session is stopped (stop signal, 409 SESSION_ENDED, uninstall). */
  signal: AbortSignal;
};

export type PromptedContext = SessionContext & {
  /** `agent_activity.signal === "stop"`: post one final response or error, then nothing. */
  isStop: boolean;
};

export type WebhookHandlerOptions = {
  secret: string;
  toleranceMs?: number;
  now?: () => number;
  /** Default: bounded in-memory store. */
  dedupe?: DedupeStore;
  /** Maximum distinct sessions whose delivery order is retained for 24 hours. */
  maxOrderedSessions?: number;
  /** Default: a private instance. Share it with PulseAgentClient so 409s abort work too. */
  stops?: SessionStops;
  onSessionCreated?: (event: AgentSessionCreatedEvent, ctx: SessionContext) => unknown;
  onSessionPrompted?: (event: AgentSessionPromptedEvent, ctx: PromptedContext) => unknown;
  onPermissionChange?: (event: PermissionChangeEvent) => unknown;
  onRevoked?: (event: OAuthAppRevokedEvent) => unknown;
  /** The test delivery from `POST /agent-apps/{app_id}/webhook/test`. Default: ignored. */
  onPing?: (event: PingEvent) => unknown;
  /** Opt-in `Issue`, `Comment`, `Project` events. */
  onData?: (event: DataEvent) => unknown;
  /** A callback threw. Default: console.error. The delivery was already acknowledged. */
  onError?: (err: unknown, event: AppWebhookEnvelope) => void;
  /** A delivery was refused (bad signature, stale body timestamp, bad JSON). */
  onRejected?: (reason: WebhookVerificationFailure) => void;
};

export type HandleResult = { status: number; body: { ok: boolean; error?: string } };

export type WebhookHandler = {
  /** Verify and acknowledge; the callback runs after this resolves. */
  handle(rawBody: Uint8Array | ArrayBuffer | string, headers: HeaderSource): HandleResult;
  /** For Bun.serve and other fetch-style servers on supported Node.js or Bun runtimes. */
  fetch(request: Request): Promise<Response>;
  /** For node:http / Express without a body parser on this route. */
  node(req: IncomingMessage, res: ServerResponse): void;
  /** Resolves once every callback started so far has settled (tests, graceful shutdown). */
  idle(): Promise<void>;
  readonly stops: SessionStops;
};

const MAX_BODY_BYTES = 1024 * 1024;
const ORDER_RETENTION_MS = 24 * 60 * 60 * 1000;

type SessionOrder = {
  latestWork: number;
  stopAt: number;
  pendingStops: Set<Promise<void>>;
  pending: number;
};

/**
 * Receives app webhooks. Order is fixed: verify → answer 200 → (asynchronously) dedupe on
 * an installation-scoped occurrence key → dispatch. Pulse gives the webhook 5 seconds; the callbacks never hold
 * the response.
 */
export function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
  const dedupe = options.dedupe ?? new MemoryDedupeStore();
  const stops = options.stops ?? new SessionStops();
  const inflight = new Set<Promise<void>>();
  const sessionOrder = new Map<string, SessionOrder>();
  const idleExpiry = new Map<string, number>();
  const limit = options.maxOrderedSessions ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("maxOrderedSessions must be positive");
  const onError =
    options.onError ??
    ((err: unknown, event: AppWebhookEnvelope) =>
      console.error("pulse webhook callback failed", { type: event.type, action: event.action, err }));

  async function dispatch(event: AppWebhookEnvelope, order?: SessionOrder, settleStop?: () => void): Promise<void> {
    if (event.type === "Ping") {
      // No installation and no event_id; Pulse never retries a Ping, so nothing to dedupe.
      await options.onPing?.(event as PingEvent);
      return;
    }
    if (!event.installation_id || !event.app_user_id) {
      throw new Error(`pulse webhook ${event.type}/${event.action} without installation_id/app_user_id`);
    }
    if (!(await dedupe.claim(JSON.stringify([event.installation_id, occurrenceKey(event)])))) return;

    if (order) {
      const timestamp = typeof event.created_at === "string" && /(?:Z|[+-]\d\d:\d\d)$/i.test(event.created_at)
        ? Date.parse(event.created_at) : NaN;
      const isStop = event.action === "prompted" && isStopPrompt((event as AgentSessionPromptedEvent).data);
      if (isStop) {
        const stopAt = Number.isFinite(timestamp) ? timestamp : Infinity;
        if (stopAt <= order.stopAt) return;
        order.stopAt = stopAt;
        if (stopAt < order.latestWork) return;
      } else {
        // A slow asynchronous dedupe store must not allow old work past an admitted Stop.
        while (order.pendingStops.size) await Promise.all(order.pendingStops);
        if (order.stopAt > -Infinity && (
          !Number.isFinite(timestamp) || timestamp <= order.stopAt ||
          (event.action !== "prompted" && order.latestWork <= order.stopAt)
        )) return;
        if (Number.isFinite(timestamp)) order.latestWork = Math.max(order.latestWork, timestamp);
      }
    }

    if (event.type === "AgentSessionEvent" && event.action === "created") {
      const e = event as AgentSessionCreatedEvent;
      const sessionId = e.data.agent_session.id;
      await options.onSessionCreated?.(e, { signal: stops.signal(sessionId, e.installation_id) });
    } else if (event.type === "AgentSessionEvent" && event.action === "prompted") {
      const e = event as AgentSessionPromptedEvent;
      const sessionId = e.data.agent_session.id;
      const isStop = isStopPrompt(e.data);
      if (isStop) {
        stops.stop(sessionId, { kind: "stop_signal", endReason: e.data.agent_session.end_reason });
        settleStop?.();
      } else {
        stops.resume(sessionId);
      }
      await options.onSessionPrompted?.(e, { isStop, signal: stops.signal(sessionId, e.installation_id) });
    } else if (event.type === "PermissionChange") {
      await options.onPermissionChange?.(event as PermissionChangeEvent);
    } else if (event.type === "OAuthApp" && event.action === "revoked") {
      stops.stopInstallation((event as OAuthAppRevokedEvent).installation_id, { kind: "revoked" });
      await options.onRevoked?.(event as OAuthAppRevokedEvent);
    } else if (event.type === "Issue" || event.type === "Comment" || event.type === "Project") {
      await options.onData?.(event as DataEvent);
    }
  }

  function schedule(event: AppWebhookEnvelope): boolean {
    let order: SessionOrder | undefined;
    let settleStop: (() => void) | undefined;
    const data = event.data as Partial<AgentSessionPromptedEvent["data"]> | undefined;
    const sessionId = event.type === "AgentSessionEvent" && (event.action === "created" || event.action === "prompted")
      ? data?.agent_session?.id : undefined;
    if (typeof sessionId === "string") {
      const now = performance.now();
      for (const [id, expiry] of idleExpiry) {
        if (expiry > now) break;
        idleExpiry.delete(id);
        sessionOrder.delete(id);
      }
      order = sessionOrder.get(sessionId);
      if (!order) {
        if (sessionOrder.size >= limit) return false;
        order = { latestWork: -Infinity, stopAt: -Infinity, pending: 0, pendingStops: new Set() };
        sessionOrder.set(sessionId, order);
      }
      idleExpiry.delete(sessionId);
      order.pending++;
      if (event.action === "prompted" && data?.agent_activity?.signal === "stop") {
        let resolve!: () => void;
        const done = new Promise<void>((r) => { resolve = r; });
        const waiting = order.pendingStops;
        waiting.add(done);
        settleStop = () => { waiting.delete(done); resolve(); };
      }
    }
    const run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => dispatch(event, order, settleStop))
      .finally(() => settleStop?.())
      .catch((err: unknown) => onError(err, event))
      .finally(() => {
        if (order && sessionId && --order.pending === 0) {
          idleExpiry.set(sessionId, performance.now() + ORDER_RETENTION_MS);
        }
        inflight.delete(run);
      });
    inflight.add(run);
    return true;
  }

  function handle(rawBody: Uint8Array | ArrayBuffer | string, headers: HeaderSource): HandleResult {
    const verified = verifyWebhook(rawBody, headers, options.secret, {
      ...(options.toleranceMs !== undefined && { toleranceMs: options.toleranceMs }),
      ...(options.now && { now: options.now }),
    });
    if (!verified.ok) {
      options.onRejected?.(verified.reason);
      const status = verified.reason === "invalid_json" ? 400 : 401;
      return { status, body: { ok: false, error: verified.reason } };
    }
    if (!schedule(verified.payload)) return { status: 503, body: { ok: false, error: "session_order_capacity" } };
    return { status: 200, body: { ok: true } };
  }

  return {
    handle,
    stops,
    async fetch(request) {
      if (request.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
      const raw = await request.arrayBuffer();
      if (raw.byteLength > MAX_BODY_BYTES) return Response.json({ ok: false, error: "too_large" }, { status: 413 });
      const result = handle(raw, request.headers);
      return Response.json(result.body, { status: result.status });
    },
    node(req, res) {
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      const reply = (result: HandleResult) => {
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      };
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES && !aborted) {
          aborted = true;
          reply({ status: 413, body: { ok: false, error: "too_large" } });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!aborted) reply(handle(Buffer.concat(chunks), req.headers));
      });
    },
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
