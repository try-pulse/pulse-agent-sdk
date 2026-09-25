// Every way a session stops is handled here, so the rule is in one place:
//
//  1. Explicit stop: `AgentSessionEvent` / `prompted` with `agent_activity.signal: "stop"`
//     (a human pressed Stop, or the issue was undelegated). Abort the work, then post ONE
//     final `response` or `error`. Pulse ends the session on it, or after 60 s.
//  2. Silent end: uninstall, team removal and issue deletion end the session at once with
//     no `prompted`. The app notices through `OAuthApp` / `revoked`, `PermissionChange`,
//     or — always — through a `409 SESSION_ENDED` on its next write. That answer is final:
//     abort the work, post nothing more, never retry.
//
// PulseAgentClient reports every 409 SESSION_ENDED here, and the webhook handler reports
// every stop signal and revocation here, so work code only ever watches one AbortSignal.
import { PulseApiError } from "./errors.js";
import type { AgentSessionEndReason, AgentSessionEventPromptedData } from "./types.js";

export type StopCause =
  | { kind: "stop_signal"; endReason: AgentSessionEndReason }
  | { kind: "session_ended"; endReason: AgentSessionEndReason }
  | { kind: "revoked" }
  | { kind: "shutdown" };

/** `409 SESSION_ENDED`: the session no longer accepts writes. Never retried. */
export class SessionEndedError extends PulseApiError {
  override name = "SessionEndedError";
  readonly endReason: AgentSessionEndReason;
  constructor(readonly sessionId: string, message: string, details: Record<string, unknown> | undefined) {
    super(409, "SESSION_ENDED", message, details);
    const reason = details?.["end_reason"];
    this.endReason = typeof reason === "string" ? (reason as AgentSessionEndReason) : null;
  }
}

export function isSessionEnded(err: unknown): err is SessionEndedError {
  return err instanceof SessionEndedError;
}

/** True when a `prompted` event is a Stop. Never guess from the text. */
export function isStopPrompt(data: AgentSessionEventPromptedData): boolean {
  return data.agent_activity.signal === "stop";
}

type Entry = { controller: AbortController; installationId?: string; cause?: StopCause };

/**
 * Per-session abort signals. `signal(sessionId)` is what work code watches; `stop()` fires
 * it with a cause. A new non-stop `prompted` on a stopped session (a person reopening it)
 * calls `resume()`, which hands out a fresh signal — if the session really has ended, the
 * next write answers 409 and stops it again.
 */
export class SessionStops {
  readonly #entries = new Map<string, Entry>();

  #entry(sessionId: string, installationId?: string): Entry {
    let entry = this.#entries.get(sessionId);
    if (!entry) {
      entry = { controller: new AbortController() };
      this.#entries.set(sessionId, entry);
    }
    if (installationId) entry.installationId = installationId;
    return entry;
  }

  /** The signal for this session's work; aborted (with a `StopCause` as reason) on stop. */
  signal(sessionId: string, installationId?: string): AbortSignal {
    return this.#entry(sessionId, installationId).controller.signal;
  }

  stop(sessionId: string, cause: StopCause): void {
    const entry = this.#entry(sessionId);
    if (entry.controller.signal.aborted) return;
    entry.cause = cause;
    entry.controller.abort(cause);
  }

  /** Stop every session of an installation (uninstall, shutdown). */
  stopInstallation(installationId: string, cause: StopCause = { kind: "revoked" }): string[] {
    const stopped: string[] = [];
    for (const [sessionId, entry] of this.#entries) {
      if (entry.installationId === installationId) {
        this.stop(sessionId, cause);
        stopped.push(sessionId);
      }
    }
    return stopped;
  }

  isStopped(sessionId: string): boolean {
    return this.#entries.get(sessionId)?.controller.signal.aborted ?? false;
  }

  cause(sessionId: string): StopCause | undefined {
    return this.#entries.get(sessionId)?.cause;
  }

  /** A person wrote in a stopped session: give it a fresh, un-aborted signal. */
  resume(sessionId: string): void {
    const entry = this.#entries.get(sessionId);
    if (entry?.controller.signal.aborted) {
      entry.controller = new AbortController();
      delete entry.cause;
    }
  }

  /** Forget a finished session. */
  release(sessionId: string): void {
    this.#entries.delete(sessionId);
  }

  /** Called by PulseAgentClient on `409 SESSION_ENDED`. */
  noteSessionEnded(err: SessionEndedError): void {
    this.stop(err.sessionId, { kind: "session_ended", endReason: err.endReason });
  }
}

/** The `StopCause` behind an aborted signal, if it was stopped through SessionStops. */
export function stopCauseOf(signal: AbortSignal): StopCause | undefined {
  const reason: unknown = signal.reason;
  if (reason && typeof reason === "object" && "kind" in reason) return reason as StopCause;
  return undefined;
}
