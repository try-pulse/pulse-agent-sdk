import { signWebhook } from "../src/webhooks.js";

export const SECRET = "pwhsec_test_secret";
export const NOW = 1_790_327_523_120;

export function envelope(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    action: "created",
    type: "AgentSessionEvent",
    actor: { id: "u1", type: "user", name: "Sara Ahmadi" },
    created_at: "2026-09-25T09:12:03.120Z",
    url: "https://app.trypulse.tech/pulse/issues/i1",
    workspace_id: "ws1",
    webhook_id: "wh1",
    webhook_timestamp: NOW,
    installation_id: "inst1",
    app_user_id: "app-user-1",
    data: {
      event_id: "ase_s1_created",
      agent_session: session(),
      previous_comments: [],
      guidance: [],
      prompt_context: "<issue identifier=\"PUL-1\" url=\"u\"><title>T</title></issue>",
      ...data,
    },
    ...overrides,
  };
}

export function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess_1",
    state: "pending",
    unresponsive_since: null,
    issue: { id: "i1", identifier: "PUL-1", title: "T", url: "https://app.trypulse.tech/pulse/issues/i1", team: { id: "t1", key: "PUL", name: "Pulse" } },
    comment: null,
    creator: { id: "u1", name: "Sara Ahmadi" },
    app_user_id: "app-user-1",
    plan: [],
    external_urls: [],
    created_at: "2026-09-25T09:12:03.120Z",
    updated_at: "2026-09-25T09:12:03.120Z",
    ended_at: null,
    end_reason: null,
    ...overrides,
  };
}

export function signed(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  return { raw, headers: { "Pulse-Signature": signWebhook(raw, secret), "Content-Type": "application/json" } };
}

export type Call = { url: URL; init: RequestInit; headers: Headers; body: unknown };

/** A fetch stub answering from a queue of responses and recording every call. */
export function fetchStub(responses: Array<Response | (() => Response) | Error>) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    let body: unknown;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init.body instanceof URLSearchParams) {
      body = Object.fromEntries(init.body);
    }
    calls.push({ url, init, headers, body });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetch: impl as typeof fetch, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
