import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallFlow, JsonFileTokenStore, MemoryTokenStore, TokenManager, InstallSecretError, type TokenRecord } from "../src/tokens.js";
import { buildInstallUrl, pkceChallenge } from "../src/oauth.js";
import { InstallationRevokedError, OAuthError } from "../src/errors.js";
import { fetchStub, json } from "./_helpers.js";

const NOW = 1_790_000_000_000;
const oauthBase = { clientId: "pulse_app_1", clientSecret: "pulse_sk_x", redirectUri: "https://scout.example/oauth/callback", baseUrl: "https://api.example.test/api/v1" };
const record = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  installation_id: "inst1",
  workspace_id: "ws1",
  app_user_id: "app-user-1",
  access_token: "old-access",
  refresh_token: "old-refresh",
  expires_at: NOW + 60 * 60 * 1000,
  ...over,
});

test("a token far from expiry is returned without a refresh", async () => {
  const store = new MemoryTokenStore();
  await store.set(record());
  const stub = fetchStub([]);
  const tm = new TokenManager({ store, oauth: { ...oauthBase, fetch: stub.fetch }, now: () => NOW });
  assert.equal(await tm.getAccessToken("inst1"), "old-access");
  assert.equal(stub.calls.length, 0);
});

test("within 5 minutes of expiry it refreshes once, even under concurrency, and stores the rotated token", async () => {
  const store = new MemoryTokenStore();
  await store.set(record({ expires_at: NOW + 4 * 60 * 1000 }));
  const stub = fetchStub([json(200, { access_token: "new-access", token_type: "Bearer", expires_in: 3600, refresh_token: "new-refresh", scope: "read write" })]);
  const tm = new TokenManager({ store, oauth: { ...oauthBase, fetch: stub.fetch }, now: () => NOW });
  const tokens = await Promise.all([tm.getAccessToken("inst1"), tm.getAccessToken("inst1"), tm.getAccessToken("inst1")]);
  assert.deepEqual(tokens, ["new-access", "new-access", "new-access"]);
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0]!;
  assert.equal(call.url.pathname, "/api/v1/oauth/token");
  assert.equal(call.headers.get("authorization"), `Basic ${Buffer.from("pulse_app_1:pulse_sk_x").toString("base64")}`);
  assert.deepEqual(call.body, { grant_type: "refresh_token", refresh_token: "old-refresh" });
  const stored = await store.get("inst1");
  assert.equal(stored?.refresh_token, "new-refresh");
  assert.equal(stored?.expires_at, NOW + 3600 * 1000);
  assert.equal(stored?.workspace_id, "ws1");
});

test("invalid_grant on refresh drops the installation's tokens", async () => {
  const store = new MemoryTokenStore();
  await store.set(record({ expires_at: NOW }));
  const stub = fetchStub([json(400, { error: "invalid_grant", error_description: "revoked" })]);
  const tm = new TokenManager({ store, oauth: { ...oauthBase, fetch: stub.fetch }, now: () => NOW });
  await assert.rejects(tm.getAccessToken("inst1"), InstallationRevokedError);
  assert.equal(await store.get("inst1"), undefined);
});

test("JsonFileTokenStore round-trips with mode 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pulse-sdk-tokens-"));
  const path = join(dir, "nested", "tokens.json");
  const store = new JsonFileTokenStore(path);
  await Promise.all([store.set(record()), store.set(record({ installation_id: "inst2" }))]);
  assert.equal((await store.get("inst1"))?.access_token, "old-access");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.delete("inst1");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))), ["inst2"]);
});

test("buildInstallUrl sets actor=app, comma scopes and PKCE S256", () => {
  const url = new URL(buildInstallUrl({ clientId: "c", redirectUri: "https://r.example/cb", scopes: ["read", "write", "app:assignable"], state: "s", codeChallenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://api.trypulse.tech/api/v1/oauth/authorize");
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("scope"), "read,write,app:assignable");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("InstallFlow: secret-guarded start, single-use state, verifier matches challenge, tokens stored", async () => {
  const store = new MemoryTokenStore();
  const stub = fetchStub([
    json(200, { access_token: "a", token_type: "Bearer", expires_in: 3600, refresh_token: "r", scope: "read write app:assignable app:mentionable", actor: "app", installation_id: "inst9", app_user_id: "u9", workspace_id: "ws9" }),
  ]);
  const oauth = { ...oauthBase, fetch: stub.fetch };
  const tokens = new TokenManager({ store, oauth, now: () => NOW });
  const flow = new InstallFlow({ oauth, tokens, installSecret: "let-me-in", now: () => NOW });

  assert.throws(() => flow.start(undefined), InstallSecretError);
  assert.throws(() => flow.start("let-me-i"), InstallSecretError);
  const url = new URL(flow.start("let-me-in"));
  assert.equal(url.searchParams.get("scope"), "read,write,app:assignable,app:mentionable");
  assert.equal(url.origin, "https://api.example.test");
  const state = url.searchParams.get("state")!;
  const challenge = url.searchParams.get("code_challenge")!;

  await assert.rejects(flow.complete({ code: "c1", state: "forged" }), OAuthError);
  const rec = await flow.complete({ code: "c1", state });
  assert.equal(rec.installation_id, "inst9");
  assert.equal(rec.workspace_id, "ws9");
  const form = stub.calls[0]!.body as Record<string, string>;
  assert.equal(form["grant_type"], "authorization_code");
  assert.equal(pkceChallenge(form["code_verifier"]!), challenge);
  assert.equal((await store.get("inst9"))?.access_token, "a");
  await assert.rejects(flow.complete({ code: "c1", state }), OAuthError, "state is single-use");
});

test("InstallFlow refuses a token response that is not an app installation", async () => {
  const stub = fetchStub([json(200, { access_token: "a", token_type: "Bearer", expires_in: 3600 })]);
  const oauth = { ...oauthBase, fetch: stub.fetch };
  const flow = new InstallFlow({ oauth, tokens: new TokenManager({ store: new MemoryTokenStore(), oauth }) });
  const state = new URL(flow.start()).searchParams.get("state");
  await assert.rejects(flow.complete({ code: "c", state }), /not an agent app installation/);
});
