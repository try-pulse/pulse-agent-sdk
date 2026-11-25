import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PulseAgentClient } from "../src/client.js";
import { createWebhookReceiver, WebhookError } from "../src/receiver.js";
import { MemoryTokenStore, TokenManager } from "../src/tokens.js";
import { deferred, fetchStub, json, NOW, SECRET, signed } from "./_helpers.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`../../../../fixtures/${name}.json`, import.meta.url), "utf8"));

test("shared Pulse fixture enqueues before ACK and enqueue failures propagate", async () => {
  const started = deferred<void>();
  const committed = deferred<void>();
  const receiver = createWebhookReceiver({
    secret: SECRET, workspaceId: "ws1", now: () => NOW,
    async enqueue(event) {
      assert.deepEqual(event.dedupeKey, ["inst1", "ase_s1_created"]);
      assert.equal(event.sessionId, "sess_1");
      assert.equal(event.isStop, false);
      started.resolve();
      await committed.promise;
    },
  });
  const { raw, headers } = signed(load("agent-session-created"));
  let acknowledged = false;
  const delivery = receiver.receive(raw, headers).then(() => { acknowledged = true; });
  await started.promise;
  assert.equal(acknowledged, false);
  committed.resolve();
  await delivery;
  assert.equal(acknowledged, true);

  const unavailable = createWebhookReceiver({
    secret: SECRET, workspaceId: "ws1", now: () => NOW,
    async enqueue() { throw new Error("inbox unavailable"); },
  });
  await assert.rejects(() => unavailable.receive(raw, headers), /inbox unavailable/);
});

test("data webhook retries use signed fields for the same dedupe key across languages", async () => {
  const receiver = createWebhookReceiver({
    secret: SECRET, workspaceId: "ws1", now: () => NOW, async enqueue() {},
  });
  const payload = load("resource-webhook");
  const a = signed(payload);
  const b = signed({ ...payload, webhook_timestamp: NOW + 250 });
  const first = await receiver.receive(a.raw, a.headers);
  const second = await receiver.receive(b.raw, { ...b.headers, "Pulse-Delivery-ID": "not-signed" });
  assert.deepEqual(first.dedupeKey, second.dedupeKey);
  assert.deepEqual(first.dedupeKey, load("resource-webhook-key"));
  await assert.rejects(() => receiver.receive(a.raw + " ", a.headers), (err: unknown) =>
    err instanceof WebhookError && err.status === 401 && err.code === "bad_signature");
});

test("binds a queued webhook to the installed principal and the OAuth environment", async () => {
  const receiver = createWebhookReceiver({
    secret: SECRET, workspaceId: "ws1", now: () => NOW, async enqueue() {},
  });
  const { raw, headers } = signed(load("agent-session-created"));
  const { payload } = await receiver.receive(raw, headers);
  const store = new MemoryTokenStore();
  await store.set({
    installation_id: "inst1", workspace_id: "ws1", app_user_id: "app-user-1",
    access_token: "access", expires_at: NOW + 3_600_000,
  });
  const oauth = {
    clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/callback",
    baseUrl: "https://api-stage.trypulse.tech/api/v1",
  };
  const tokens = new TokenManager({ store, oauth, now: () => NOW });
  const stub = fetchStub([json(200, { id: "issue" })]);
  const client = await PulseAgentClient.forEvent(tokens, payload, { fetch: stub.fetch });
  await client.getIssue("i1");
  assert.equal(stub.calls[0]?.url.origin, "https://api-stage.trypulse.tech");
  assert.equal(stub.calls[0]?.headers.get("x-workspace-id"), "ws1");
  await assert.rejects(PulseAgentClient.forEvent(tokens, { ...payload, app_user_id: "someone-else" }), /does not match/);
  assert.equal(stub.calls.length, 1);
});
