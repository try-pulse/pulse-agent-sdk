// Scout against a fake Pulse: signed webhooks in, recorded API calls out. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryTokenStore, SessionStops, TokenManager, createWebhookHandler, signWebhook } from "@pulse/agent-sdk";
import { Scout } from "../src/scout.js";

const SECRET = "pwhsec_scout_test";
type Call = { method: string; path: string; body: any };

function fakePulse(opts: { issueStatus?: string; endAfterFirstWrite?: boolean; stallPatch?: { nth: number; gate: Promise<void> } } = {}) {
  const calls: Call[] = [];
  let writes = 0;
  let patches = 0;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace("/api/v1", "");
    calls.push({ method, path, body });
    if (method !== "GET" && opts.endAfterFirstWrite && writes++ >= 1) {
      return reply(409, { code: "SESSION_ENDED", message: "ended", details: { end_reason: "uninstalled" } });
    }
    if (method === "PATCH" && opts.stallPatch && ++patches === opts.stallPatch.nth) {
      // Like fetch: an abort rejects the pending request.
      await new Promise<void>((resolve, reject) => {
        opts.stallPatch!.gate.then(resolve);
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    if (method === "GET" && path.startsWith("/issues/")) return reply(200, { id: "i1", status: opts.issueStatus ?? "todo" });
    if (method === "GET" && path.endsWith("/activities")) {
      return reply(200, { data: [{ type: "prompt" }, { type: "response" }, { type: "prompt" }], has_more: false, last_seq: 9 });
    }
    if (method === "POST" && path.endsWith("/activities")) return reply(201, { id: `a${calls.length}`, seq: calls.length });
    return reply(200, {});
  };
  return { fetch: impl as typeof fetch, calls };
}

function setup(fake: ReturnType<typeof fakePulse>, stepDelayMs = 0) {
  const store = new MemoryTokenStore();
  void store.set({ installation_id: "inst1", workspace_id: "ws1", app_user_id: "app1", access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3_600_000 });
  const oauth = { clientId: "c", clientSecret: "s", redirectUri: "https://scout.example.com/oauth/callback", fetch: fake.fetch };
  const tokens = new TokenManager({ store, oauth });
  const stops = new SessionStops();
  const scout = new Scout({ tokens, stops, baseUrl: "https://api.example.test/api/v1", fetch: fake.fetch, stepDelayMs, log: () => {} });
  const handler = createWebhookHandler({
    secret: SECRET,
    stops,
    onSessionCreated: (e, c) => scout.onCreated(e, c),
    onSessionPrompted: (e, c) => scout.onPrompted(e, c),
    onError: (err) => {
      throw err;
    },
  });
  const deliver = (body: unknown) => {
    const raw = JSON.stringify(body);
    return handler.handle(raw, { "pulse-signature": signWebhook(raw, SECRET) });
  };
  return { deliver, handler };
}

const agentSession = {
  id: "sess_1",
  state: "pending",
  unresponsive_since: null,
  issue: { id: "i1", identifier: "PUL-7", title: "Retry ignores Retry-After", url: "https://app.trypulse.tech/pulse/issues/i1", team: { id: "t1", key: "PUL", name: "Pulse" } },
  comment: null,
  creator: { id: "u1", name: "Sara Ahmadi" },
  app_user_id: "app1",
  plan: [],
  external_urls: [],
  created_at: "2026-09-25T09:12:03.120Z",
  updated_at: "2026-09-25T09:12:03.120Z",
  ended_at: null,
  end_reason: null,
};

const base = (type: string, action: string, data: unknown) => ({
  type,
  action,
  actor: { id: "u1", type: "user", name: "Sara Ahmadi" },
  created_at: "2026-09-25T09:12:03.120Z",
  url: "",
  workspace_id: "ws1",
  webhook_id: "wh1",
  webhook_timestamp: Date.now(),
  installation_id: "inst1",
  app_user_id: "app1",
  data,
});

const created = (description?: string) =>
  base("AgentSessionEvent", "created", {
    event_id: "ase_sess_1_created",
    agent_session: agentSession,
    previous_comments: [],
    guidance: [{ origin: "team", team_id: "t1", body: "Never touch billing." }],
    prompt_context: `<issue identifier="PUL-7" url="u"><title>Retry ignores Retry-After</title>${description ? `<description>${description}</description>` : ""}<team>Pulse</team><label>bug</label></issue><repository-hint repository="pulse/pulse-api"/>`,
  });

const prompted = (id: string, body: string, signal?: "stop") =>
  base("AgentSessionEvent", "prompted", {
    event_id: id,
    agent_session: signal ? { ...agentSession, state: "stopping", end_reason: "stopped" } : agentSession,
    agent_activity: { id: `act_${id}`, content: { type: "prompt", body }, author: { id: "u1", name: "Sara" }, created_at: "2026-09-25T09:13:00.000Z", ...(signal && { signal }) },
  });

const kinds = (calls: Call[]) =>
  calls.map((c) => (c.path.endsWith("/activities") && c.method === "POST" ? `activity:${c.body.content.type}${c.body.ephemeral ? "~" : ""}` : `${c.method} ${c.path}`));

test("created: thought first, plan, issue moved, actions, then select elicitation for an empty description", async () => {
  const fake = fakePulse();
  const { deliver, handler } = setup(fake);
  assert.equal(deliver(created()).status, 200);
  await handler.idle();
  assert.deepEqual(kinds(fake.calls), [
    "activity:thought",
    "PATCH /agent-sessions/sess_1",
    "GET /issues/i1",
    "PUT /issues/i1",
    "activity:action",
    "activity:action~",
    "activity:action",
    "PATCH /agent-sessions/sess_1",
    "activity:elicitation",
  ]);
  assert.equal(fake.calls[0]?.body.content.body, "Looking at PUL-7…");
  assert.deepEqual(fake.calls[3]?.body, { status: "in_progress" });
  const elicit = fake.calls.at(-1)!.body;
  assert.equal(elicit.signal, "select");
  assert.deepEqual(elicit.signal_metadata.options.map((o: any) => o.value), ["summarise-title", "wait"]);

  deliver(prompted("p1", "summarise-title"));
  await handler.idle();
  const last = fake.calls.at(-1)!;
  assert.equal(last.body.content.type, "response");
  assert.match(last.body.content.body, /PUL-7: Retry ignores Retry-After/);
  assert.match(last.body.content.body, /Never touch billing/);
  // The answer finishes the plan before the response, as a run without the question does.
  const planUpdate = fake.calls.at(-2)!;
  assert.equal(`${planUpdate.method} ${planUpdate.path}`, "PATCH /agent-sessions/sess_1");
  assert.deepEqual(planUpdate.body.plan.map((p: any) => p.status), ["completed", "completed", "completed"]);
});

test("created with a description answers with a response that carries guidance and hints", async () => {
  const fake = fakePulse({ issueStatus: "in_progress" });
  const { deliver, handler } = setup(fake);
  deliver(created("Deliveries that get a 429 retry on the fixed schedule."));
  await handler.idle();
  assert.ok(!kinds(fake.calls).includes("PUT /issues/i1"), "an in_progress issue is not moved");
  const last = fake.calls.at(-1)!;
  assert.equal(last.body.content.type, "response");
  assert.match(last.body.content.body, /pulse\/pulse-api/);
  assert.match(last.body.content.body, /Labels: bug/);
});

test("stop during a run: the run stops and exactly one final response is posted", async () => {
  const fake = fakePulse();
  const { deliver, handler } = setup(fake, 40);
  deliver(created("has a description"));
  await new Promise((r) => setTimeout(r, 20));
  deliver(prompted("p-stop", "Stop", "stop"));
  await handler.idle();
  const activities = fake.calls.filter((c) => c.method === "POST").map((c) => c.body.content);
  const finals = activities.filter((a) => a.type === "response" || a.type === "error");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].body, "Stopped. I made no further changes.");
  assert.ok(!activities.some((a) => a.type === "elicitation"));
});

