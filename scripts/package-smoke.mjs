import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "pulse-sdk-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const packageName = "@try-pulse/agent-sdk";

function run(bin, args, cwd = root) {
  return execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    const manifest = JSON.parse(run(npm, ["pack", "--workspace", packageName, "--pack-destination", temp, "--json"]));
    const packed = Array.isArray(manifest) ? manifest.find((entry) => entry.name === packageName) : manifest[packageName];
    if (!packed?.filename) throw new Error(`npm pack did not return a manifest for ${packageName}`);
    tarball = join(temp, packed.filename);
  }

  writeFileSync(join(temp, "package.json"), '{"type":"module","private":true}\n');
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], temp);
  const installed = join(temp, "node_modules", packageName);
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const expected = JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8"));
  if (pkg.name !== packageName || pkg.version !== expected.version || pkg.publishConfig?.access !== "public") {
    throw new Error("Unexpected package name, version or access");
  }
  const files = readdirSync(installed, { recursive: true }).map((path) => path.split(sep).join("/"));
  if (files.some((path) => path.split("/").some((part) => part === "test" || part === "internal"))) {
    throw new Error("package contains test or internal files");
  }
  for (const path of ["LICENSE", "README.md", "CHANGELOG.md", "dist/src/index.d.ts.map", "src/index.ts"]) {
    if (!files.includes(path)) throw new Error(`Missing packed file: ${path}`);
  }
  writeFileSync(join(temp, "consumer.mts"), `
import {
  PulseAgentClient, createWebhookHandler, createWebhookReceiver,
  type AgentSession, type WebhookIntakeEvent, type WebhookReceiverOptions,
} from "@try-pulse/agent-sdk";
const client = new PulseAgentClient({ workspaceId: "workspace", tokenProvider: async () => "token" });
const handler = createWebhookHandler({ secret: "test-secret" });
const session: AgentSession | undefined = undefined;
void session;
const options: WebhookReceiverOptions = {
  secret: "test-secret", workspaceId: "workspace",
  async enqueue(event: WebhookIntakeEvent) {
    const key: readonly [string, string] | null = event.dedupeKey;
    void key;
  },
};
const receiver = createWebhookReceiver(options);
if (!client.me || !handler.handle || !receiver.receive) throw new Error("missing public SDK exports");
`);
  const readme = readFileSync(join(installed, "README.md"), "utf8");
  const examples = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)];
  const exampleFiles = examples.map((example, i) => {
    const name = `example-${i + 1}.mts`;
    writeFileSync(join(temp, name), example[1]);
    return name;
  });
  writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      noEmit: true, strict: true, module: "NodeNext", moduleResolution: "NodeNext",
      target: "ES2023", types: ["node"], typeRoots: [join(root, "node_modules/@types")],
    },
    files: ["consumer.mts", ...exampleFiles],
  }));
  run(node, [join(root, "node_modules/typescript/bin/tsc"), "-p", temp]);
  writeFileSync(join(temp, "receiver.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWebhookReceiver, signWebhook, WebhookError } from "@try-pulse/agent-sdk";
const raw = readFileSync(process.argv[2]);
const payload = JSON.parse(raw);
const secret = "test-secret";
const now = () => payload.webhook_timestamp;
const headers = (bytes) => ({ "Pulse-Signature": signWebhook(bytes, secret) });
const committed = new Map();
const gate = Promise.withResolvers();
const receiver = createWebhookReceiver({
  secret, workspaceId: payload.workspace_id, now,
  async enqueue(event) {
    await gate.promise;
    const key = JSON.stringify(event.dedupeKey);
    if (!committed.has(key)) committed.set(key, event);
  },
});
let acknowledged = false;
const first = receiver.receive(raw, headers(raw)).then(() => { acknowledged = true; });
await Promise.resolve();
assert.equal(acknowledged, false);
gate.resolve();
await first;
const retry = JSON.stringify({ ...payload, webhook_timestamp: now() + 1 });
await receiver.receive(retry, headers(retry));
assert.equal(committed.size, 1);
await assert.rejects(receiver.receive(Buffer.concat([raw, Buffer.from(" ")]), headers(raw)), WebhookError);
const broken = createWebhookReceiver({
  secret, workspaceId: payload.workspace_id, now,
  async enqueue() { throw new Error("inbox unavailable"); },
});
await assert.rejects(broken.receive(raw, headers(raw)), /inbox unavailable/);
`);
  const fixture = join(root, "fixtures/resource-webhook.json");
  run(node, ["receiver.mjs", fixture], temp);
  run(node, ["--input-type=commonjs", "-e",
    'import("@try-pulse/agent-sdk").then(({createWebhookReceiver}) => require("node:assert/strict").ok(createWebhookReceiver));',
  ], temp);
  if (process.env.PULSE_SDK_SMOKE_BUN) run("bun", ["receiver.mjs", fixture], temp);
  console.log(`ok: ${pkg.name}@${pkg.version} packed imports, types, examples and durable receiver`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
