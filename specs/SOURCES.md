# Vendored contract sources

The SDK's types are generated from these snapshots (`npm run generate`), and CI checks the
generated files against them (`npm run types:check`). The pulse-api snapshot is a generated
projection containing only SDK operations and reachable component schemas. Never edit these
snapshots here: change the source repo, then run `npm run specs:sync && npm run generate`.

| File | Source | Revision | sha256 (16) |
| --- | --- | --- | --- |
| `specs/pulse-api.agent-sdk.yaml` | pulse-api `docs/openapi/bundled.yaml` | `de809bcf3bed` | `6892448a7d07b680` |
| `specs/agent-app-manifest.schema.json` | pulse-api `docs/openapi/schemas/agent-app-manifest.schema.json` | `de809bcf3bed` | `12d8ac78e647e362` |
| `specs/agent-sessions.yaml` | pulse-agent `docs/openapi/agent-sessions.yaml` | `91c78ef9ae28` | `8065de3ac58c2d09` |

Synced 2026-11-25.
