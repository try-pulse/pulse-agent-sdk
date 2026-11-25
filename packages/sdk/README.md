# @try-pulse/agent-sdk

[![npm](https://img.shields.io/npm/v/@try-pulse/agent-sdk)](https://www.npmjs.com/package/@try-pulse/agent-sdk)
[![CI](https://github.com/try-pulse/pulse-agent-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/try-pulse/pulse-agent-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/try-pulse/pulse-agent-sdk/blob/main/LICENSE)

TypeScript SDK for Pulse agent apps on Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within the
supported release lines in `package.json`, or on Bun. Install the package
`@try-pulse/agent-sdk`. It verifies signed webhooks, manages OAuth app installations and rotating
tokens, and writes to the Agent Session API. It has no runtime dependencies. Pulse currently
installs a private app only in the workspace where it was registered.

## Install

```bash
npm install @try-pulse/agent-sdk
```

Use the package root with ESM `import` or CommonJS dynamic `import("@try-pulse/agent-sdk")`.

## Wire an agent

Register an app with a person’s session in Pulse, using a manifest whose OAuth redirect and
webhook URLs point to your server. Registration returns the client secret (`pulse_sk_…`) and
webhook secret (`pwhsec_…`) once. An app token cannot register an app. The following creates
the SDK objects used by an HTTP server; the standalone `pulse-agent-scout` repository shows
complete routes for OAuth and webhooks.

```ts
import {
  InstallFlow,
  JsonFileTokenStore,
  PulseAgentClient,
  SessionStops,
  TokenManager,
  createWebhookHandler,
} from "@try-pulse/agent-sdk";

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
    const pulse = await PulseAgentClient.forEvent(tokens, event, { stops });
    const id = event.data.agent_session.id;
    await pulse.thought(id, "Looking at it…", { signal });
    await pulse.respond(id, "Done.", { signal });
  },
  async onSessionPrompted(event, { isStop, signal }) {
    const pulse = await PulseAgentClient.forEvent(tokens, event, { stops });
    if (isStop) {
      await pulse.respond(event.data.agent_session.id, "Stopped.");
    } else if (!signal.aborted) {
      await pulse.respond(event.data.agent_session.id, "I received your follow-up.", { signal });
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

Pulse sends `created` when a person delegates an issue or @mentions the app, and `prompted`
for a follow-up or Stop. Use the raw request body for webhook verification. `Pulse-Signature`
is lowercase hex HMAC-SHA256 over those bytes with the full `pwhsec_…` secret, without a
`sha256=` prefix. The SDK checks the **signed body** `webhook_timestamp` within 60 seconds; the
`Pulse-Timestamp` header is not signed. The handler returns 200 after verification and
dispatches callbacks asynchronously. Deduplication claims use a JSON-encoded array of the
installation ID and occurrence ID. Resource events without an ID use a hash of the signed
occurrence fields. If upgrading a shared callback dedupe store, drain old workers before
switching claim formats. Acknowledge each
delivery within 5 seconds and post a first `thought` or external URL within 10 seconds of
`created`. A session left in `pending` or `active` for 30 minutes with no activity from the
app becomes `stale`; posting any activity recovers it. Callbacks should observe their
`signal`: `elicitation` pauses for input, `response` completes a run, and `error` reports a
blocker. On `prompted`, inspect the Stop signal; a Stop asks for one final `response` or
`error` within 60 seconds.

The callback handler fences work at or before a Stop's signed creation time. A later
prompt can reopen work while the installation still has access. The handler retains idle
ordering records for 24 hours and returns 503 when its `maxOrderedSessions` budget is full.

## Durable webhook intake

```ts
import { createWebhookReceiver, WebhookError, type WebhookIntakeEvent } from "@try-pulse/agent-sdk";

export function webhookEndpoint(config: {
  secret: string;
  workspaceId: string;
  enqueue: (event: WebhookIntakeEvent) => Promise<void>;
}) {
  const receiver = createWebhookReceiver(config);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    try {
      await receiver.receive(await request.arrayBuffer(), request.headers);
      return new Response(null, { status: 200 });
    } catch (error) {
      if (error instanceof WebhookError) return new Response(error.code, { status: error.status });
      return new Response(null, { status: 503 });
    }
  };
}
```

Set the HTTP server's request body limit. In `enqueue`, insert the event using the full
`dedupeKey` as a unique key, treat an already committed key as success, and resolve only
after the transaction commits. Ping is acknowledged without enqueueing. Storage failures
reject `receive` so Pulse can retry. Keep the commit within Pulse's 5-second delivery window.
Process events from the inbox using `PulseAgentClient.forEvent`, and coordinate Stop and
session ordering in your worker. Handle `PermissionChange` for removed teams and drop tokens
on `OAuthApp/revoked`.

## Public surface

| Module | Main exports |
| --- | --- |
| Webhooks | `verifyWebhook`, `createWebhookHandler`, `createWebhookReceiver`, `WebhookError`, `WebhookIntakeEvent`, `DedupeStore`, `MemoryDedupeStore` |
| Sessions | `PulseAgentClient`, `SessionStops`, generated event and activity types |
| Installation | `InstallFlow`, `TokenManager`, `TokenStore`, `MemoryTokenStore`, `JsonFileTokenStore` |
| OAuth | `buildInstallUrl`, `exchangeCode`, `refreshTokens`, `revokeToken` |

`PulseAgentClient` exposes session reads, activity writes (`thought`, `action`, `elicit`,
`respond`, `error`), plans, external URLs, issue reads/status changes, and `request` for
other API routes. SDK types are generated from the scoped pulse-api and Agent Session specs in
[`specs/`](https://github.com/try-pulse/pulse-agent-sdk/tree/main/specs).

## Errors, retries, and storage

- `PulseApiError` carries the HTTP status, Pulse error code, and details. A
  `SessionEndedError` means `409 SESSION_ENDED`: stop work and post nothing else. An
  `InstallationRevokedError` means the installation's tokens are unavailable, were rejected
  during refresh, or Pulse reports a revoked installation; investigate that installation
  before asking an admin to reinstall it.
- Network errors, 408, and 5xx retry only for calls safe to repeat. A `Retry-After` over
  60 seconds is surfaced to the caller. Pass an `AbortSignal` to cancel a supported API
  call, including token waits and retry backoff.
  Activity writes reuse one `Idempotency-Key` across attempts. Proactive issue session
  creation is not retried after a 5xx.
- `JsonFileTokenStore`, `MemoryDedupeStore`, `InstallFlow` state, and `SessionStops` are
  local to one process. For several replicas, use a shared
  `TokenStore` and `DedupeStore`, coordinate OAuth state and session ownership, and durably
  queue deliveries through `createWebhookReceiver`: its `enqueue` callback commits before
  acknowledgement. The SDK's in-process refresh lock does not
  coordinate token rotation across replicas.

## Building in this repository

From a checkout of this repository, install dependencies and compile before using the package
locally. Run both commands from the repository root:

```bash
npm ci
npm run build
```

`npm run build` compiles `@try-pulse/agent-sdk` with `tsc`.
