import { test } from "node:test";
import assert from "node:assert/strict";
import { PulseAgentClient } from "../src/client.js";
import { SessionStops, SessionEndedError, stopCauseOf } from "../src/stop.js";
import { InstallationRevokedError, PulseApiError } from "../src/errors.js";
import { fetchStub, json, session } from "./_helpers.js";

const activity = (seq: number, extra: Record<string, unknown> = {}) => ({
  id: `act_${seq}`,
  seq,
  type: "thought",
  content: { type: "thought", body: `b${seq}` },
  ephemeral: false,
  superseded_by_seq: null,
  signal: null,
  signal_metadata: null,
  author: { kind: "app", id: "app-user-1", name: "Scout", avatar_url: null },
  created_at: "2026-09-25T09:12:04.000Z",
  ...extra,
});

function client(responses: Parameters<typeof fetchStub>[0], extra: Partial<ConstructorParameters<typeof PulseAgentClient>[0]> = {}) {
  const stub = fetchStub(responses);
  const tokens: Array<boolean | undefined> = [];
  const c = new PulseAgentClient({
    tokenProvider: async (o) => {
      tokens.push(o?.forceRefresh);
      return o?.forceRefresh ? "tok-2" : "tok-1";
    },
    workspaceId: "ws1",
    baseUrl: "https://api.example.test/api/v1/",
    fetch: stub.fetch,
    sleep: async () => {},
    ...extra,
  });
  return { c, calls: stub.calls, tokens };
}

test("every call carries the bearer and X-Workspace-ID", async () => {
  const { c, calls } = client([json(200, session()), json(200, { user: { id: "app-user-1" } })]);
  await c.sessions.get("sess_1");
  await c.me();
  for (const call of calls) {
    assert.equal(call.headers.get("authorization"), "Bearer tok-1");
    assert.equal(call.headers.get("x-workspace-id"), "ws1");
  }
  assert.equal(calls[0]?.url.pathname, "/api/v1/agent-sessions/sess_1");
  assert.equal(calls[1]?.url.pathname, "/api/v1/auth/me");
});

test("the Idempotency-Key is minted once and reused across retries", async () => {
  const { c, calls } = client([
    json(503, { code: "UNAVAILABLE", message: "try later" }),
    new TypeError("fetch failed"),
    json(429, { code: "RATE_LIMIT_EXCEEDED", message: "slow down" }, { "retry-after": "1" }),
    json(201, activity(7)),
  ]);
  const out = await c.thought("sess_1", "Looking at PUL-1…");
  assert.equal(out.seq, 7);
  assert.equal(calls.length, 4);
  const keys = new Set(calls.map((x) => x.headers.get("idempotency-key")));
  assert.equal(keys.size, 1);
  const [key] = [...keys];
  assert.ok(key && key.length <= 64 && key.startsWith("pulse-sdk-"));
  assert.deepEqual(calls[0]?.body, { content: { type: "thought", body: "Looking at PUL-1…" } });
});

test("a caller-supplied key is used as is; an over-long key is refused before any call", async () => {
  const { c, calls } = client([json(201, activity(1))]);
  await c.respond("sess_1", "Done", { idempotencyKey: "evt-1-final" });
  assert.equal(calls[0]?.headers.get("idempotency-key"), "evt-1-final");
  assert.throws(() => c.respond("sess_1", "x", { idempotencyKey: "k".repeat(65) }), RangeError);
});

test("429 honours Retry-After", async () => {
  const slept: number[] = [];
  const { c } = client(
    [json(429, { code: "RATE_LIMIT_EXCEEDED", message: "" }, { "retry-after": "2" }), json(201, activity(1))],
    { sleep: async (ms) => void slept.push(ms) },
  );
  await c.thought("sess_1", "x");
  assert.deepEqual(slept, [2000]);
});

