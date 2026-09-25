# Scout

A deterministic sample agent app for Pulse: no LLM, no API key, just every rule of the
[best practices](https://trypulse.tech/docs/developers/agents/best-practices) in about 300 lines.

| When | Scout does |
| --- | --- |
| `created` | a `thought` ("Looking at PUL-123…") before anything else, a 3-step plan, moves a `backlog`/`todo` issue to `in_progress`, an ephemeral `action` while reading, then an `action` with a result |
| no description | an `elicitation` with `signal: select` (two options; free text also works) |
| otherwise | a `response` summarising the issue, its labels, the guidance it received and the repository hints |
| `prompted` with `signal: "stop"` | aborts the run, drops queued follow-ups, posts one final `response` ("Stopped.") |
| `prompted` during a run | queues it, acknowledges with a `thought`, handles it when the run ends |
| `prompted` otherwise | rebuilds the conversation from `GET /agent-sessions/{id}/activities` and answers |
| a long run | an ephemeral heartbeat `thought` every 5 minutes |
| `409 SESSION_ENDED` on any write | stops quietly (uninstall, team removed, issue deleted) |
| `PermissionChange` | drops the cached access token, stops work on removed teams |
| `OAuthApp` / `revoked` | drops the installation's tokens |

## Run it

```bash
# at the repository root
npm ci && npm run build
cp examples/scout/.env.example examples/scout/.env   # fill it in
set -a; . examples/scout/.env; set +a
npm start --workspace @pulse/agent-sdk-example-scout
```

1. Edit `pulse-agent-app.json`: the redirect URI must be `<BASE_URL>/oauth/callback` and the
   webhook URL `<BASE_URL>/webhook`. It is validated in CI (`npm run manifests:check`).
2. Register it with `POST /api/v1/agent-apps`; keep the client id, client secret and webhook
   secret (shown once).
3. Start Scout, then open `<BASE_URL>/oauth/authorize?install_secret=<INSTALL_SECRET>` as a
   workspace admin and approve.
4. Delegate an issue to Scout, or @mention it in a comment.

To try heartbeats, queued follow-ups and Stop by hand, slow it down:
`SCOUT_STEP_DELAY_MS=20000 SCOUT_HEARTBEAT_MS=15000`.

Docker: `docker build -f examples/scout/Dockerfile -t scout .` from the repository root; mount
a volume at `/data` for the token file.

`npm test --workspace @pulse/agent-sdk-example-scout` runs Scout against a fake Pulse (signed
webhooks in, recorded API calls out); it never talks to a real environment.
