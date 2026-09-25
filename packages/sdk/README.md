# @pulse/agent-sdk

TypeScript SDK for Pulse agent apps on Node.js 22+ or Bun. It verifies signed webhooks, manages
OAuth app installations and rotating tokens, and writes to the Agent Session API. It has no
runtime dependencies. Pulse currently installs a private app only in the workspace where it was
registered.

## Wire an agent

Inside this repository, run `npm ci && npm run build` first. Register an app with a person’s
session in Pulse, using a manifest whose OAuth redirect and webhook URLs point to your server.
Registration returns the client secret (`pulse_sk_…`) and webhook secret (`pwhsec_…`) once. An
app token cannot register an app. The following creates the SDK objects used by an HTTP server;
the standalone `pulse-agent-scout` repository shows complete routes for OAuth and webhooks.

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

The install flow sends the admin through OAuth with `actor=app`, PKCE S256 and a single-use
`state`. It stores tokens by `installation_id`; the client sends the app's bearer token and
`X-Workspace-ID` on API calls. Keep the install endpoint behind `INSTALL_SECRET`.

Use the raw request body for webhook verification. `Pulse-Signature` is lowercase hex
HMAC-SHA256 over those bytes with the full `pwhsec_…` secret, without a `sha256=` prefix.
The SDK checks the **signed body** `webhook_timestamp` within 60 seconds; the
`Pulse-Timestamp` header is not signed. The handler returns 200 after verification and
dispatches callbacks asynchronously, deduplicating by `data.event_id`. Acknowledge each
delivery within 5 seconds and post a first `thought` or external URL within 10 seconds of
`created`. Callbacks should observe their `signal`: `elicitation` pauses for input, `response`
completes a run, and `error` reports a blocker. On `prompted`, inspect the Stop signal; a Stop
asks for one final `response` or `error` within 60 seconds.

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
  `InstallationRevokedError` means the installation's tokens are unavailable, were rejected
  during refresh, or Pulse reports a revoked installation; investigate that installation
  before asking an admin to reinstall it.
- Network errors, 408, and 5xx retry only for calls safe to repeat; 429 honors `Retry-After`.
  Activity writes reuse one `Idempotency-Key` across attempts. Proactive issue session
  creation is not retried after a 5xx.
- `JsonFileTokenStore`, `MemoryDedupeStore`, `InstallFlow` state, and `SessionStops` are
  local to one process. For several replicas, use a shared
  `TokenStore` and `DedupeStore`, coordinate OAuth state and session ownership, and durably
  queue work after webhook acknowledgement. The SDK's in-process refresh lock does not
  coordinate token rotation across replicas.
