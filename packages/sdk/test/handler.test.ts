import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWebhookHandler } from "../src/handler.js";
import { stopCauseOf } from "../src/stop.js";
import { SECRET, NOW, deferred, envelope, session, signed } from "./_helpers.js";

const now = () => NOW;

test("acknowledges before the callback runs", async () => {
  const gate = deferred();
  const order: string[] = [];
  const h = createWebhookHandler({
    secret: SECRET,
    now,
    onSessionCreated: async () => {
      order.push("callback-start");
      await gate.promise;
      order.push("callback-end");
    },
  });
  const { raw, headers } = signed(envelope());
  const result = h.handle(raw, headers);
  order.push("acked");
  assert.equal(result.status, 200);
  assert.deepEqual(order, ["acked"]);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["acked", "callback-start"]);
  gate.resolve();
  await h.idle();
  assert.deepEqual(order, ["acked", "callback-start", "callback-end"]);
});

test("fetch adapter answers 200 while the callback is still blocked", async () => {
  const gate = deferred();
  let finished = false;
  const h = createWebhookHandler({
    secret: SECRET,
    now,
    onSessionCreated: async () => {
      await gate.promise;
      finished = true;
    },
  });
  const { raw, headers } = signed(envelope());
  const res = await h.fetch(new Request("https://scout.example/webhook", { method: "POST", body: raw, headers }));
  assert.equal(res.status, 200);
  assert.equal(finished, false);
  gate.resolve();
  await h.idle();
  assert.equal(finished, true);
});

test("deduplicates on data.event_id", async () => {
  let calls = 0;
  const h = createWebhookHandler({ secret: SECRET, now, onSessionCreated: () => void calls++ });
  const first = signed(envelope());
  const retry = signed(envelope({ webhook_timestamp: NOW + 1000 }));
  assert.equal(h.handle(first.raw, first.headers).status, 200);
  assert.equal(h.handle(retry.raw, retry.headers).status, 200);
  const other = signed(envelope({}, { event_id: "ase_s2_created", agent_session: session({ id: "sess_2" }) }));
  h.handle(other.raw, other.headers);
  await h.idle();
  assert.equal(calls, 2);
});

test("refuses bad signatures and stale bodies without calling back", async () => {
  let calls = 0;
  const rejected: string[] = [];
  const h = createWebhookHandler({
    secret: SECRET,
    now,
    onSessionCreated: () => void calls++,
    onRejected: (r) => rejected.push(r),
  });
  const bad = signed(envelope(), "pwhsec_wrong");
  assert.equal(h.handle(bad.raw, bad.headers).status, 401);
  const stale = signed(envelope({ webhook_timestamp: NOW - 120_000 }));
  assert.equal(h.handle(stale.raw, stale.headers).status, 401);
  await h.idle();
  assert.equal(calls, 0);
  assert.deepEqual(rejected, ["bad_signature", "stale_timestamp"]);
});

test("a stop prompt sets isStop and aborts the session's signal first", async () => {
  const seen: Array<{ isStop: boolean; aborted: boolean; cause: unknown }> = [];
  let createdSignal: AbortSignal | undefined;
  const h = createWebhookHandler({
    secret: SECRET,
    now,
    onSessionCreated: (_e, ctx) => void (createdSignal = ctx.signal),
    onSessionPrompted: (_e, ctx) => void seen.push({ isStop: ctx.isStop, aborted: ctx.signal.aborted, cause: stopCauseOf(ctx.signal) }),
  });
  const created = signed(envelope());
  h.handle(created.raw, created.headers);
  await h.idle();

  const prompt = (id: string, extra: Record<string, unknown>, sess = session()) =>
    signed(
      envelope({ action: "prompted" }, {
        event_id: id,
        agent_session: sess,
        agent_activity: { id: `act_${id}`, content: { type: "prompt", body: "Stop" }, author: { id: "u1", name: "Sara" }, created_at: "2026-09-25T09:20:11.000Z", ...extra },
        previous_comments: undefined,
        guidance: undefined,
        prompt_context: undefined,
      }),
    );
  const text = prompt("p1", {});
  h.handle(text.raw, text.headers);
  const stop = prompt("p2", { signal: "stop" }, session({ state: "stopping", end_reason: "stopped" }));
  h.handle(stop.raw, stop.headers);
  await h.idle();

  assert.equal(seen[0]?.isStop, false);
  assert.equal(seen[0]?.aborted, false);
  assert.equal(seen[1]?.isStop, true);
  assert.equal(seen[1]?.aborted, true);
  assert.deepEqual(seen[1]?.cause, { kind: "stop_signal", endReason: "stopped" });
  assert.equal(createdSignal?.aborted, true, "the created run's signal is the same one, now aborted");
});

