# Claude + Pulse Agent Bridge

**_An example project, not meant for production use._**

A Pulse port of [`linear/claude-managed-agents-demo`](https://github.com/linear/claude-managed-agents-demo):
a bridge server that connects a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview)
to Pulse's agent apps. When someone delegates an issue to the app or @mentions it in a comment,
Pulse sends an `AgentSessionEvent` webhook; the server forwards the request to a Claude Managed
Agent session and relays Claude's work back as agent activities.

## How it works

1. A person @mentions the app in a Pulse comment, or delegates an issue to it
2. Pulse sends an `AgentSessionEvent` webhook to `/webhook`
3. The server verifies it, answers `200` at once, and posts a `thought` (required within 10 s)
4. A Claude Managed Agent session is created with the issue context (`prompt_context`)
5. Claude's tool uses show up as ephemeral `action` activities; its answer is posted as a `response` (or an `error`)
6. Stop in Pulse interrupts the Claude session and posts one final `response`

## Prerequisites

- [Bun](https://bun.sh)
- An Anthropic API key, and a Claude Managed Agent (agent id + environment id) created once,
  in the Console or with the `ant` CLI — never per request
- A Pulse workspace where you are an owner or admin, with agent apps enabled
- `@pulse/agent-sdk` built: `npm ci && npm run build` at the repository root

## Setup

```bash
bun install --frozen-lockfile
cp .env.example .env.local
```

1. Register the app: `POST https://api.trypulse.tech/api/v1/agent-apps` with `pulse-agent-app.json`
   (change the two URLs to your `BASE_URL` first). Copy the client id, client secret and webhook
   secret from the response; the secrets are shown once.
2. Fill in `.env.local`:

   | Variable | Description |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | Your Anthropic API key |
   | `CLAUDE_AGENT_ID` | Claude Managed Agent id |
   | `CLAUDE_ENVIRONMENT_ID` | Claude environment id |
   | `PULSE_CLIENT_ID` | From the app registration |
   | `PULSE_CLIENT_SECRET` | From the app registration (`pulse_sk_…`) |
   | `PULSE_WEBHOOK_SECRET` | From the app registration (`pwhsec_…`) |
   | `INSTALL_SECRET` | Any long random string; guards `/oauth/authorize` |
   | `PORT` | Server port (default `3000`) |
   | `BASE_URL` | Public HTTPS URL of this server |
   | `PULSE_API_URL` | Default `https://api.trypulse.tech/api/v1` |

3. `bun run dev`
4. Install: open `<BASE_URL>/oauth/authorize?install_secret=<INSTALL_SECRET>` as a workspace
   admin, pick the teams, approve.
5. @mention the app in a comment on an issue in one of those teams.

The server validates required credentials, `BASE_URL`, and `PORT` on startup. To check the
bridge without live Pulse or Anthropic credentials, run `bun run typecheck && bun test`;
the tests use fake service boundaries.

## Every difference from the Linear version

| Linear demo | This port | Why |
| --- | --- | --- |
| `LinearWebhookClient(secret).createHandler()` | `createWebhookHandler({ secret, … })` from `@pulse/agent-sdk` | Pulse's webhook SDK |
| `Linear-Signature` header | `Pulse-Signature`: lowercase hex HMAC-SHA256 of the **raw** body | Pulse's signature |
| `webhookTimestamp` (checked by the Linear SDK) | `webhook_timestamp` in the **signed body**, ±60 s; the `Pulse-Timestamp` header is unsigned and ignored | Freshness must come from signed data |
| Without a signing secret, webhooks are accepted unverified | No secret, no start | Unsigned delivery is never trusted |
| Handler runs the work with `.catch()` | The SDK answers `200` first, then dedupes on `data.event_id`, then calls back | Pulse's 5 s budget; at-least-once delivery |
| `/oauth/authorize` with no PKCE, no `state`, open to anyone | `InstallFlow`: PKCE `S256`, single-use `state`, install secret | Pulse requires PKCE; `linear-pi-agent` pattern |
| `client_secret` in the form body | HTTP Basic (`client_secret_basic`) | Both work; Basic is what discovery advertises |
| Token store keyed by `organizationId` (from a GraphQL query) | Keyed by `installation_id` (in the token response and every webhook), with `workspace_id` | Pulse installs per workspace + teams |
| Manual refresh 5 min before expiry | `TokenManager`: same window, single-flight, stores the rotated refresh token | Pulse refresh tokens rotate; access tokens last 1 h |
| `{ organization { id name } }` after install | `GET /api/v1/auth/me` | Pulse's `viewer` |
| `event.agentSession`, `event.promptContext`, `event.previousComments`, `event.agentActivity.content.body`, `event.organizationId` | `event.data.agent_session`, `event.data.prompt_context`, `event.data.previous_comments`, `event.data.agent_activity.content.body`, `event.installation_id` | snake_case envelope v1 |
| `issue.description` in the fallback prompt | Not on `agent_session.issue`; it is inside `prompt_context` | Pulse payload |
| `linear.createAgentActivity(...)` (GraphQL) | `pulse.thought / action / respond / error(...)` → `POST /api/v1/agent-sessions/{id}/activities` with an `Idempotency-Key` | REST; retries never post twice |
| Every request needs only the bearer | `X-Workspace-ID` on every call (the SDK adds it) | Pulse API |
| Only `agent.tool_use` becomes an action | `agent.tool_use`, `agent.mcp_tool_use` and `agent.custom_tool_use` | MCP and custom tools are tool uses too |
| `parameter: ""` | `parameter: null` | The contract's "no parameter" |
| `break` on any `session.status_idle` | Break on `session.status_terminated`, or idle with `stop_reason.type !== "requires_action"` | Idle is transient while Claude waits on a tool |
| Posts nothing when Claude returns no text | Posts a short `response` | Every Pulse session must end with a response, elicitation or error |
| No stop handling | `agent_activity.signal === "stop"` → `user.interrupt` to Claude, one final `response`; a `409 SESSION_ENDED` on any write stops the run silently | Pulse specifies Stop; uninstall/team removal end sessions without a prompt |
| — | `OAuthApp` / `revoked` drops the installation's tokens | Uninstall |
| `.linear-tokens.json` | `.pulse-tokens.json` (mode 0600) | Pulse |

What did not change: Bun, the three routes, `managed-agents-2026-04-01`, one Claude session per
event, stream-before-send, and `prompt_context` as the prompt on `created`. Like the original,
a follow-up (`prompted`) starts a fresh Claude session with only the new message; Scout
(`../scout`) shows queued follow-ups and rebuilding the conversation from activities.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Health check |
| `GET` | `/oauth/authorize` | Starts the `actor=app` install (needs the install secret) |
| `GET` | `/oauth/callback` | OAuth callback; exchanges the code and stores tokens |
| `POST` | `/webhook` | Receives Pulse app webhooks |
