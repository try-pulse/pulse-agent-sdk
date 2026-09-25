import { randomUUID } from "node:crypto";
import { InstallationRevokedError, PulseApiError } from "./errors.js";
import { DEFAULT_BASE_URL, trimSlash } from "./oauth.js";
import { SessionEndedError, type SessionStops } from "./stop.js";
import type { TokenProvider } from "./tokens.js";
import type {
  ActionContent,
  AgentActivity,
  AgentActivityCreate,
  AgentActivityPage,
  AgentSession,
  AgentSessionPage,
  AgentSessionState,
  AgentSessionUpdate,
  AppIssueStatus,
  AuthSignalMetadata,
  ExternalUrl,
  Issue,
  MeResponse,
  PlanItem,
  SelectOption,
} from "./types.js";

export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

export type PulseAgentClientOptions = {
  tokenProvider: TokenProvider;
  /** The installation's workspace; sent as `X-Workspace-ID` on every call. */
  workspaceId: string;
  /** `https://api.trypulse.tech/api/v1` by default (pulse-api and the Agent Session API share it). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Share with the webhook handler: a 409 SESSION_ENDED then aborts that session's work. */
  stops?: SessionStops;
  /** Attempts after the first for retryable failures. Default 3. */
  maxRetries?: number;
  /** Base backoff; doubles per attempt. Default 250 ms. */
  retryBaseMs?: number;
  /** Prefix of generated Idempotency-Keys. Default `pulse-sdk`. */
  idempotencyPrefix?: string;
  sleep?: (ms: number) => Promise<void>;
};

export type RequestOptions = {
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Safe to repeat after a network error or 5xx. Default: true for GET/PUT/PATCH/DELETE and
   * for any request carrying an Idempotency-Key; false otherwise. 429 is always retried.
   */
  retryable?: boolean;
  /** The session this write belongs to; turns 409 SESSION_ENDED into SessionEndedError. */
  sessionId?: string;
  signal?: AbortSignal;
};

export type ActivityOptions = {
  ephemeral?: boolean;
  /** ≤ 64 chars. Generated once per call when absent, and reused for every retry. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type ActionInput = { action: string; parameter?: string | null; result?: string };

export type ElicitOptions = ActivityOptions & {
  /** `signal: select` — the answer arrives as the next `prompted` body (value or free text). */
  select?: SelectOption[];
  /** `signal: auth` — resume with a `thought` once the person has connected. */
  auth?: AuthSignalMetadata;
};

