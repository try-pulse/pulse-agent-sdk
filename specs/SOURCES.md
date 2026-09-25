# Vendored contract sources

The SDK's types are generated from these snapshots (`npm run generate`), and CI checks the
generated files against them (`npm run types:check`). The pulse-api snapshot is a generated
projection containing only SDK operations and reachable component schemas. Never edit these
snapshots here: change the source repo, then run `npm run specs:sync && npm run generate`.

| File | Source | Revision | sha256 (16) |
| --- | --- | --- | --- |
| `specs/pulse-api.agent-sdk.yaml` | pulse-api `docs/openapi/bundled.yaml` | `ac05ab8e` | `f39d9e13f7914b05` |
| `specs/agent-app-manifest.schema.json` | pulse-api `docs/openapi/schemas/agent-app-manifest.schema.json` | `ac05ab8e` | `12d8ac78e647e362` |
| `specs/agent-sessions.yaml` | pulse-agent `docs/openapi/agent-sessions.yaml` | `b29b08c` | `8065de3ac58c2d09` |

Synced 2026-09-25.
