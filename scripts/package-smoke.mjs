import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "pulse-sdk-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function run(bin, args, cwd = root) {
  return execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

try {
  run(npm, ["run", "build", "--workspace", "@try-pulse/agent-sdk"]);
  const packed = JSON.parse(run(npm, ["pack", "--workspace", "@try-pulse/agent-sdk", "--pack-destination", temp, "--json"]))[0];
  const packageFiles = packed.files.map((file) => file.path);
  if (packageFiles.some((path) => path.includes("/test/") || path.includes("/internal/"))) {
    throw new Error("package contains test or internal files");
  }

  writeFileSync(join(temp, "package.json"), '{"type":"module","private":true}\n');
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temp, packed.filename)], temp);
  writeFileSync(join(temp, "consumer.mts"), `
import { PulseAgentClient, createWebhookHandler, type AgentSession } from "@try-pulse/agent-sdk";
const client = new PulseAgentClient({ workspaceId: "workspace", tokenProvider: async () => "token" });
const handler = createWebhookHandler({ secret: "test-secret" });
const session: AgentSession | undefined = undefined;
void session;
if (!client.me || !handler.handle) throw new Error("missing public SDK exports");
`);
  writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      noEmit: true, strict: true, module: "NodeNext", moduleResolution: "NodeNext",
      target: "ES2023", skipLibCheck: true,
    },
    files: ["consumer.mts"],
  }));
  run(node, [join(root, "node_modules/typescript/bin/tsc"), "-p", temp]);
  const runtime = run(node, ["--input-type=module", "-e",
    'import { PulseAgentClient, createWebhookHandler } from "@try-pulse/agent-sdk"; if (!PulseAgentClient || !createWebhookHandler) process.exit(1);',
  ], temp);
  if (runtime) process.stdout.write(runtime + "\n");
  console.log(`ok: packed ${packed.name}@${packed.version} imports and typechecks in an isolated consumer`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
