/** A non-2xx answer from pulse-api or the Agent Session API (`{code, message, details}`). */
export class PulseApiError extends Error {
  override name = "PulseApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | undefined,
    readonly retryAfterMs?: number,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

/**
 * The installation is gone: `401 INSTALLATION_REVOKED` on a call, or `invalid_grant` on a
 * refresh. The stored tokens have been dropped; the app must be installed again.
 */
export class InstallationRevokedError extends Error {
  override name = "InstallationRevokedError";
  constructor(readonly installationId: string | undefined, message = "The installation was revoked") {
    super(message);
  }
}

/** An OAuth endpoint answered with an RFC 6749 error. */
export class OAuthError extends Error {
  override name = "OAuthError";
  constructor(
    readonly status: number,
    readonly error: string,
    readonly errorDescription?: string,
  ) {
    super(errorDescription ? `${error}: ${errorDescription}` : error);
  }
}
