import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentSessionCreatedEvent, AgentSessionPromptedEvent, PulseAgentClient } from "@pulse/agent-sdk";
import { createAgentSessionHandler } from "../src/agent";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function event(action: "created" | "prompted" = "created") {
  return {
    type: "AgentSessionEvent", action, installation_id: "inst1", workspace_id: "ws1",
    data: {
      agent_session: { id: "session1", issue: { identifier: "PUL-1", title: "Example" } },
      prompt_context: "Read PUL-1", previous_comments: [],
      agent_activity: { content: { body: "Continue" } },
    },
  } as unknown as AgentSessionCreatedEvent & AgentSessionPromptedEvent;
}

function pulseRecorder() {
  const calls: Array<{ kind: string; body: string }> = [];
  const pulse = {
    thought: async (_id: string, body: string) => { calls.push({ kind: "thought", body }); },
    action: async (_id: string, input: { action: string }) => { calls.push({ kind: "action", body: input.action }); },
    respond: async (_id: string, body: string) => { calls.push({ kind: "response", body }); },
    error: async (_id: string, body: string) => { calls.push({ kind: "error", body }); },
  } as unknown as PulseAgentClient;
  return { pulse, calls };
}

test("relays Claude text and tool use, then posts one final response", async () => {
  const { pulse, calls } = pulseRecorder();
  const sent: unknown[] = [];
  const anthropic = {
    beta: { sessions: {
      create: async () => ({ id: "claude1" }),
      events: {
        stream: async () => (async function* () {
          yield { type: "agent.tool_use", name: "Search" };
          yield { type: "agent.message", content: [{ type: "text", text: "Done." }] };
        })(),
        send: async (_id: string, body: unknown) => { sent.push(body); },
      },
    } },
  } as unknown as Anthropic;
  const handle = createAgentSessionHandler({
    anthropic, pulseForEvent: () => pulse, agentId: "agent1", environmentId: "env1",
  });
  await handle(event(), { signal: new AbortController().signal });
  expect(calls.map((call) => call.kind)).toEqual(["thought", "action", "response"]);
  expect(calls.at(-1)?.body).toBe("Done.");
  expect(JSON.stringify(sent[0])).toContain("Read PUL-1");
});

test("Stop interrupts the active Claude run and posts exactly one final response", async () => {
  const { pulse, calls } = pulseRecorder();
  const started = deferred();
  const release = deferred();
  const sent: unknown[] = [];
  const anthropic = {
    beta: { sessions: {
      create: async () => ({ id: "claude1" }),
      events: {
        stream: async () => (async function* () {
          started.resolve();
          await release.promise;
          yield { type: "agent.message", content: [{ type: "text", text: "Too late" }] };
        })(),
        send: async (_id: string, body: unknown) => { sent.push(body); },
      },
    } },
  } as unknown as Anthropic;
  const handle = createAgentSessionHandler({
    anthropic, pulseForEvent: () => pulse, agentId: "agent1", environmentId: "env1",
  });
  const controller = new AbortController();
  const running = handle(event(), { signal: controller.signal });
  await started.promise;
  controller.abort();
  await handle(event("prompted"), { signal: controller.signal, isStop: true });
  release.resolve();
  await running;
  expect(sent.some((body) => JSON.stringify(body).includes("user.interrupt"))).toBe(true);
  expect(calls.filter((call) => call.kind === "response")).toEqual([{ kind: "response", body: "Stopped. I made no further changes." }]);
});

test("reports a Claude failure as an agent error", async () => {
  const { pulse, calls } = pulseRecorder();
  const anthropic = {
    beta: { sessions: { create: async () => { throw new Error("offline"); } } },
  } as unknown as Anthropic;
  const handle = createAgentSessionHandler({
    anthropic, pulseForEvent: () => pulse, agentId: "agent1", environmentId: "env1",
  });
  await handle(event(), { signal: new AbortController().signal });
  expect(calls.map((call) => call.kind)).toEqual(["thought", "error"]);
  expect(calls.at(-1)?.body).toContain("offline");
});
