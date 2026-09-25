import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppWebhookEnvelope } from "./types.js";

export const SIGNATURE_HEADER = "pulse-signature";
export const DEFAULT_TOLERANCE_MS = 60_000;

export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export type VerifyWebhookOptions = {
  /** Allowed distance between the body's signed `webhook_timestamp` and now. Default 60 s. */
  toleranceMs?: number;
  now?: () => number;
};

export type WebhookVerificationFailure =
  | "missing_signature"
  | "bad_signature"
  | "invalid_json"
  | "missing_timestamp"
  | "stale_timestamp";

export type VerifyWebhookResult =
  | { ok: true; payload: AppWebhookEnvelope }
  | { ok: false; reason: WebhookVerificationFailure };

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== lower) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function toBytes(rawBody: Uint8Array | ArrayBuffer | string): Buffer {
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  if (rawBody instanceof ArrayBuffer) return Buffer.from(rawBody);
  return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
}

/** Lowercase hex HMAC-SHA256 of the raw body, as Pulse sends it in `Pulse-Signature`. */
export function signWebhook(rawBody: Uint8Array | ArrayBuffer | string, secret: string): string {
  return createHmac("sha256", secret).update(toBytes(rawBody)).digest("hex");
}

/**
 * Verifies an app webhook delivery.
 *
 * 1. `Pulse-Signature` must be the lowercase hex HMAC-SHA256 of the **raw** body bytes,
 *    compared in constant time. Verify before parsing, and parse only the bytes verified.
 * 2. Freshness comes from the body's `webhook_timestamp` (ms), which the signature covers.
 *    The `Pulse-Timestamp` header is NOT signed and is never read here.
 */
export function verifyWebhook(
  rawBody: Uint8Array | ArrayBuffer | string,
  headers: HeaderSource,
  secret: string,
  { toleranceMs = DEFAULT_TOLERANCE_MS, now = Date.now }: VerifyWebhookOptions = {},
): VerifyWebhookResult {
  if (!secret) throw new Error("verifyWebhook: the webhook secret is empty");
  const provided = headerValue(headers, SIGNATURE_HEADER)?.trim();
  if (!provided) return { ok: false, reason: "missing_signature" };
  // Buffer.from(hex) silently drops a bad tail, so the shape is checked first.
  if (!HEX_SHA256.test(provided)) return { ok: false, reason: "bad_signature" };

  const bytes = toBytes(rawBody);
  const expected = createHmac("sha256", secret).update(bytes).digest();
  const actual = Buffer.from(provided, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const ts = (payload as { webhook_timestamp?: unknown } | null)?.webhook_timestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return { ok: false, reason: "missing_timestamp" };
  if (Math.abs(now() - ts) > toleranceMs) return { ok: false, reason: "stale_timestamp" };
  return { ok: true, payload: payload as AppWebhookEnvelope };
}
