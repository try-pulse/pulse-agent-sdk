# Pulse Agent SDK

Build an agent app that receives delegated issues and @mentions in Pulse, then replies with
`thought`, `action`, `elicitation`, `response`, and `error` activities through the Agent Session API.
Pulse sends `AgentSessionEvent` / `created` for a new session and `prompted` for follow-ups and
Stop requests. The app runs on your infrastructure and is installed into its developer workspace.

The SDK supports Node.js 22+ and Bun, has no runtime dependencies, and derives its wire types
from Pulse OpenAPI contracts.

## Start here

From this checkout, install dependencies and verify the SDK:

```bash
npm ci
npm run check
npm run build
```

The [SDK guide](packages/sdk/README.md) shows how to wire OAuth installation, signed webhooks,
token storage, and session activities into your HTTP server. For registration, scopes, and the
full wire contract, see the [Pulse agent app docs](https://trypulse.tech/docs/developers/agents).

## Sample agents

Complete agents live in separate sibling repositories. Each has its own README, dependency
installation, tests, and runtime configuration:

| Repository | Purpose |
| --- | --- |
| `pulse-agent-scout` | Deterministic Node.js agent with a fake Pulse test path |
| `pulse-claude-managed-agents-demo` | Bun bridge to Claude Managed Agents |

With all three repositories checked out side by side, find them at `../pulse-agent-scout` and
`../pulse-claude-managed-agents-demo`. They consume the packed SDK as external apps.

## Repository map

| Path | Purpose |
| --- | --- |
| [`packages/sdk`](packages/sdk) | Webhook handler, Agent Session client, OAuth flow, token management |
| [`specs`](specs) | SDK-scoped OpenAPI snapshot, Agent Session spec, manifest schema, source revisions |
| [`scripts`](scripts) | Contract extraction, type generation, schema checks, packed consumer test |

## Development

```bash
npm run types:check   # scoped contract and generated types match
npm run check         # contract, script, SDK, and manifest schema tests
npm run package:smoke # pack, install, import, and typecheck as a consumer
cd packages/sdk && npm pack --dry-run
```

Contract snapshots come from Pulse's source repositories. Update them with `npm run specs:sync`
only when both sibling checkouts are available, then run `npm run generate` and the checks above.
The SDK does not define wire shapes by hand. See [source revisions](specs/SOURCES.md) and
[contribution guide](CONTRIBUTING.md). Report vulnerabilities through the
[security policy](SECURITY.md).

Developer documentation: [Pulse agent apps](https://trypulse.tech/docs/developers/agents).
