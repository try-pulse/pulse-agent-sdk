# Pulse Agent SDK

Build an agent app that receives delegated issues and @mentions in Pulse, then replies with
thoughts, actions, questions, and results through the Agent Session API.

This repository contains the TypeScript SDK and two example agents. The SDK supports Node.js 22+
and Bun, has no runtime dependencies, and derives its wire types from Pulse OpenAPI contracts.

## Start here

From this checkout, install dependencies and verify the SDK:

```bash
npm ci
npm run check
npm run build
```

To build an agent, use [Scout's server](examples/scout/src/main.ts) as the wiring example: it
handles OAuth installation, verifies webhooks, stores installation tokens, and acknowledges
deliveries before starting work. Put the agent's behavior in a callback like
[Scout's](examples/scout/src/scout.ts). The [SDK guide](packages/sdk/README.md) explains the
public API and error handling.

## Run Scout

Scout is deterministic and needs no model key. Register its
[manifest](examples/scout/pulse-agent-app.json) in Pulse after changing the redirect and webhook
URLs to your public HTTPS `BASE_URL`. Keep the client ID, client secret, and webhook secret
returned by registration.

```bash
cp examples/scout/.env.example examples/scout/.env
# Fill in PULSE_CLIENT_ID, PULSE_CLIENT_SECRET, PULSE_WEBHOOK_SECRET,
# INSTALL_SECRET, and BASE_URL in examples/scout/.env.
set -a; . examples/scout/.env; set +a
npm start --workspace @pulse/agent-sdk-example-scout
```

Open `<BASE_URL>/oauth/authorize?install_secret=<INSTALL_SECRET>` as a workspace admin, approve
the installation, then delegate an issue or @mention Scout. The
[Scout guide](examples/scout/README.md) covers its behavior, Docker image, and fake Pulse tests.

## Repository map

| Path | Purpose |
| --- | --- |
| [`packages/sdk`](packages/sdk) | Webhook handler, Agent Session client, OAuth flow, token management |
| [`examples/scout`](examples/scout) | Tested Node.js sample with no LLM |
| [`examples/claude-managed-agents`](examples/claude-managed-agents) | Bun bridge to Claude Managed Agents |
| [`specs`](specs) | SDK-scoped OpenAPI snapshot, Agent Session spec, manifest schema, source revisions |

The Claude bridge has its own Bun lockfile. In that directory, run `bun install --frozen-lockfile`,
`bun run typecheck`, and `bun test`. See its [setup guide](examples/claude-managed-agents/README.md).

## Development

```bash
npm run types:check   # scoped contract and generated types match
npm run check         # contract, script, SDK, Scout, and manifest tests
npm run package:smoke # pack, install, import, and typecheck as a consumer
```

Contract snapshots come from Pulse's source repositories. Update them with `npm run specs:sync`
only when both sibling checkouts are available, then run `npm run generate` and the checks above.
The SDK does not define wire shapes by hand. See [source revisions](specs/SOURCES.md) and
[contribution guide](CONTRIBUTING.md).

Developer documentation: [Pulse agent apps](https://trypulse.tech/docs/developers/agents).
