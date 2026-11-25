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

When the contract or webhook vectors change, refresh the corresponding pinned copies in
the standalone `pulse-agent-sdk-python` repository and run both SDK test suites.

## Contract changes

The source of every wire type is Pulse's OpenAPI contract. Change the owning source repository
first. With `pulse-api` and `pulse-agent` checked out next to this repository, run
`npm run specs:sync && npm run generate && npm run check`. The sync command extracts only the
SDK's pulse-api surface and records source revisions in [`specs/SOURCES.md`](specs/SOURCES.md).
Set `PULSE_API_DIR` and `PULSE_AGENT_DIR` when the checkouts are elsewhere. The sync reads committed Git objects; select production or staging with `PULSE_API_REF` and `PULSE_AGENT_REF`. Run `npm run specs:sync -- --check` with the same refs to compare upstream without writing files.

The **Compare upstream SDK contracts** GitHub Actions workflow checks both `main` and `staging` against the service mirrors. Set repository variables `PULSE_API_CONTRACT_REPO` and `PULSE_AGENT_CONTRACT_REPO` to the corresponding GitHub `owner/repo` names. Configure an `upstream-contracts` environment restricted to the `main` branch. Store its environment secret `PULSE_UPSTREAM_READ_TOKEN` as a fine-grained token with Contents read access limited to those two repositories. Run the workflow manually on SDK `main`. Set the repository variable `PULSE_UPSTREAM_CHECK_ENABLED=true` to enable its weekly check. Pull-request CI uses the public snapshots.
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
