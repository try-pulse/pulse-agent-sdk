import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { InstallationRevokedError, OAuthError } from "./errors.js";
import {
  DEFAULT_APP_SCOPES,
  buildInstallUrl,
  exchangeCode,
  generatePkce,
  refreshTokens,
  safeEqual,
  type OAuthClientConfig,
} from "./oauth.js";
import type { OAuthTokenResponse } from "./types.js";

/** One installation's tokens. Keyed by `installation_id`; webhooks carry the same id. */
export type TokenRecord = {
  installation_id: string;
  workspace_id: string;
  app_user_id: string;
  access_token: string;
  refresh_token?: string;
  /** Unix ms. */
  expires_at: number;
  scope?: string;
};

export interface TokenStore {
  get(installationId: string): Promise<TokenRecord | undefined>;
  set(record: TokenRecord): Promise<void>;
  delete(installationId: string): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  readonly #records = new Map<string, TokenRecord>();
  async get(id: string) {
    const r = this.#records.get(id);
    return r && { ...r };
  }
  async set(record: TokenRecord) {
    this.#records.set(record.installation_id, { ...record });
  }
  async delete(id: string) {
    this.#records.delete(id);
  }
}

/** A JSON file (mode 0600, atomic writes). Fine for one process; use a database for more. */
export class JsonFileTokenStore implements TokenStore {
  #chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}

  async #read(): Promise<Record<string, TokenRecord>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, TokenRecord>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async #write(all: Record<string, TokenRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  get(id: string) {
    return this.#serial(async () => (await this.#read())[id]);
  }
  set(record: TokenRecord) {
    return this.#serial(async () => {
      const all = await this.#read();
      all[record.installation_id] = record;
      await this.#write(all);
    });
  }
  delete(id: string) {
    return this.#serial(async () => {
      const all = await this.#read();
      if (!(id in all)) return;
      delete all[id];
      await this.#write(all);
    });
  }
}

export function tokenRecordFrom(res: OAuthTokenResponse, now = Date.now()): TokenRecord {
  if (res.actor !== "app" || !res.installation_id || !res.workspace_id || !res.app_user_id) {
    throw new Error("token response is not an agent app installation (actor=app with installation_id)");
  }
  return {
    installation_id: res.installation_id,
    workspace_id: res.workspace_id,
    app_user_id: res.app_user_id,
    access_token: res.access_token,
    ...(res.refresh_token !== undefined && { refresh_token: res.refresh_token }),
    expires_at: now + res.expires_in * 1000,
    ...(res.scope !== undefined && { scope: res.scope }),
  };
}

export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

/**
 * Hands out access tokens per installation and refreshes them within `refreshWindowMs`
 * (5 minutes) of expiry. Refreshes are single-flight per installation: refresh tokens
 * rotate, so two concurrent refreshes with the same token would lose one to invalid_grant.
 */
export class TokenManager {
  readonly #inflight = new Map<string, Promise<TokenRecord>>();
  constructor(
    private readonly options: {
      store: TokenStore;
      oauth: OAuthClientConfig;
      refreshWindowMs?: number;
      now?: () => number;
    },
  ) {}

  get store(): TokenStore {
    return this.options.store;
  }

  async record(installationId: string): Promise<TokenRecord> {
    const rec = await this.options.store.get(installationId);
    if (!rec) throw new InstallationRevokedError(installationId, `no tokens stored for installation ${installationId}`);
    return rec;
  }

  async getAccessToken(installationId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    const rec = await this.record(installationId);
    const window = this.options.refreshWindowMs ?? 5 * 60 * 1000;
    if (!opts.forceRefresh && rec.expires_at - now > window) return rec.access_token;
    return (await this.refresh(installationId)).access_token;
  }

  refresh(installationId: string): Promise<TokenRecord> {
    const running = this.#inflight.get(installationId);
    if (running) return running;
    const run = this.#refresh(installationId).finally(() => this.#inflight.delete(installationId));
    this.#inflight.set(installationId, run);
    return run;
  }

