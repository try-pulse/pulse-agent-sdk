// Extracts the SDK's pulse-api contract, copies the other source specs, and records their
// revisions. Run it when pulse-api or pulse-agent change the contract, then `npm run generate`.
//   PULSE_API_DIR=../pulse-api PULSE_AGENT_DIR=../pulse-agent npm run specs:sync
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { createSdkSpec } from "./extract-agent-spec.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = resolve(root, process.env.PULSE_API_DIR ?? "../pulse-api");
const agentDir = resolve(root, process.env.PULSE_AGENT_DIR ?? "../pulse-agent");
const check = process.argv.includes("--check");

const sources = [
  { repo: "pulse-api", dir: apiDir, from: "docs/openapi/bundled.yaml", to: "specs/pulse-api.agent-sdk.yaml", project: true },
  { repo: "pulse-api", dir: apiDir, from: "docs/openapi/schemas/agent-app-manifest.schema.json", to: "specs/agent-app-manifest.schema.json" },
  { repo: "pulse-agent", dir: agentDir, from: "docs/openapi/agent-sessions.yaml", to: "specs/agent-sessions.yaml" },
];

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const rows = [];
for (const s of sources) {
  const ref = (s.repo === "pulse-api" ? process.env.PULSE_API_REF : process.env.PULSE_AGENT_REF) ?? "HEAD";
  const head = git(s.dir, "rev-parse", "--verify", ref + "^{commit}");
  let snapshot = execFileSync("git", ["-C", s.dir, "show", head + ":" + s.from], { maxBuffer: 32 * 1024 * 1024 });
  if (s.project) {
    const source = yaml.load(snapshot.toString("utf8"));
    const projected = createSdkSpec(source);
    snapshot = Buffer.from(yaml.dump(projected, { lineWidth: 120, noRefs: true }).replace(/[ \t]+$/gm, ""));
  }
  if (check) {
    if (!readFileSync(join(root, s.to)).equals(snapshot)) throw new Error(s.to + " differs from " + s.repo + "@" + head);
  } else {
    writeFileSync(join(root, s.to), snapshot);
  }
  const sha256 = createHash("sha256").update(snapshot).digest("hex");
  rows.push(`| \`${s.to}\` | ${s.repo} \`${s.from}\` | \`${head.slice(0, 12)}\` | \`${sha256.slice(0, 16)}\` |`);
  console.log(`${check ? "checked" : "synced"} ${s.to} from ${s.repo}@${head}`);
}
if (check) process.exit(0);
writeFileSync(
  join(root, "specs/SOURCES.md"),
  `# Vendored contract sources\n\nThe SDK's types are generated from these snapshots (\`npm run generate\`), and CI checks the\ngenerated files against them (\`npm run types:check\`). The pulse-api snapshot is a generated\nprojection containing only SDK operations and reachable component schemas. Never edit these\nsnapshots here: change the source repo, then run \`npm run specs:sync && npm run generate\`.\n\n| File | Source | Revision | sha256 (16) |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\nSynced ${new Date().toISOString().slice(0, 10)}.\n`,
);
