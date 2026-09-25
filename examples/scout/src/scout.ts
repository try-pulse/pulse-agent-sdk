import { setTimeout as sleep } from "node:timers/promises";
import {
  PulseAgentClient,
  PulseApiError,
  SessionStops,
  isSessionEnded,
  stopCauseOf,
  type AgentSessionCreatedEvent,
  type AgentSessionPromptedEvent,
  type OAuthAppRevokedEvent,
  type PermissionChangeEvent,
  type PlanItem,
  type PromptedContext,
  type SessionContext,
  type TokenManager,
} from "@pulse/agent-sdk";
import { readPromptContext, type IssueContext } from "./context.js";

export type ScoutOptions = {
  tokens: TokenManager;
  stops: SessionStops;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Artificial delay per step, to try heartbeats, queued follow-ups and Stop. */
  stepDelayMs?: number;
  /** Heartbeat thought interval while a run is active. Default 5 minutes. */
  heartbeatMs?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
};

type SessionState = {
  installationId: string;
  workspaceId: string;
  teamId?: string;
  label: string;
  running: boolean;
  queue: AgentSessionPromptedEvent[];
  /** The select elicitation Scout is waiting on, if any. */
  awaitingSelect: boolean;
  created?: AgentSessionCreatedEvent;
  /** The plan the run published, so an answer can finish it. */
  plan?: PlanItem[];
};

const SELECT_OPTIONS = [
  { value: "summarise-title", label: "Summarise from the title" },
  { value: "wait", label: "Wait, I'll add a description" },
];

/**
 * Scout demonstrates every rule of the best-practices page without an LLM: a thought
 * within a second, a plan, moving the issue to in_progress, ephemeral actions, a select
 * elicitation, queued follow-ups, heartbeats, and Stop.
 */
export class Scout {
  readonly #sessions = new Map<string, SessionState>();
  constructor(private readonly o: ScoutOptions) {}

