import Anthropic from "@anthropic-ai/sdk";
import { PulseAgentClient, createWebhookHandler } from "@pulse/agent-sdk";
import { config, handleOAuthAuthorize, handleOAuthCallback, handleRevoked, stops, tokens } from "./oauth";
import { createAgentSessionHandler } from "./agent";

const handleAgentSession = createAgentSessionHandler({
  anthropic: new Anthropic({ apiKey: config.anthropicApiKey }),
  agentId: config.claudeAgentId,
  environmentId: config.claudeEnvironmentId,
  pulseForEvent: (event) => new PulseAgentClient({
    tokenProvider: tokens.tokenProvider(event.installation_id),
    workspaceId: event.workspace_id,
    baseUrl: config.pulseApiUrl,
    stops,
  }),
});

// Verifies Pulse-Signature over the raw body and the signed body webhook_timestamp,
// answers 200 at once, then runs the callbacks (deduplicated on data.event_id).
const handler = createWebhookHandler({
  secret: config.pulseWebhookSecret,
  stops,
  onSessionCreated: (event, ctx) => {
    console.log(
      `[webhook] AgentSessionEvent: action=${event.action}, session=${event.data.agent_session.id}`
    );
    return handleAgentSession(event, ctx);
  },
  onSessionPrompted: (event, ctx) => {
    console.log(
      `[webhook] AgentSessionEvent: action=${event.action}, session=${event.data.agent_session.id}, stop=${ctx.isStop}`
    );
    return handleAgentSession(event, ctx);
  },
  onRevoked: handleRevoked,
  onError: (err) => console.error("[agent] Error handling session:", err),
});

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/" && req.method === "GET") {
      return Response.json({ status: "ok", agent: "claude-pulse-bridge" });
    }

    // OAuth flow
    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      return handleOAuthAuthorize(req);
    }
    if (url.pathname === "/oauth/callback" && req.method === "GET") {
      return handleOAuthCallback(url);
    }

    // Pulse webhook
    if (url.pathname === "/webhook" && req.method === "POST") {
      return handler.fetch(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running at ${config.baseUrl} (port ${server.port})`);
console.log(`  OAuth:   ${config.baseUrl}/oauth/authorize?install_secret=…`);
console.log(`  Webhook: ${config.baseUrl}/webhook`);
