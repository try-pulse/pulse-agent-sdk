# Contributing

## Local checks

Use Node.js 22+ and npm. From the repository root:

```bash
npm ci
npm run check
npm run package:smoke
```

The Claude example has its own Bun lockfile. When changing it, run:

```bash
cd examples/claude-managed-agents
bun install --frozen-lockfile
bun run typecheck
bun test
```

Include a focused regression test for behavioral changes. SDK tests use Node's built-in test
runner; the Claude example uses `bun:test`. Tests and samples should use synthetic data and
fake Pulse or Anthropic responses, never live credentials.

## Contract changes

The source of every wire type is Pulse's OpenAPI contract. Change the owning source repository
first. With `pulse-api` and `pulse-agent` checked out next to this repository, run
`npm run specs:sync && npm run generate && npm run check`. The sync command extracts only the
SDK's pulse-api surface and records source revisions in [`specs/SOURCES.md`](specs/SOURCES.md).
Do not edit `packages/sdk/src/generated/` or add hand-written wire fields in
`packages/sdk/src/types.ts`.

Keep webhook verification over the raw signed body, acknowledge promptly, reuse one idempotency
key across activity retries, and never retry `409 SESSION_ENDED`. These behaviors have focused
tests and are part of the SDK contract.

## Pull requests

Describe the behavior changed, the contract revision if relevant, and the exact checks run.
Keep changes scoped to one concern. CI runs the root checks, the packed consumer smoke test,
and the Bun example checks without live service credentials.
