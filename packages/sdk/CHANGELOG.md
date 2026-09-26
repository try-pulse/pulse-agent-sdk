# @try-pulse/agent-sdk

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
