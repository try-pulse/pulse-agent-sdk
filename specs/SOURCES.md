# Vendored contract sources

The SDK's types are generated from these snapshots (`npm run generate`), and CI checks the
generated files against them (`npm run types:check`). The pulse-api snapshot is a generated
projection containing only SDK operations and reachable component schemas. Never edit these
snapshots here: change the source repo, then run `npm run specs:sync && npm run generate`.

| File | Source | Revision | sha256 (16) |
| --- | --- | --- | --- |
| `specs/pulse-api.agent-sdk.yaml` | pulse-api `docs/openapi/bundled.yaml` | `26449433` | `39205fb817dd612b` |
| `specs/agent-app-manifest.schema.json` | pulse-api `docs/openapi/schemas/agent-app-manifest.schema.json` | `26449433` | `12d8ac78e647e362` |
| `specs/agent-sessions.yaml` | pulse-agent `docs/openapi/agent-sessions.yaml` | `570e9f5` | `8065de3ac58c2d09` |

Synced 2026-09-26.
