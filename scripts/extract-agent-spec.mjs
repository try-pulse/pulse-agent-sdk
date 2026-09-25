// Keep this list in step with the named pulse-api types exported from
// packages/sdk/src/types.ts. The session types come from agent-sessions.yaml.
export const SDK_SCHEMAS = [
  "AgentAppScope",
  "AgentSessionComment",
  "AgentSessionEventCreatedData",
  "AgentSessionEventPromptedData",
  "AgentSessionGuidance",
  "AppWebhookAction",
  "AppWebhookEnvelope",
  "AppWebhookEventType",
  "AppWebhookPingData",
  "Error",
  "Issue",
  "IssueStatus",
  "MeResponse",
  "OAuthAppRevokedData",
  "OAuthError",
  "OAuthScope",
  "PermissionChangeData",
  "PromptedActivity",
  "UpdateIssueRequest",
  "WebhookActor",
  "WebhookCommentData",
  "WebhookIssueData",
  "WebhookProjectData",
];

export const SDK_OPERATIONS = {
  "/auth/me": ["get"],
  "/oauth/authorize": ["get"],
  "/oauth/token": ["post"],
  "/oauth/revoke": ["post"],
  "/issues/{id}": ["get", "put"],
};

function unescapePointer(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** A deterministic, bundled OpenAPI projection for the SDK's actual API surface. */
export function createSdkSpec(source, { operations = SDK_OPERATIONS, schemas = SDK_SCHEMAS } = {}) {
  const result = {
    openapi: source.openapi,
    info: {
      title: "Pulse Agent SDK API",
      version: source.info.version,
      description: "The pulse-api operations and webhook types used by @pulse/agent-sdk.",
    },
    servers: [{ url: "https://api.trypulse.tech/api/v1" }],
    ...(source.security && { security: source.security }),
    paths: {},
    components: {},
  };

  for (const [path, methods] of Object.entries(operations)) {
    const sourcePath = source.paths?.[path];
    for (const method of methods) {
      if (!sourcePath?.[method]) throw new Error(`missing operation: ${method.toUpperCase()} ${path}`);
      (result.paths[path] ??= {})[method] = sourcePath[method];
    }
  }

  const pending = [];
  function include(ref) {
    if (!ref.startsWith("#/components/")) throw new Error(`unsupported external reference: ${ref}`);
    const parts = ref.slice(2).split("/").map(unescapePointer);
    let value = source;
    for (const part of parts) value = value?.[part];
    if (value === undefined) throw new Error(`missing component: ${ref}`);
    let target = result;
    for (const part of parts.slice(0, -1)) target = (target[part] ??= {});
    const name = parts.at(-1);
    if (Object.hasOwn(target, name)) return;
    target[name] = value;
    pending.push(value);
  }

  for (const schema of schemas) include(`#/components/schemas/${schema}`);
  pending.push(result.paths, result.security);
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (typeof value.$ref === "string") include(value.$ref);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return result;
}
