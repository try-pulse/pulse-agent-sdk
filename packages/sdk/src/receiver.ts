import { createHash } from "node:crypto";
import type { AppWebhookEnvelope } from "./types.js";
import { verifyWebhook, type HeaderSource } from "./webhooks.js";

const resourceTypes = new Set(["Issue", "Comment", "Project"]);

export type WebhookIntakeEvent = {
  payload: AppWebhookEnvelope;
  dedupeKey: readonly [installationId: string, occurrence: string] | null;
  sessionId: string | null;
  isStop: boolean;
  isRevoked: boolean;
};

export class WebhookError extends Error {
  override name = "WebhookError";
  constructor(readonly status: number, readonly code: string) {
    super(`Pulse webhook refused (${code})`);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebhookError(400, "invalid_event");
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new WebhookError(400, "invalid_event");
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const values = record(value);
    const fields = Object.keys(values).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(values[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function occurrenceKey(payload: AppWebhookEnvelope): string {
  const data = record(payload.data);
  if (!resourceTypes.has(payload.type) || Object.hasOwn(data, "event_id")) return requiredText(data.event_id);
  const signedOccurrence = { ...payload } as Partial<AppWebhookEnvelope>;
  delete signedOccurrence.webhook_timestamp;
  try {
    return `body:${createHash("sha256").update(canonicalJson(signedOccurrence)).digest("hex")}`;
  } catch (err) {
    if (err instanceof RangeError) throw new WebhookError(400, "invalid_event");
    throw err;
  }
}

function validateInstallationChange(type: string, action: string, installationId: string, data: Record<string, unknown>) {
  const revoked = type === "OAuthApp" && action === "revoked";
  const permissions = type === "PermissionChange" && action === "teamAccessChanged";
  if ((revoked || permissions) && data.installation_id !== installationId) throw new WebhookError(400, "invalid_event");
  if (revoked) requiredText(data.app_id);
  if (permissions) {
    if (typeof data.all_teams !== "boolean") throw new WebhookError(400, "invalid_event");
    for (const field of ["team_ids", "added_team_ids", "removed_team_ids"]) {
      const teams = data[field];
      if (!Array.isArray(teams)) throw new WebhookError(400, "invalid_event");
      teams.forEach(requiredText);
    }
  }
}

export type WebhookReceiverOptions = {
  secret: string;
  workspaceId: string;
  /** Idempotently persist the occurrence before returning. Ping is never enqueued. */
  enqueue: (event: WebhookIntakeEvent) => Promise<void>;
  now?: () => number;
  maxBodyBytes?: number;
};

/** Verify and enqueue before acknowledgment. Use createWebhookHandler for callback mode. */
export function createWebhookReceiver(options: WebhookReceiverOptions) {
  const limit = options.maxBodyBytes ?? 1024 * 1024;
  if (!options.secret || !options.workspaceId || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("A Pulse webhook secret, workspace and positive body limit are required");
  }
  return {
    async receive(raw: Uint8Array | ArrayBuffer | string, headers: HeaderSource): Promise<WebhookIntakeEvent> {
      if ((typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength) > limit) {
        throw new WebhookError(413, "body_too_large");
      }
      const result = verifyWebhook(raw, headers, options.secret, options.now ? { now: options.now } : {});
      if (!result.ok) {
        const code = result.reason === "missing_timestamp" ? "invalid_timestamp" : result.reason;
        const status = code === "invalid_timestamp" || code === "invalid_json" ? 400 : 401;
        throw new WebhookError(status, code);
      }
      const payload = result.payload;
      const type = requiredText(payload.type);
      const action = requiredText(payload.action);
      const workspaceId = requiredText(payload.workspace_id);
      const data = record(payload.data);
      const event: WebhookIntakeEvent = { payload, dedupeKey: null, sessionId: null, isStop: false, isRevoked: false };
      if (type !== "Ping") {
        const installationId = requiredText(payload.installation_id);
        requiredText(payload.app_user_id);
        validateInstallationChange(type, action, installationId, data);
        event.dedupeKey = [installationId, occurrenceKey(payload)];
        if (type === "AgentSessionEvent") {
          event.sessionId = requiredText(record(data.agent_session).id);
          event.isStop = action === "prompted" && record(data.agent_activity).signal === "stop";
        }
        event.isRevoked = type === "OAuthApp" && action === "revoked";
      }
      if (workspaceId !== options.workspaceId) throw new WebhookError(403, "wrong_workspace");
      if (event.dedupeKey !== null) await options.enqueue(event);
      return event;
    },
  };
}
