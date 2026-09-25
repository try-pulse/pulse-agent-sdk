# CLAUDE.md — pulse-agent-sdk

TypeScript SDK and sample agents for Pulse **agent apps** (third-party agents that a workspace
admin installs, that receive agent sessions over signed webhooks and answer through the Agent
Session API). Project "Third-party Agent Apps", story PUL-929, sub-issue PUL-929-4. The
normative contract is the project main document ("Contract v2"); this repo implements the
developer side of it and never defines wire shapes of its own.

## Layout

| Path | What |
| --- | --- |
| `specs/` | SDK-scoped pulse-api snapshot, pulse-agent `agent-sessions.yaml`, manifest JSON Schema. `SOURCES.md` records revisions. |
| `packages/sdk/` | `@pulse/agent-sdk` — zero runtime dependencies (node:crypto + fetch) |
| `packages/sdk/src/generated/` | Types generated from `specs/`. **Never edit.** |
| `examples/scout/` | Deterministic sample (no LLM), in the npm workspace, tested against a fake Pulse |
| `examples/claude-managed-agents/` | Bun port of `linear/claude-managed-agents-demo`; **not** in the npm workspace (own `bun.lock`) |
| `scripts/` | Contract extraction/checks, type generation, manifest validation, packed consumer smoke test |

## Commands

```bash
npm ci
npm run types:check      # generated types == specs/ (CI)
npm test                 # SDK unit tests, Scout against a fake Pulse, manifest validation
npm run package:smoke    # install the packed SDK in an isolated consumer
npm run specs:sync       # extract scoped spec from ../pulse-api, copy pulse-agent spec
npm run generate         # regenerate src/generated after a sync
cd examples/claude-managed-agents && bun install --frozen-lockfile && bun run typecheck && bun test
```

All of these are light and safe on a laptop. Nothing here talks to a real Pulse environment;
never point the samples at one from an agent session.

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
  and issue deletion reach the app only as the second path (owner confirmation pending on the
  contract; keep both paths working so either outcome needs no SDK change).
- **Idempotency-Key is minted once per activity call, before the first attempt**, and reused on
  every retry (≤ 64 chars). Proactive `createOnIssue` is not retried on 5xx (no key on that route).
- **OAuth Basic credentials are raw `id:secret`**, not form-encoded: pulse-api reads them with
  Go's `Request.BasicAuth()`, which does not URL-decode.
- **Token refresh is single-flight per installation.** Refresh tokens rotate; two concurrent
  refreshes lose one to `invalid_grant`, which drops the installation's tokens.

## Git

- The current `origin` is GitLab. GitHub is the intended development home; do not push as
  part of repository cleanup.
- Never create branches. Commit to the checked-out branch; the owner pushes.
- Conventional Commits (`type(scope): subject`).
