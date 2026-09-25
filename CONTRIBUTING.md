# Contributing

## Local checks

Use Node.js 22+ and npm. From the repository root:

```bash
npm ci
npm run check
npm run package:smoke
```

Include a focused regression test for behavioral changes. SDK tests use Node's built-in test
runner. Tests should use synthetic data and fake Pulse responses, never live credentials.
The Scout and Claude examples live in their own sibling repositories and have separate checks.

## Contract changes

The source of every wire type is Pulse's OpenAPI contract. Change the owning source repository
first. With `pulse-api` and `pulse-agent` checked out next to this repository, run
`npm run specs:sync && npm run generate && npm run check`. The sync command extracts only the
SDK's pulse-api surface and records source revisions in [`specs/SOURCES.md`](specs/SOURCES.md).
Do not edit `packages/sdk/src/generated/` or add hand-written wire fields in
`packages/sdk/src/types.ts`.

Verify `Pulse-Signature` over the raw body and use its signed `webhook_timestamp` for freshness;
the `Pulse-Timestamp` header is not signed. Acknowledge webhooks within 5 seconds, reuse one
`Idempotency-Key` across activity retries, and never retry `409 SESSION_ENDED`. These behaviors
have focused tests and are part of the SDK contract.

## Pull requests

Describe the behavior changed, the contract revision if relevant, and the exact checks run.
Keep changes scoped to one concern. CI runs the root checks and the packed consumer smoke test
without live service credentials.
