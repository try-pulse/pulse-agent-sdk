import { createServer } from "node:http";
import {
  DEFAULT_BASE_URL,
  InstallFlow,
  InstallSecretError,
  JsonFileTokenStore,
  OAuthError,
  SessionStops,
  TokenManager,
  createWebhookHandler,
} from "@pulse/agent-sdk";
import { Scout } from "./scout.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${name} is required (see .env.example)`);
  return v;
}

const PORT = Number(process.env["PORT"] ?? 3000);
const BASE_URL = env("BASE_URL").replace(/\/+$/, "");
const PULSE_API_URL = env("PULSE_API_URL", DEFAULT_BASE_URL);

const oauth = {
  clientId: env("PULSE_CLIENT_ID"),
  clientSecret: env("PULSE_CLIENT_SECRET"),
  redirectUri: `${BASE_URL}/oauth/callback`,
  baseUrl: PULSE_API_URL,
};
const tokens = new TokenManager({ store: new JsonFileTokenStore(env("TOKEN_FILE", ".pulse-tokens.json")), oauth });
const install = new InstallFlow({ oauth, tokens, installSecret: env("INSTALL_SECRET") });
const stops = new SessionStops();
const scout = new Scout({
  tokens,
  stops,
  baseUrl: PULSE_API_URL,
  stepDelayMs: Number(process.env["SCOUT_STEP_DELAY_MS"] ?? 0),
  heartbeatMs: Number(process.env["SCOUT_HEARTBEAT_MS"] ?? 5 * 60 * 1000),
});

const webhook = createWebhookHandler({
  secret: env("PULSE_WEBHOOK_SECRET"),
  stops,
  onSessionCreated: (e, ctx) => scout.onCreated(e, ctx),
  onSessionPrompted: (e, ctx) => scout.onPrompted(e, ctx),
  onPermissionChange: (e) => scout.onPermissionChange(e),
  onRevoked: (e) => scout.onRevoked(e),
  onRejected: (reason) => console.warn("webhook refused", { reason }),
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL);
  const text = (status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
  };

  if (req.method === "GET" && url.pathname === "/healthz") return text(200, "ok\n");

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    const auth = req.headers.authorization;
    const secret = auth?.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("install_secret");
    try {
      return text(302, "", { location: install.start(secret) });
    } catch (err) {
      if (err instanceof InstallSecretError) return text(401, "Missing or invalid install secret.\n");
      throw err;
    }
  }

  if (req.method === "GET" && url.pathname === "/oauth/callback") {
    install
      .complete({ code: url.searchParams.get("code"), state: url.searchParams.get("state"), error: url.searchParams.get("error") })
      .then((rec) => {
        console.log("installed", { installation_id: rec.installation_id, workspace_id: rec.workspace_id });
        text(200, `Scout is installed.\nInstallation: ${rec.installation_id}\nYou can close this tab.\n`);
      })
      .catch((err: unknown) => {
        console.error("install failed", { err: String(err) });
        text(err instanceof OAuthError ? 400 : 500, "Install failed. Start again from /oauth/authorize.\n");
      });
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhook") return webhook.node(req, res);

  text(404, "Not found\n");
});

server.listen(PORT, () => {
  console.log(`Scout listening on :${PORT}`);
  console.log(`  Install: ${BASE_URL}/oauth/authorize?install_secret=…`);
  console.log(`  Webhook: ${BASE_URL}/webhook`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    server.close();
    void webhook.idle().then(() => process.exit(0));
  });
}