  #client(state: Pick<SessionState, "installationId" | "workspaceId">): PulseAgentClient {
    return new PulseAgentClient({
      tokenProvider: this.o.tokens.tokenProvider(state.installationId),
      workspaceId: state.workspaceId,
      stops: this.o.stops,
      idempotencyPrefix: "scout",
      ...(this.o.baseUrl !== undefined && { baseUrl: this.o.baseUrl }),
      ...(this.o.fetch !== undefined && { fetch: this.o.fetch }),
    });
  }

  #log(msg: string, fields?: Record<string, unknown>) {
    (this.o.log ?? ((m, f) => console.log(m, f ?? {})))(msg, fields);
  }

  // ---- AgentSessionEvent / created ------------------------------------------------------

  async onCreated(event: AgentSessionCreatedEvent, { signal }: SessionContext): Promise<void> {
    const s = event.data.agent_session;
    const state: SessionState = {
      installationId: event.installation_id,
      workspaceId: event.workspace_id,
      label: s.issue?.identifier ?? "this thread",
      running: false,
      queue: [],
      awaitingSelect: false,
      created: event,
    };
    if (s.issue?.team.id) state.teamId = s.issue.team.id;
    this.#sessions.set(s.id, state);
    const client = this.#client(state);

    // Instant feedback first: well inside the 10-second budget.
    await client.thought(s.id, `Looking at ${state.label}…`);
    await this.#run(s.id, state, signal, () => this.#investigate(client, event, state, signal));
  }

  async #investigate(client: PulseAgentClient, event: AgentSessionCreatedEvent, state: SessionState, signal: AbortSignal) {
    const s = event.data.agent_session;
    const ctx = readPromptContext(event.data.prompt_context);
    const plan: PlanItem[] = [
      { content: `Read ${state.label}`, status: "inProgress" },
      { content: "Check guidance and context", status: "pending" },
      { content: "Report back", status: "pending" },
    ];
    state.plan = plan;
    await client.setPlan(s.id, plan, { signal });

    if (s.issue) await this.#moveToStarted(client, s.id, s.issue.id, signal);

    await client.action(s.id, { action: "Reading", parameter: s.issue?.identifier ?? null }, { ephemeral: true, signal });
    await this.#step(signal);
    await client.action(s.id, {
      action: "Read",
      parameter: s.issue?.identifier ?? null,
      result: `${event.data.previous_comments.length} earlier comment(s), ${event.data.guidance.length} guidance rule(s)`,
    }, { signal });
    plan[0]!.status = "completed";
    plan[1]!.status = "inProgress";
    await client.setPlan(s.id, plan, { signal });
    await this.#step(signal);

    if (s.issue && !ctx.description) {
      state.awaitingSelect = true;
      await client.elicit(s.id, `${state.label} has no description yet. How should I continue?`, { select: SELECT_OPTIONS, signal });
      return;
    }
    plan[1]!.status = "completed";
    plan[2]!.status = "completed";
    await client.setPlan(s.id, plan, { signal });
    await client.respond(s.id, summarise(event, ctx), { signal });
  }

  /** Best practice: a delegated issue in backlog/todo moves to the team's started state. */
  async #moveToStarted(client: PulseAgentClient, sessionId: string, issueId: string, signal: AbortSignal) {
    try {
      const issue = await client.getIssue(issueId, { signal });
      if (issue.status === "backlog" || issue.status === "todo") {
        await client.updateIssueStatus(issueId, "in_progress", { signal });
        await client.action(sessionId, { action: "Moved issue", parameter: `${issue.status} → in_progress`, result: "done" }, { signal });
      }
    } catch (err) {
      if (isSessionEnded(err) || signal.aborted) throw err;
      const code = err instanceof PulseApiError ? err.code : String(err);
      await client.action(sessionId, { action: "Move issue", parameter: "in_progress", result: `skipped (${code})` }, { signal });
    }
  }

  // ---- AgentSessionEvent / prompted -----------------------------------------------------

  async onPrompted(event: AgentSessionPromptedEvent, { isStop, signal }: PromptedContext): Promise<void> {
    const s = event.data.agent_session;
    const state =
      this.#sessions.get(s.id) ??
      ({
        installationId: event.installation_id,
        workspaceId: event.workspace_id,
        label: s.issue?.identifier ?? "this thread",
        running: false,
        queue: [],
        awaitingSelect: false,
      } satisfies SessionState);
    this.#sessions.set(s.id, state);
    const client = this.#client(state);

    if (isStop) {
      // The handler already aborted `signal`, so the running step exits. Drop queued work,
      // change nothing more, and post exactly one final activity — never with the aborted signal.
      state.queue = [];
      state.awaitingSelect = false;
      await this.#final(() => client.respond(s.id, "Stopped. I made no further changes."));
      return;
    }

    if (state.running) {
      state.queue.push(event);
      await client.thought(s.id, `Got it — I'll look at "${excerpt(event.data.agent_activity.content.body)}" after the current step.`);
      return;
    }
    await this.#run(s.id, state, signal, () => this.#followUp(client, event, state, signal));
  }

  // Every write in a run carries the run's signal: once Stop lands, nothing more is posted
  // except the stop handler's single final response.
  async #followUp(client: PulseAgentClient, event: AgentSessionPromptedEvent, state: SessionState, signal: AbortSignal) {
    const s = event.data.agent_session;
    const body = event.data.agent_activity.content.body.trim();

    if (state.awaitingSelect) {
      state.awaitingSelect = false;
      if (body === "wait") {
        await client.respond(s.id, "OK — I'll wait. Mention me again once the description is filled in.", { signal });
        return;
      }
      await client.thought(s.id, body === "summarise-title" ? "Summarising from the title." : `Taking "${excerpt(body)}" as the answer.`, { signal });
      const created = state.created;
      const ctx = created ? readPromptContext(created.data.prompt_context) : { labels: [], repositoryHints: [] };
      if (state.plan) {
        for (const item of state.plan) item.status = "completed";
        await client.setPlan(s.id, state.plan, { signal });
      }
      await client.respond(s.id, created ? summarise(created, ctx) : `**${state.label}**: ${s.issue?.title ?? ""}`, { signal });
      return;
    }

    // Rebuild the conversation from the session's activities, never from issue comments.
    await client.action(s.id, { action: "Reading conversation", parameter: null }, { ephemeral: true, signal });
    const activities = await client.sessions.activities(s.id, { signal });
    const prompts = activities.filter((a) => a.type === "prompt").length;
    const replies = activities.filter((a) => a.type === "response").length;
    await client.respond(
      s.id,
      `You asked: "${excerpt(body, 200)}".\n\nThis session has ${prompts} message(s) from people and ${replies} response(s) from me. I'm a sample agent, so this is as far as I go.`,
      { signal },
    );
  }

  // ---- a run: heartbeat, queue, stop, errors --------------------------------------------

  async #run(sessionId: string, state: SessionState, signal: AbortSignal, work: () => Promise<void>): Promise<void> {
    state.running = true;
    const client = this.#client(state);
    const heartbeat = setInterval(() => {
      void client
        .thought(sessionId, `Still working on ${state.label}…`, { ephemeral: true, signal })
        .catch((err: unknown) => this.#log("heartbeat failed", { sessionId, err: String(err) }));
    }, this.o.heartbeatMs ?? 5 * 60 * 1000);
    heartbeat.unref();
    try {
      await work();
    } catch (err) {
      await this.#fail(client, sessionId, signal, err);
    } finally {
      clearInterval(heartbeat);
      state.running = false;
    }
    const next = state.queue.shift();
    if (next && !signal.aborted) {
      await this.#run(sessionId, state, signal, () => this.#followUp(client, next, state, signal));
    }
  }

  async #fail(client: PulseAgentClient, sessionId: string, signal: AbortSignal, err: unknown) {
    const cause = stopCauseOf(signal);
    if (isSessionEnded(err) || cause?.kind === "session_ended" || cause?.kind === "revoked") {
      // Pulse ended the session (uninstall, team removal, issue deleted): post nothing.
      this.#log("session ended; stopping quietly", { sessionId, reason: cause ?? String(err) });
      return;
    }
    if (cause?.kind === "stop_signal") return; // onPrompted posts the final response
    this.#log("run failed", { sessionId, err: String(err) });
    await this.#final(() => client.error(sessionId, `Scout could not finish: ${err instanceof Error ? err.message : String(err)}`));
  }

  async #final(post: () => Promise<unknown>) {
    try {
      await post();
    } catch (err) {
      if (!isSessionEnded(err)) throw err;
    }
  }

  async #step(signal: AbortSignal) {
    const ms = this.o.stepDelayMs ?? 0;
    if (ms > 0) await sleep(ms, undefined, { signal });
    signal.throwIfAborted();
  }

  // ---- PermissionChange / OAuthApp -------------------------------------------------------

  async onPermissionChange(event: PermissionChangeEvent): Promise<void> {
    // Team coverage changed: drop the cached access token so the next call gets a fresh one,
    // and stop work on teams the installation no longer covers (Pulse already ended them).
    await this.o.tokens.expireAccessToken(event.installation_id);
    const removed = new Set(event.data.removed_team_ids);
    for (const [sessionId, st] of this.#sessions) {
      if (st.installationId === event.installation_id && st.teamId && removed.has(st.teamId)) {
        this.o.stops.stop(sessionId, { kind: "session_ended", endReason: "team_removed" });
        this.#sessions.delete(sessionId);
      }
    }
  }

  async onRevoked(event: OAuthAppRevokedEvent): Promise<void> {
    await this.o.tokens.forget(event.installation_id);
    for (const [sessionId, st] of this.#sessions) {
      if (st.installationId === event.installation_id) {
        this.#sessions.delete(sessionId);
        this.o.stops.release(sessionId);
      }
    }
    this.#log("uninstalled; tokens dropped", { installation_id: event.installation_id });
  }
}

