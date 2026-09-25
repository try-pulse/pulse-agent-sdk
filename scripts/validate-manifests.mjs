// Validates every sample manifest against the vendored agent-app manifest schema, and checks
// the schema still refuses what it must (admin, http redirect, public, app-only events).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "specs/agent-app-manifest.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const manifests = ["examples/scout/pulse-agent-app.json", "examples/claude-managed-agents/pulse-agent-app.json"];
let failed = false;
for (const rel of manifests) {
  const doc = JSON.parse(readFileSync(join(root, rel), "utf8"));
  if (validate(doc)) {
    console.log(`valid: ${rel}`);
  } else {
    failed = true;
    console.error(`INVALID: ${rel}`);
    for (const e of validate.errors ?? []) console.error(`  ${e.instancePath || "/"} ${e.message}`);
  }
}

const base = JSON.parse(readFileSync(join(root, manifests[0]), "utf8"));
const mustFail = {
  "admin scope": { ...base, oauth: { ...base.oauth, scopes: ["read", "admin"] } },
  "http redirect": { ...base, oauth: { ...base.oauth, redirect_uris: ["http://scout.example.com/cb"] } },
  "public distribution": { ...base, distribution: "public" },
  "app-only event in resource_types": { ...base, webhook: { ...base.webhook, resource_types: ["AgentSessionEvent"] } },
  "name containing Pulse": { ...base, name: "Pulse Scout" },
};
for (const [label, doc] of Object.entries(mustFail)) {
  if (validate(doc)) {
    failed = true;
    console.error(`schema accepted a manifest it must refuse: ${label}`);
  } else {
    console.log(`refused as expected: ${label}`);
  }
}
if (failed) process.exit(1);
