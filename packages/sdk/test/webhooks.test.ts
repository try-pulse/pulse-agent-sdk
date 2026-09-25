import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyWebhook, signWebhook } from "../src/webhooks.js";
import { SECRET, NOW, envelope, signed } from "./_helpers.js";

const now = () => NOW;

test("accepts a correctly signed, fresh delivery", () => {
  const { raw, headers } = signed(envelope());
  const r = verifyWebhook(raw, headers, SECRET, { now });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.payload.installation_id, "inst1");
});

test("accepts raw bytes and a fetch Headers object", () => {
  const { raw, headers } = signed(envelope());
  const r = verifyWebhook(new TextEncoder().encode(raw), new Headers(headers), SECRET, { now });
  assert.equal(r.ok, true);
});

test("rejects a tampered body", () => {
  const { raw, headers } = signed(envelope());
  const tampered = raw.replace("inst1", "inst2");
  assert.deepEqual(verifyWebhook(tampered, headers, SECRET, { now }), { ok: false, reason: "bad_signature" });
});

test("rejects a signature made with another secret", () => {
  const { raw, headers } = signed(envelope(), "pwhsec_other");
  assert.deepEqual(verifyWebhook(raw, headers, SECRET, { now }), { ok: false, reason: "bad_signature" });
});

test("rejects a missing or malformed signature header", () => {
  const { raw, headers } = signed(envelope());
  assert.deepEqual(verifyWebhook(raw, {}, SECRET, { now }), { ok: false, reason: "missing_signature" });
  const truncated = { "Pulse-Signature": headers["Pulse-Signature"].slice(0, 62) + "zz" };
  assert.deepEqual(verifyWebhook(raw, truncated, SECRET, { now }), { ok: false, reason: "bad_signature" });
  const prefixed = { "Pulse-Signature": `sha256=${headers["Pulse-Signature"]}` };
  assert.deepEqual(verifyWebhook(raw, prefixed, SECRET, { now }), { ok: false, reason: "bad_signature" });
});

test("rejects a stale body webhook_timestamp (both directions)", () => {
  for (const ts of [NOW - 60_001, NOW + 60_001]) {
    const { raw, headers } = signed(envelope({ webhook_timestamp: ts }));
    assert.deepEqual(verifyWebhook(raw, headers, SECRET, { now }), { ok: false, reason: "stale_timestamp" });
  }
  const { raw, headers } = signed(envelope({ webhook_timestamp: NOW - 60_000 }));
  assert.equal(verifyWebhook(raw, headers, SECRET, { now }).ok, true);
});

test("a forged fresh Pulse-Timestamp header does not rescue a stale body", () => {
  const { raw, headers } = signed(envelope({ webhook_timestamp: NOW - 10 * 60_000 }));
  const forged = { ...headers, "Pulse-Timestamp": String(NOW) };
  assert.deepEqual(verifyWebhook(raw, forged, SECRET, { now }), { ok: false, reason: "stale_timestamp" });
});

test("a stale Pulse-Timestamp header is ignored when the signed body is fresh", () => {
  const { raw, headers } = signed(envelope());
  const staleHeader = { ...headers, "Pulse-Timestamp": String(NOW - 3_600_000) };
  assert.equal(verifyWebhook(raw, staleHeader, SECRET, { now }).ok, true);
});

test("a body without webhook_timestamp is refused", () => {
  const body = envelope();
  delete (body as Record<string, unknown>)["webhook_timestamp"];
  const { raw, headers } = signed(body);
  assert.deepEqual(verifyWebhook(raw, headers, SECRET, { now }), { ok: false, reason: "missing_timestamp" });
});

test("signed garbage is invalid_json, not a crash", () => {
  const raw = "{not json";
  const headers = { "pulse-signature": signWebhook(raw, SECRET) };
  assert.deepEqual(verifyWebhook(raw, headers, SECRET, { now }), { ok: false, reason: "invalid_json" });
});