  async #refresh(installationId: string): Promise<TokenRecord> {
    const rec = await this.record(installationId);
    if (!rec.refresh_token) {
      throw new InstallationRevokedError(installationId, "access token expired and no refresh token is stored");
    }
    let res: OAuthTokenResponse;
    try {
      res = await refreshTokens(this.options.oauth, rec.refresh_token);
    } catch (err) {
      if (err instanceof OAuthError && err.error === "invalid_grant") {
        await this.options.store.delete(installationId);
        throw new InstallationRevokedError(installationId, "refresh refused (invalid_grant); tokens dropped");
      }
      throw err;
    }
    const now = (this.options.now ?? Date.now)();
    const next: TokenRecord = {
      ...rec,
      access_token: res.access_token,
      refresh_token: res.refresh_token ?? rec.refresh_token,
      expires_at: now + res.expires_in * 1000,
      ...(res.scope !== undefined && { scope: res.scope }),
    };
    await this.options.store.set(next);
    return next;
  }

  /** Expire the cached access token (keeps the refresh token): the next call refreshes. */
  async expireAccessToken(installationId: string): Promise<void> {
    const rec = await this.options.store.get(installationId);
    if (rec) await this.options.store.set({ ...rec, expires_at: 0 });
  }

  /** Drop the installation's tokens (on `OAuthApp` / `revoked`). */
  forget(installationId: string): Promise<void> {
    return this.options.store.delete(installationId);
  }

  tokenProvider(installationId: string): TokenProvider {
    return (opts) => this.getAccessToken(installationId, opts);
  }
}

export class InstallSecretError extends Error {
  override name = "InstallSecretError";
}

/**
 * The install endpoint (the `linear-pi-agent` pattern): an install secret guards who may
 * start an install, `state` is single-use with a TTL, and the PKCE verifier stays here.
 */
export class InstallFlow {
  readonly #pending = new Map<string, { verifier: string; expiresAt: number }>();
  constructor(
    private readonly options: {
      oauth: OAuthClientConfig;
      tokens: TokenManager;
      scopes?: readonly string[];
      /** When set, `start()` requires it. Leave unset only on a private network. */
      installSecret?: string;
      stateTtlMs?: number;
      now?: () => number;
    },
  ) {}

  /** Returns the authorize URL to redirect the admin to. */
  start(providedSecret?: string | null): string {
    if (this.options.installSecret !== undefined && !safeEqual(providedSecret, this.options.installSecret)) {
      throw new InstallSecretError("missing or invalid install secret");
    }
    const now = (this.options.now ?? Date.now)();
    for (const [s, p] of this.#pending) if (p.expiresAt <= now) this.#pending.delete(s);
    const state = randomBytes(24).toString("base64url");
    const pkce = generatePkce();
    this.#pending.set(state, { verifier: pkce.verifier, expiresAt: now + (this.options.stateTtlMs ?? 10 * 60 * 1000) });
    return buildInstallUrl({
      clientId: this.options.oauth.clientId,
      redirectUri: this.options.oauth.redirectUri,
      scopes: this.options.scopes ?? DEFAULT_APP_SCOPES,
      state,
      codeChallenge: pkce.challenge,
      ...(this.options.oauth.baseUrl !== undefined && { baseUrl: this.options.oauth.baseUrl }),
    });
  }

  /** Handles the callback: checks and consumes `state`, exchanges the code, stores tokens. */
  async complete(input: { code: string | null; state: string | null; error?: string | null }): Promise<TokenRecord> {
    if (input.error) throw new OAuthError(400, input.error);
    if (!input.code || !input.state) throw new OAuthError(400, "invalid_request", "missing code or state");
    const pending = this.#pending.get(input.state);
    this.#pending.delete(input.state);
    const now = (this.options.now ?? Date.now)();
    if (!pending || pending.expiresAt <= now) throw new OAuthError(400, "invalid_state", "unknown or expired state");
    const res = await exchangeCode(this.options.oauth, { code: input.code, codeVerifier: pending.verifier });
    const record = tokenRecordFrom(res, now);
    await this.options.tokens.store.set(record);
    return record;
  }
}
