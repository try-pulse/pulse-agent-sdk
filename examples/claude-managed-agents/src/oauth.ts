import { join } from "path";
import {
  InstallFlow,
  InstallSecretError,
  JsonFileTokenStore,
  OAuthError,
  PulseAgentClient,
  SessionStops,
  TokenManager,
  installSecretFrom,
  type OAuthAppRevokedEvent,
} from "@pulse/agent-sdk";
import { readConfig } from "./config";

export const config = readConfig(process.env);
export const PULSE_API_URL = config.pulseApiUrl;
const REDIRECT_URI = `${config.baseUrl}/oauth/callback`;

// Token store persisted to .pulse-tokens.json (gitignored), keyed by installation_id
const TOKEN_FILE = join(import.meta.dir, "..", ".pulse-tokens.json");

const oauth = {
  clientId: config.pulseClientId,
  clientSecret: config.pulseClientSecret,
  redirectUri: REDIRECT_URI,
  baseUrl: PULSE_API_URL,
};

export const tokens = new TokenManager({ store: new JsonFileTokenStore(TOKEN_FILE), oauth });
export const stops = new SessionStops();

// actor=app, comma-separated scopes, PKCE S256, single-use state, install secret
const install = new InstallFlow({
  oauth,
  tokens,
  scopes: ["read", "write", "app:assignable", "app:mentionable"],
  installSecret: config.installSecret,
});

export function handleOAuthAuthorize(req: Request): Response {
  try {
    return Response.redirect(install.start(installSecretFrom(req)));
  } catch (err) {
    if (err instanceof InstallSecretError) {
      return new Response("Missing or invalid install secret", { status: 401 });
    }
    throw err;
  }
}

export async function handleOAuthCallback(url: URL): Promise<Response> {
  let installation;
  try {
    // Checks state, exchanges the code with the PKCE verifier, stores tokens per installation
    installation = await install.complete({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
    });
  } catch (err) {
    console.error("[oauth] Token exchange failed:", err);
    return new Response(`OAuth token exchange failed: ${err instanceof OAuthError ? err.error : "error"}`, {
      status: err instanceof OAuthError ? 400 : 500,
    });
  }

  // The app's own identity in this workspace (Linear: viewer { id })
  const pulse = new PulseAgentClient({
    tokenProvider: tokens.tokenProvider(installation.installation_id),
    workspaceId: installation.workspace_id,
    baseUrl: PULSE_API_URL,
  });
  const me = await pulse.me();

  console.log(
    `[oauth] Installed as "${me.app?.name}" in workspace ${installation.workspace_id} (installation ${installation.installation_id})`
  );

  return new Response(
    `<html><body>
      <h1>Agent installed!</h1>
      <p>Workspace: ${installation.workspace_id}</p>
      <p>You can now @mention the agent or delegate issues to it in Pulse.</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

// OAuthApp / revoked: the app was uninstalled. Drop the tokens.
export async function handleRevoked(event: OAuthAppRevokedEvent): Promise<void> {
  await tokens.forget(event.installation_id);
  console.log(`[oauth] Uninstalled (installation ${event.installation_id}); tokens dropped`);
}
