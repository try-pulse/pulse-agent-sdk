# @pulse/agent-sdk

TypeScript SDK for Pulse agent apps on Node.js 22+ or Bun. It verifies signed webhooks, manages
OAuth app installations and rotating tokens, and writes to the Agent Session API. It has no
runtime dependencies.

## Wire an agent

Inside this repository, run `npm ci && npm run build` first. The following creates the SDK
objects used by an HTTP server; [Scout](../../examples/scout/src/main.ts) shows complete routes
for OAuth and webhooks.

```ts
import {
  InstallFlow,
  JsonFileTokenStore,
  PulseAgentClient,
  SessionStops,
  TokenManager,
  createWebhookHandler,
} from "@pulse/agent-sdk";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const baseUrl = required("BASE_URL").replace(/\/+$/, "");
const oauth = {
  clientId: required("PULSE_CLIENT_ID"),
  clientSecret: required("PULSE_CLIENT_SECRET"),
  redirectUri: `${baseUrl}/oauth/callback`,
};
const stops = new SessionStops();
const tokens = new TokenManager({
  store: new JsonFileTokenStore(".pulse-tokens.json"),
  oauth,
});
const install = new InstallFlow({
  oauth,
  tokens,
  installSecret: required("INSTALL_SECRET"),
});
const webhook = createWebhookHandler({
  secret: required("PULSE_WEBHOOK_SECRET"),
  stops,
  async onSessionCreated(event, { signal }) {
    const pulse = new PulseAgentClient({
      tokenProvider: tokens.tokenProvider(event.installation_id),
      workspaceId: event.workspace_id,
      stops,
    });
    const id = event.data.agent_session.id;
    await pulse.thought(id, "Looking at it…");
    if (!signal.aborted) await pulse.respond(id, "Done.");
  },
  async onSessionPrompted(event, { isStop, signal }) {
    const pulse = new PulseAgentClient({
      tokenProvider: tokens.tokenProvider(event.installation_id),
      workspaceId: event.workspace_id,
      stops,
    });
    if (isStop) {
      await pulse.respond(event.data.agent_session.id, "Stopped.");
    } else if (!signal.aborted) {
      await pulse.respond(event.data.agent_session.id, "I received your follow-up.");
    }
  },
  onRevoked: (event) => tokens.forget(event.installation_id),
});

// GET /oauth/authorize: redirect to install.start(providedInstallSecret)
// GET /oauth/callback: await install.complete({ code, state, error })
// POST /webhook: webhook.node(req, res) in node:http, or webhook.fetch(request) in Bun.
void install;
void webhook;
```

Use the raw request body for webhook verification. The handler returns 200 after verification,
then dispatches callbacks asynchronously. Pulse expects a thought quickly; callbacks should
observe their `signal` and finish each session with a response, elicitation, or error.

## Public surface

| Module | Main exports |
| --- | --- |
| Webhooks | `verifyWebhook`, `createWebhookHandler`, `DedupeStore`, `MemoryDedupeStore` |
| Sessions | `PulseAgentClient`, `SessionStops`, generated event and activity types |
| Installation | `InstallFlow`, `TokenManager`, `TokenStore`, `MemoryTokenStore`, `JsonFileTokenStore` |
| OAuth | `buildInstallUrl`, `exchangeCode`, `refreshTokens`, `revokeToken` |

`PulseAgentClient` exposes session reads, activity writes (`thought`, `action`, `elicit`,
`respond`, `error`), plans, external URLs, issue reads/status changes, and `request` for
other API routes. SDK types are generated from the scoped pulse-api and Agent Session specs in
[`specs/`](../../specs).

## Errors, retries, and storage

- `PulseApiError` carries the HTTP status, Pulse error code, and details. A
  `SessionEndedError` means `409 SESSION_ENDED`: stop work and post nothing else. An
  `InstallationRevokedError` means the app must be installed again.
- Network errors, 408, and 5xx retry only for calls safe to repeat; 429 honors `Retry-After`.
  Activity writes reuse one `Idempotency-Key` across attempts. Proactive issue session
  creation is not retried after a 5xx.
- `JsonFileTokenStore`, `MemoryDedupeStore`, `InstallFlow` state, and `SessionStops` are
  local to one process. The sample runs one process. For several replicas, use a shared
  `TokenStore` and `DedupeStore`, coordinate OAuth state and session ownership, and durably
  queue work after webhook acknowledgement. The SDK's in-process refresh lock does not
  coordinate token rotation across replicas.