function summarise(event: AgentSessionCreatedEvent, ctx: IssueContext): string {
  const s = event.data.agent_session;
  const lines: string[] = [];
  if (s.issue) {
    lines.push(`**${s.issue.identifier}: ${s.issue.title}** (${s.issue.team.name})`);
    if (ctx.description) lines.push("", excerpt(ctx.description, 400));
    if (ctx.labels.length) lines.push("", `Labels: ${ctx.labels.join(", ")}`);
    if (ctx.project) lines.push(`Project: ${ctx.project}`);
  } else if (s.comment) {
    lines.push(`You wrote: "${excerpt(s.comment.body, 200)}"`);
  }
  if (event.data.previous_comments.length) {
    lines.push("", `The thread has ${event.data.previous_comments.length} earlier comment(s).`);
  }
  if (event.data.guidance.length) {
    lines.push("", "Guidance I received:");
    for (const g of event.data.guidance) lines.push(`- (${g.origin}) ${excerpt(g.body, 200)}`);
  } else {
    lines.push("", "No guidance is set for this workspace or team.");
  }
  if (ctx.repositoryHints.length) lines.push("", `Repository hints: ${ctx.repositoryHints.join(", ")}`);
  lines.push("", "_Scout is a sample agent: it reads and reports, and a person decides what happens next._");
  return lines.join("\n");
}

function excerpt(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