export type ListSessionsInput = {
  issueId?: string;
  state?: AgentSessionState | AgentSessionState[];
  cursor?: string;
  limit?: number;
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The app's side of the Agent Session API plus the pulse-api calls an agent needs, as the
 * app itself (`Authorization: Bearer <app token>` + `X-Workspace-ID`).
 *
 * Retries: network errors, 408 and 5xx on idempotent requests, and 429 always (honouring
 * `Retry-After`). Every activity POST carries an Idempotency-Key minted before the first
 * attempt, so a retry can never post twice. A 409 SESSION_ENDED is never retried.
 */
export class PulseAgentClient {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly #o: PulseAgentClientOptions;

  constructor(options: PulseAgentClientOptions) {
    if (!options.workspaceId) throw new Error("PulseAgentClient: workspaceId is required");
    this.#o = options;
    this.baseUrl = trimSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.workspaceId = options.workspaceId;
  }

  readonly sessions = {
    get: (sessionId: string, opts?: { signal?: AbortSignal }) =>
      this.request<AgentSession>("GET", `/agent-sessions/${enc(sessionId)}`, { ...opts }),

    list: (input: ListSessionsInput = {}) =>
      this.request<AgentSessionPage>("GET", "/agent-sessions", {
        query: {
          issue_id: input.issueId,
          state: input.state === undefined ? undefined : ([] as AgentSessionState[]).concat(input.state),
          cursor: input.cursor,
          limit: input.limit,
        },
      }),

    /** One page of activities after `afterSeq`. Use `activities()` to read them all. */
    activityPage: (sessionId: string, opts: { afterSeq?: number; limit?: number; signal?: AbortSignal } = {}) =>
      this.request<AgentActivityPage>("GET", `/agent-sessions/${enc(sessionId)}/activities`, {
        query: { after_seq: opts.afterSeq, limit: opts.limit },
        ...(opts.signal && { signal: opts.signal }),
      }),

    /**
     * Every activity after `afterSeq`, oldest first, including human prompts. `seq` has gaps,
     * so paging follows the server's `last_seq`, never `seq + 1`.
     */
    activities: async (
      sessionId: string,
      opts: { afterSeq?: number; signal?: AbortSignal } = {},
    ): Promise<AgentActivity[]> => {
      const all: AgentActivity[] = [];
      let after = opts.afterSeq;
      for (;;) {
        const page = await this.sessions.activityPage(sessionId, {
          ...(after !== undefined && { afterSeq: after }),
          limit: 200,
          ...(opts.signal && { signal: opts.signal }),
        });
        all.push(...page.data);
        if (!page.has_more || page.data.length === 0) return all;
        after = page.last_seq;
      }
    },

    /** Proactive session on an issue. No `created` webhook is sent for it. Not retried on 5xx. */
    createOnIssue: (issueId: string) =>
      this.request<AgentSession>("POST", "/agent-sessions", { body: { issue_id: issueId } }),

    /** Proactive session on a comment; returns the app's open session on that thread if one exists. */
    createOnComment: (commentId: string) =>
      this.request<AgentSession>("POST", "/agent-sessions", { body: { comment_id: commentId }, retryable: true }),

    update: (sessionId: string, update: AgentSessionUpdate, opts: { signal?: AbortSignal } = {}) =>
      this.request<AgentSession>("PATCH", `/agent-sessions/${enc(sessionId)}`, {
        body: update,
        sessionId,
        ...(opts.signal && { signal: opts.signal }),
      }),
  };

  createActivity(sessionId: string, activity: AgentActivityCreate, opts: ActivityOptions = {}): Promise<AgentActivity> {
    const key = opts.idempotencyKey ?? this.newIdempotencyKey();
    if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new RangeError(`Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }
    return this.request<AgentActivity>("POST", `/agent-sessions/${enc(sessionId)}/activities`, {
      body: activity,
      headers: { "idempotency-key": key },
      sessionId,
      ...(opts.signal && { signal: opts.signal }),
    });
  }

  thought(sessionId: string, body: string, opts: ActivityOptions = {}) {
    return this.createActivity(sessionId, withEphemeral({ content: { type: "thought", body } }, opts), opts);
  }

  action(sessionId: string, input: ActionInput, opts: ActivityOptions = {}) {
    const content: ActionContent = { type: "action", action: input.action, parameter: input.parameter ?? null };
    if (input.result !== undefined) content.result = input.result;
    return this.createActivity(sessionId, withEphemeral({ content }, opts), opts);
  }

  elicit(sessionId: string, body: string, opts: ElicitOptions = {}) {
    if (opts.select && opts.auth) throw new Error("elicit: pass select or auth, not both");
    const activity: AgentActivityCreate = { content: { type: "elicitation", body } };
    if (opts.select) {
      activity.signal = "select";
      activity.signal_metadata = { options: opts.select };
    } else if (opts.auth) {
      activity.signal = "auth";
      activity.signal_metadata = opts.auth;
    }
    return this.createActivity(sessionId, activity, opts);
  }

  respond(sessionId: string, body: string, opts: Omit<ActivityOptions, "ephemeral"> = {}) {
    return this.createActivity(sessionId, { content: { type: "response", body } }, opts);
  }

  error(sessionId: string, body: string, opts: Omit<ActivityOptions, "ephemeral"> = {}) {
    return this.createActivity(sessionId, { content: { type: "error", body } }, opts);
  }

  /** Replaces the whole plan (≤ 50 items). */
  setPlan(sessionId: string, plan: PlanItem[], opts: { signal?: AbortSignal } = {}) {
    return this.sessions.update(sessionId, { plan }, opts);
  }

  /** Replaces the whole list (≤ 10, unique url). */
  setExternalUrls(sessionId: string, urls: ExternalUrl[], opts: { signal?: AbortSignal } = {}) {
    return this.sessions.update(sessionId, { external_urls: urls }, opts);
  }

  addExternalUrl(sessionId: string, url: ExternalUrl, opts: { signal?: AbortSignal } = {}) {
    return this.sessions.update(sessionId, { added_external_urls: [url] }, opts);
  }

  removeExternalUrl(sessionId: string, url: string, opts: { signal?: AbortSignal } = {}) {
    return this.sessions.update(sessionId, { removed_external_urls: [url] }, opts);
  }

  /** `GET /auth/me` — the app's own user (Linear's `viewer`). Needs no scope. */
  me() {
    return this.request<MeResponse>("GET", "/auth/me");
  }

  getIssue(issueId: string, opts: { signal?: AbortSignal } = {}): Promise<Issue> {
    return this.request<Issue>("GET", `/issues/${enc(issueId)}`, { ...opts });
  }

  /** Apps may move an issue only to `in_progress` or `qa` (403 APP_STATUS_FORBIDDEN otherwise). */
  updateIssueStatus(issueId: string, status: AppIssueStatus, opts: { signal?: AbortSignal } = {}) {
    return this.request<Issue>("PUT", `/issues/${enc(issueId)}`, { body: { status }, ...opts });
  }

  newIdempotencyKey(): string {
    const prefix = (this.#o.idempotencyPrefix ?? "pulse-sdk").slice(0, MAX_IDEMPOTENCY_KEY_LENGTH - 37);
    return `${prefix}-${randomUUID()}`;
  }

  /** Any pulse-api or Agent Session API route, relative to the base URL. */
  async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }
    const hasKey = Object.keys(opts.headers ?? {}).some((h) => h.toLowerCase() === "idempotency-key");
    const retryable = opts.retryable ?? (method !== "POST" || hasKey);
    const maxRetries = this.#o.maxRetries ?? 3;
    const sleep = this.#o.sleep ?? defaultSleep;
    const doFetch = this.#o.fetch ?? fetch;
    let forceRefresh = false;
    let refreshedOnce = false;

    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      const token = await this.#o.tokenProvider(forceRefresh ? { forceRefresh: true } : undefined);
      forceRefresh = false;
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-workspace-id": this.workspaceId,
        ...opts.headers,
      };
      if (opts.body !== undefined) headers["content-type"] = "application/json";

      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers,
          ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
          ...(opts.signal && { signal: opts.signal }),
        });
      } catch (err) {
        if (opts.signal?.aborted || !retryable || attempt >= maxRetries) throw err;
        await sleep(this.#backoff(attempt));
        continue;
      }

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const err = await toApiError(res);
      if (res.status === 409 && err.code === "SESSION_ENDED" && opts.sessionId) {
        const ended = new SessionEndedError(opts.sessionId, err.message, err.details);
        this.#o.stops?.noteSessionEnded(ended);
        throw ended;
      }
      if (res.status === 401) {
        if (err.code === "INSTALLATION_REVOKED") throw new InstallationRevokedError(undefined, err.message);
        if (!refreshedOnce) {
          refreshedOnce = true;
          forceRefresh = true;
          continue;
        }
        throw err;
      }
      const again =
        attempt < maxRetries &&
        (res.status === 429 || (retryable && (res.status === 408 || (res.status >= 500 && res.status !== 501))));
      if (!again) throw err;
      await sleep(err.retryAfterMs ?? this.#backoff(attempt));
    }
  }

  #backoff(attempt: number): number {
    const base = this.#o.retryBaseMs ?? 250;
    return Math.min(30_000, base * 2 ** attempt) * (0.5 + Math.random() / 2);
  }
}

function withEphemeral(activity: AgentActivityCreate, opts: ActivityOptions): AgentActivityCreate {
  if (opts.ephemeral) activity.ephemeral = true;
  return activity;
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

async function toApiError(res: Response): Promise<PulseApiError> {
  let body: { code?: unknown; message?: unknown; details?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // non-JSON error body
  }
  const retryAfter = res.headers.get("retry-after");
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  return new PulseApiError(
    res.status,
    typeof body.code === "string" ? body.code : `HTTP_${res.status}`,
    typeof body.message === "string" ? body.message : res.statusText,
    body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : undefined,
    Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : undefined,
  );
}
