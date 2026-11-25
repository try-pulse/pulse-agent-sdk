# @try-pulse/agent-sdk

## 0.2.0

### Minor Changes

- 8046b60: Add a durable webhook receiver that verifies signed deliveries and awaits an idempotent inbox write before acknowledgment. Bind verified events to their installation with `PulseAgentClient.forEvent`.

  Deduplicate callback deliveries by installation and occurrence, and handle Stop across reordered deliveries. Callback stores that persist claim keys now receive a JSON-encoded installation/occurrence pair.

  Refuse API and OAuth redirects, bound retry delays, handle cancellation during token lookup and retry waits, and reject stalled activity pagination. Serialize token rotation and revocation within a token manager and reuse the rotated token when concurrent requests receive 401s.

  Sync generated Pulse API types. Check typed fixtures and consumers for changes to issue, project, request and viewer fields, including optional viewer team memberships and required project date granularities.

  Require Node.js `^22.23.4 || ^24.22.1 || >=26.12.1` for Node consumers. Bun remains supported.

## 0.1.1

### Patch Changes

- Ship the TypeScript sources and declaration maps, so source maps and "go to definition" resolve into the SDK's code, and include this changelog in the package.

## 0.1.0

### Minor Changes

- First public release of the TypeScript SDK for Pulse agent apps.
  - Webhooks: `verifyWebhook` checks the `Pulse-Signature` HMAC over the raw body and the signed `webhook_timestamp`; `createWebhookHandler` acknowledges within Pulse's 5-second window, deduplicates by `event_id`, and runs your callbacks afterwards.
  - Sessions: `PulseAgentClient` posts thoughts, actions, elicitations, responses and errors (one `Idempotency-Key` across retries), manages plans and external URLs, and reads and updates the session's issue.
  - Stop: `SessionStops` and `isSessionEnded` cover both ways a session ends — a Stop prompt, and `409 SESSION_ENDED` after uninstall, team removal or issue deletion.
  - Installation: `InstallFlow` runs OAuth with `actor=app` and PKCE; `TokenManager` refreshes rotating tokens single-flight per installation, with memory and JSON-file token stores.
  - Types generated from Pulse's OpenAPI for agent apps and the Agent Session API.
