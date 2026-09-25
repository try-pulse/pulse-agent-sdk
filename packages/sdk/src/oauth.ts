import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuthError } from "./errors.js";
import type { AgentAppScope, OAuthTokenResponse } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.trypulse.tech/api/v1";

/** The scopes every agent app sample requests, as Linear's samples do. */
export const DEFAULT_APP_SCOPES: AgentAppScope[] = ["read", "write", "app:assignable", "app:mentionable"];

export type OAuthClientConfig = {
  clientId: string;
  clientSecret: string;
  /** Must equal one of the manifest's `oauth.redirect_uris`. */
  redirectUri: string;
  /** Pulse API base, `https://api.trypulse.tech/api/v1` by default. */
  baseUrl?: string;
  fetch?: typeof fetch;
};

export type Pkce = { verifier: string; challenge: string };

/** A PKCE S256 pair. Pulse refuses an authorize request without one. */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export type BuildInstallUrlInput = {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  /** Always `app` for an agent app install. */
  actor?: "app";
  baseUrl?: string;
};

/** `GET /oauth/authorize?…&actor=app&code_challenge_method=S256`, scopes comma-separated. */
export function buildInstallUrl(input: BuildInstallUrlInput): string {
  const url = new URL(`${trimSlash(input.baseUrl ?? DEFAULT_BASE_URL)}/oauth/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(","));
  url.searchParams.set("state", input.state);
  url.searchParams.set("actor", input.actor ?? "app");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function tokenRequest(config: OAuthClientConfig, form: Record<string, string>): Promise<OAuthTokenResponse> {
  const doFetch = config.fetch ?? fetch;
  // Raw, not form-encoded: pulse-api reads it with Go's Request.BasicAuth(), which does not
  // URL-decode (http/handlers/oauth_handler.go).
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await doFetch(`${trimSlash(config.baseUrl ?? DEFAULT_BASE_URL)}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // fall through with an empty body
  }
  if (!res.ok) {
    throw new OAuthError(
      res.status,
      typeof body["error"] === "string" ? body["error"] : `http_${res.status}`,
      typeof body["error_description"] === "string" ? body["error_description"] : undefined,
    );
  }
  if (typeof body["access_token"] !== "string") throw new OAuthError(res.status, "invalid_response", "no access_token");
  return body as OAuthTokenResponse;
}

/** Exchange the callback's `code` (client_secret_basic, with the PKCE verifier). */
export function exchangeCode(
  config: OAuthClientConfig,
  input: { code: string; codeVerifier: string },
): Promise<OAuthTokenResponse> {
  return tokenRequest(config, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.redirectUri,
    code_verifier: input.codeVerifier,
  });
}

/** Refresh tokens rotate: store the returned `refresh_token`, the old one stops working. */
export function refreshTokens(config: OAuthClientConfig, refreshToken: string): Promise<OAuthTokenResponse> {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** `POST /oauth/revoke`; Pulse always answers 200. */
export async function revokeToken(config: OAuthClientConfig, token: string): Promise<void> {
  const doFetch = config.fetch ?? fetch;
  await doFetch(`${trimSlash(config.baseUrl ?? DEFAULT_BASE_URL)}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, token }),
  });
}

/** Constant-time comparison for the install secret guarding your install endpoint. */
export function safeEqual(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The install secret from `Authorization: Bearer …` or `?install_secret=…`. */
export function installSecretFrom(request: { url: string; headers: Headers }): string | undefined {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return new URL(request.url).searchParams.get("install_secret") ?? undefined;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