test("OAuthApp revoked stops every session of that installation", async () => {
  const signals: AbortSignal[] = [];
  let revoked = 0;
  const h = createWebhookHandler({
    secret: SECRET,
    now,
    onSessionCreated: (_e, ctx) => void signals.push(ctx.signal),
    onRevoked: () => void revoked++,
  });
  const a = signed(envelope());
  const b = signed(envelope({ installation_id: "inst2" }, { event_id: "e2", agent_session: session({ id: "sess_other" }) }));
  h.handle(a.raw, a.headers);
  h.handle(b.raw, b.headers);
  await h.idle();
  const rev = signed({ ...envelope({ type: "OAuthApp", action: "revoked", actor: { id: "system", type: "system", name: "Pulse" } }), data: { event_id: "rev1", installation_id: "inst1", app_id: "app1" } });
  h.handle(rev.raw, rev.headers);
  await h.idle();
  assert.equal(revoked, 1);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
});

test("a callback error is reported, not thrown, and later events still run", async () => {
  const errors: unknown[] = [];
  let permission = 0;
  const h = createWebhookHandler({
    secret: SECRET,
    now,
    onSessionCreated: () => {
      throw new Error("boom");
    },
    onPermissionChange: () => void permission++,
    onError: (err) => errors.push(err),
  });
  const a = signed(envelope());
  h.handle(a.raw, a.headers);
  const pc = signed({ ...envelope({ type: "PermissionChange", action: "teamAccessChanged" }), data: { event_id: "pc1", installation_id: "inst1", all_teams: false, team_ids: ["t1"], added_team_ids: [], removed_team_ids: ["t2"] } });
  h.handle(pc.raw, pc.headers);
  await h.idle();
  assert.equal(errors.length, 1);
  assert.equal(permission, 1);
});

test("node:http adapter verifies the raw bytes", async () => {
  let calls = 0;
  const h = createWebhookHandler({ secret: SECRET, now, onSessionCreated: () => void calls++ });
  const server = createServer((req, res) => h.node(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    const { raw, headers } = signed(envelope());
    const ok = await fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", body: raw, headers });
    assert.equal(ok.status, 200);
    const bad = await fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", body: raw + " ", headers });
    assert.equal(bad.status, 401);
    await h.idle();
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test("Ping: no installation, no event_id; acknowledged, passed to onPing, never deduplicated", async () => {
  const pings: unknown[] = [];
  let created = 0;
  const h = createWebhookHandler({ secret: SECRET, now, onPing: (e) => void pings.push(e.data), onSessionCreated: () => void created++ });
  const ping = envelope({ type: "Ping", action: "create", url: "" }) as Record<string, unknown>;
  delete ping["installation_id"];
  delete ping["app_user_id"];
  ping["data"] = { webhook_id: "wh1", label: "Scout" };
  const a = signed(ping);
  const b = signed({ ...ping, webhook_timestamp: NOW + 1 });
  assert.equal(h.handle(a.raw, a.headers).status, 200);
  assert.equal(h.handle(b.raw, b.headers).status, 200);
  await h.idle();
  assert.deepEqual(pings, [{ webhook_id: "wh1", label: "Scout" }, { webhook_id: "wh1", label: "Scout" }]);
  assert.equal(created, 0);
});

test("a non-Ping event without installation_id is reported, not dispatched", async () => {
  const errors: unknown[] = [];
  let created = 0;
  const h = createWebhookHandler({ secret: SECRET, now, onSessionCreated: () => void created++, onError: (e) => errors.push(e) });
  const body = envelope() as Record<string, unknown>;
  delete body["installation_id"];
  const { raw, headers } = signed(body);
  assert.equal(h.handle(raw, headers).status, 200);
  await h.idle();
  assert.equal(created, 0);
  assert.match(String(errors[0]), /without installation_id/);
});