test("409 SESSION_ENDED is not retried, throws SessionEndedError and stops the session", async () => {
  const stops = new SessionStops();
  const signal = stops.signal("sess_1", "inst1");
  const { c, calls } = client(
    [json(409, { code: "SESSION_ENDED", message: "This session has ended", details: { end_reason: "uninstalled" } })],
    { stops },
  );
  await assert.rejects(c.thought("sess_1", "still here?"), (err: unknown) => {
    assert.ok(err instanceof SessionEndedError);
    assert.equal(err.endReason, "uninstalled");
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(signal.aborted, true);
  assert.deepEqual(stopCauseOf(signal), { kind: "session_ended", endReason: "uninstalled" });
});

test("409 SESSION_ENDED on PATCH is handled the same way", async () => {
  const stops = new SessionStops();
  const { c, calls } = client([json(409, { code: "SESSION_ENDED", message: "", details: { end_reason: "stopped" } })], { stops });
  await assert.rejects(c.setPlan("sess_1", [{ content: "a", status: "pending" }]), SessionEndedError);
  assert.equal(calls.length, 1);
  assert.equal(stops.isStopped("sess_1"), true);
});

test("other 4xx are thrown once as PulseApiError", async () => {
  const { c, calls } = client([json(403, { code: "APP_STATUS_FORBIDDEN", message: "no", details: { allowed: ["in_progress", "qa"] } })]);
  await assert.rejects(c.updateIssueStatus("i1", "in_progress"), (err: unknown) => err instanceof PulseApiError && err.code === "APP_STATUS_FORBIDDEN");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.method, "PUT");
  assert.deepEqual(calls[0]?.body, { status: "in_progress" });
});

test("proactive create on an issue is not retried after a 5xx (it could open two sessions)", async () => {
  const { c, calls } = client([json(502, { code: "BAD_GATEWAY", message: "" })]);
  await assert.rejects(c.sessions.createOnIssue("i1"), PulseApiError);
  assert.equal(calls.length, 1);
});

test("a 401 forces one token refresh; INSTALLATION_REVOKED does not", async () => {
  const { c, calls, tokens } = client([json(401, { code: "UNAUTHORIZED", message: "" }), json(200, session())]);
  await c.sessions.get("sess_1");
  assert.deepEqual(tokens, [undefined, true]);
  assert.equal(calls[1]?.headers.get("authorization"), "Bearer tok-2");

  const revoked = client([json(401, { code: "INSTALLATION_REVOKED", message: "gone" })]);
  await assert.rejects(revoked.c.sessions.get("sess_1"), InstallationRevokedError);
  assert.equal(revoked.calls.length, 1);
});

test("activities() pages with the server's last_seq through seq gaps", async () => {
  const { c, calls } = client([
    json(200, { data: [activity(3), activity(9)], has_more: true, last_seq: 9 }),
    json(200, { data: [activity(40)], has_more: false, last_seq: 40 }),
  ]);
  const all = await c.sessions.activities("sess_1", { afterSeq: 2 });
  assert.deepEqual(all.map((a) => a.seq), [3, 9, 40]);
  assert.equal(calls[0]?.url.searchParams.get("after_seq"), "2");
  assert.equal(calls[1]?.url.searchParams.get("after_seq"), "9");
});

test("activity shapes: ephemeral action with null parameter, select and auth elicitations", async () => {
  const { c, calls } = client([json(201, activity(1)), json(201, activity(2)), json(201, activity(3)), json(201, activity(4))]);
  await c.action("sess_1", { action: "Reading" }, { ephemeral: true });
  await c.action("sess_1", { action: "Read issue", parameter: "PUL-1", result: "3 comments" });
  await c.elicit("sess_1", "Which one?", { select: [{ value: "a", label: "A" }, { value: "b" }] });
  await c.elicit("sess_1", "Connect GitHub", { auth: { url: "https://scout.example/connect", provider_name: "GitHub" } });
  assert.deepEqual(calls[0]?.body, { content: { type: "action", action: "Reading", parameter: null }, ephemeral: true });
  assert.deepEqual(calls[1]?.body, { content: { type: "action", action: "Read issue", parameter: "PUL-1", result: "3 comments" } });
  assert.deepEqual(calls[2]?.body, { content: { type: "elicitation", body: "Which one?" }, signal: "select", signal_metadata: { options: [{ value: "a", label: "A" }, { value: "b" }] } });
  assert.deepEqual(calls[3]?.body, { content: { type: "elicitation", body: "Connect GitHub" }, signal: "auth", signal_metadata: { url: "https://scout.example/connect", provider_name: "GitHub" } });
});

test("plan and external URL updates are PATCHes with the contract's field names", async () => {
  const { c, calls } = client([json(200, session()), json(200, session()), json(200, session())]);
  await c.setPlan("sess_1", [{ content: "Read", status: "inProgress" }]);
  await c.addExternalUrl("sess_1", { label: "Open in Scout", url: "https://scout.example/runs/1" });
  await c.removeExternalUrl("sess_1", "https://scout.example/runs/1");
  assert.deepEqual(calls.map((x) => [x.init.method, x.body]), [
    ["PATCH", { plan: [{ content: "Read", status: "inProgress" }] }],
    ["PATCH", { added_external_urls: [{ label: "Open in Scout", url: "https://scout.example/runs/1" }] }],
    ["PATCH", { removed_external_urls: ["https://scout.example/runs/1"] }],
  ]);
});

test("list sessions repeats the state filter", async () => {
  const { c, calls } = client([json(200, { data: [], next_cursor: null })]);
  await c.sessions.list({ issueId: "i1", state: ["active", "pending"] });
  assert.equal(calls[0]?.url.searchParams.get("issue_id"), "i1");
  assert.deepEqual(calls[0]?.url.searchParams.getAll("state"), ["active", "pending"]);
});

test("getIssue and updateIssueStatus read the Issue pulse-api sends at the top level", async () => {
  const issue = { id: "i1", code: "PUL-7", title: "Retry ignores Retry-After", status: "todo" };
  const { c, calls } = client([json(200, issue), json(200, { ...issue, status: "in_progress" })]);
  const got = await c.getIssue("i1");
  assert.equal(got.status, "todo");
  const moved = await c.updateIssueStatus("i1", "in_progress");
  assert.equal(moved.status, "in_progress");
  assert.equal(calls[1]?.init.method, "PUT");
});