test("a follow-up during a run is queued, acknowledged, and handled after the run", async () => {
  const fake = fakePulse();
  const { deliver, handler } = setup(fake, 30);
  deliver(created("has a description"));
  await new Promise((r) => setTimeout(r, 15));
  deliver(prompted("p-follow", "Also check the Go client"));
  await handler.idle();
  const k = kinds(fake.calls);
  const queuedAck = fake.calls.findIndex((c) => c.method === "POST" && /Got it/.test(c.body?.content?.body ?? ""));
  const firstResponse = k.indexOf("activity:response");
  const readConversation = k.indexOf("GET /agent-sessions/sess_1/activities");
  assert.ok(queuedAck >= 0 && queuedAck < firstResponse, "the follow-up is acknowledged while the run is active");
  assert.ok(readConversation > firstResponse, "the follow-up runs after the first response");
  assert.equal(k.at(-1), "activity:response");
  assert.match(fake.calls.at(-1)!.body.content.body, /Also check the Go client/);
});

test("409 SESSION_ENDED mid-run: Scout stops quietly and posts no error", async () => {
  const fake = fakePulse({ endAfterFirstWrite: true });
  const { deliver, handler } = setup(fake);
  deliver(created());
  await handler.idle();
  const writes = fake.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 2, "the thought, then one refused write, then nothing");
  assert.ok(!writes.some((c) => c.body?.content?.type === "error"));
});

test("stop while a write is in flight (no step delay): still exactly one final activity", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fake = fakePulse({ issueStatus: "in_progress", stallPatch: { nth: 3, gate } });
  const { deliver, handler } = setup(fake, 0);
  deliver(created("has a description"));
  for (let i = 0; i < 100 && fake.calls.filter((c) => c.method === "PATCH").length < 3; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(fake.calls.filter((c) => c.method === "PATCH").length, 3, "the plan update before the answer is in flight");
  deliver(prompted("p-stop-2", "Stop", "stop"));
  await new Promise((r) => setTimeout(r, 10));
  release();
  await handler.idle();
  const finals = fake.calls
    .filter((c) => c.method === "POST")
    .map((c) => c.body.content)
    .filter((a) => a.type === "response" || a.type === "error");
  assert.deepEqual(finals.map((a) => a.body), ["Stopped. I made no further changes."]);
});
