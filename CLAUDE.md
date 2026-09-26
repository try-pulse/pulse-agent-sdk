# CLAUDE.md — pulse-agent-sdk

TypeScript SDK for Pulse **agent apps** (third-party agents that a workspace
admin installs, that receive agent sessions over signed webhooks and answer through the Agent
Session API). The normative contract is Pulse's OpenAPI for agent apps and the Agent Session API
(vendored in `specs/`); this repo implements the developer side of it and never defines wire
shapes of its own.

## Layout

| Path | What |
| --- | --- |
| `specs/` | SDK-scoped pulse-api snapshot, pulse-agent `agent-sessions.yaml`, manifest JSON Schema. `SOURCES.md` records revisions. |
| `packages/sdk/` | `@pulse/agent-sdk` — zero runtime dependencies (node:crypto + fetch) |
| `packages/sdk/src/generated/` | Types generated from `specs/`. **Never edit.** |
| `scripts/` | Contract extraction/checks, type generation, manifest schema validation, packed consumer smoke test |

The standalone samples live in sibling repositories `pulse-agent-scout` and
`pulse-claude-managed-agents-demo`. They install a packed SDK like external consumers.

## Commands

```bash
npm ci
npm run types:check      # generated types == specs/ (CI)
npm test                 # SDK unit tests and manifest schema validation
npm run package:smoke    # install the packed SDK in an isolated consumer
npm run specs:sync       # maintainers: needs the Pulse service repos checked out beside this one
npm run generate         # regenerate src/generated after a sync
```

All of these are light and safe on a laptop. Tests and package smoke checks use local fixtures
and do not talk to a real Pulse environment.

## Invariants — each is invisible when broken

- **Wire types come only from `src/generated/`.** `src/types.ts` names and narrows them; it must
  not declare a field. A contract change goes upstream (pulse-api / pulse-agent `docs/openapi`),
  then `specs:sync` + `generate`. If a generated type looks wrong, the spec is wrong: report it
  to the spec's owner rather than patching here.
- **Only the SDK's pulse-api surface is vendored.** `scripts/extract-agent-spec.mjs` selects
  operations and the transitive component closure. Update its allowlist when the SDK's public
  type surface changes, then check that no unrelated or internal API remains.
- **Webhook verification:** HMAC-SHA256 over the **raw** bytes, hex shape checked before
  `Buffer.from(hex)` (it silently truncates), constant-time compare, JSON parsed only from the
  verified bytes, freshness from the signed body `webhook_timestamp` (±60 s). The
  `Pulse-Timestamp` header is unsigned and must never be read.
- **The handler acknowledges first.** `handle()` returns 200 synchronously after verification;
  dedupe on `data.event_id` and the callbacks run on a later tick. Never await a callback before
  answering — Pulse gives the webhook 5 s.
- **Stop handling lives in `src/stop.ts` only.** Two paths, both final: `prompted` with
  `agent_activity.signal === "stop"` (abort, then one final response/error), and
  `409 SESSION_ENDED` on any write (abort, post nothing, never retry). Uninstall, team removal
  and issue deletion end the session at once and reach the app only as the second path.
- **Idempotency-Key is minted once per activity call, before the first attempt**, and reused on
  every retry (≤ 64 chars). Proactive `createOnIssue` is not retried on 5xx (no key on that route).
- **OAuth Basic credentials are raw `id:secret`**, not form-encoded: pulse-api reads them with
  Go's `Request.BasicAuth()`, which does not URL-decode.
- **Token refresh is single-flight per installation.** Refresh tokens rotate; two concurrent
  refreshes lose one to `invalid_grant`, which drops the installation's tokens.

## Git

- Conventional Commits (`type(scope): subject`).
