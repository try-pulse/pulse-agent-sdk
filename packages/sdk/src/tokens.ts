import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { InstallationRevokedError, OAuthError } from "./errors.js";
import {
  DEFAULT_APP_SCOPES,
  DEFAULT_BASE_URL,
  buildInstallUrl,
  exchangeCode,
  generatePkce,
  refreshTokens,
  safeEqual,
  trimSlash,
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
      return Object.assign(Object.create(null) as Record<string, TokenRecord>, JSON.parse(await readFile(this.path, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, TokenRecord>;
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

export type TokenRequestOptions = {
  forceRefresh?: boolean;
  /** The access token rejected by Pulse. An already-rotated token can satisfy the retry. */
  rejectedToken?: string;
};

export type TokenProvider = (opts?: TokenRequestOptions) => Promise<string>;

type InstallationPrincipal = Pick<TokenRecord, "workspace_id" | "app_user_id">;

/**
 * Hands out access tokens per installation and refreshes them within `refreshWindowMs`
 * (5 minutes) of expiry. Refreshes are single-flight per installation: refresh tokens
 * rotate, so two concurrent refreshes with the same token would lose one to invalid_grant.
 */
export class TokenManager {
  readonly #inflight = new Map<string, Promise<TokenRecord>>();
  readonly #mutations = new Map<string, Promise<void>>();
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

  get apiBaseUrl(): string {
    return trimSlash(this.options.oauth.baseUrl ?? DEFAULT_BASE_URL);
  }

  async record(installationId: string): Promise<TokenRecord> {
    const rec = await this.options.store.get(installationId);
    if (!rec || rec.installation_id !== installationId) {
      throw new InstallationRevokedError(installationId, `no tokens stored for installation ${installationId}`);
    }
    return rec;
  }

  async getAccessToken(installationId: string, opts: TokenRequestOptions = {}): Promise<string> {
    return (await this.#accessRecord(installationId, opts)).access_token;
  }

  async #accessRecord(installationId: string, opts: TokenRequestOptions, principal?: InstallationPrincipal): Promise<TokenRecord> {
    await this.#mutations.get(installationId);
    const window = this.options.refreshWindowMs ?? 5 * 60 * 1000;
    const usable = (record: TokenRecord) => {
      const remaining = record.expires_at - (this.options.now ?? Date.now)();
      return opts.rejectedToken !== undefined
        ? record.access_token !== opts.rejectedToken && remaining > 0
        : !opts.forceRefresh && remaining > window;
    };
    const record = await this.#boundRecord(installationId, principal);
    if (usable(record)) return record;
    if (!principal && opts.rejectedToken === undefined) return this.refresh(installationId);
    return this.#mutate(installationId, async () => {
      const current = await this.#boundRecord(installationId, principal);
      return usable(current) ? current : this.#refresh(installationId, principal);
    });
  }

  async #boundRecord(installationId: string, principal?: InstallationPrincipal): Promise<TokenRecord> {
    const record = await this.record(installationId);
    if (principal && (record.workspace_id !== principal.workspace_id || record.app_user_id !== principal.app_user_id)) {
      throw new InstallationRevokedError(installationId, "stored tokens do not match the installation principal");
    }
    return record;
  }

  refresh(installationId: string): Promise<TokenRecord> {
    const running = this.#inflight.get(installationId);
    if (running) return running;
    const run = this.#mutate(installationId, () => this.#refresh(installationId))
      .finally(() => this.#inflight.delete(installationId));
    this.#inflight.set(installationId, run);
    return run;
  }

  #mutate<T>(installationId: string, operation: () => Promise<T>): Promise<T> {
    const run = (this.#mutations.get(installationId) ?? Promise.resolve()).then(operation);
    const done = run.then(() => undefined, () => undefined);
    this.#mutations.set(installationId, done);
    void done.then(() => {
      if (this.#mutations.get(installationId) === done) this.#mutations.delete(installationId);
    });
    return run;
  }

  async #refresh(installationId: string, principal?: InstallationPrincipal): Promise<TokenRecord> {
    const rec = await this.#boundRecord(installationId, principal);
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
    if ((res.actor !== undefined && res.actor !== "app") ||
        (res.installation_id !== undefined && res.installation_id !== installationId) ||
        (res.workspace_id !== undefined && res.workspace_id !== rec.workspace_id) ||
        (res.app_user_id !== undefined && res.app_user_id !== rec.app_user_id)) {
      throw new OAuthError(200, "invalid_response", "refresh response changed installation identity");
    }
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
  expireAccessToken(installationId: string): Promise<void> {
    return this.#mutate(installationId, async () => {
      const rec = await this.options.store.get(installationId);
      if (rec) await this.options.store.set({ ...rec, expires_at: 0 });
    });
  }

  /** Drop the installation's tokens (on `OAuthApp` / `revoked`). */
  forget(installationId: string): Promise<void> {
    return this.#mutate(installationId, () => this.options.store.delete(installationId));
  }

  tokenProvider(installationId: string, principal?: InstallationPrincipal): TokenProvider {
    return async (opts = {}) => (await this.#accessRecord(installationId, opts, principal)).access_token;
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
