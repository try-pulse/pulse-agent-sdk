import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { createSdkSpec, SDK_OPERATIONS, SDK_SCHEMAS } from "./extract-agent-spec.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = yaml.load(readFileSync(join(root, "specs/pulse-api.agent-sdk.yaml"), "utf8"));
const expected = createSdkSpec(spec);
const typeSource = readFileSync(join(root, "packages/sdk/src/types.ts"), "utf8");
const usedSchemas = [...typeSource.matchAll(/\bApi\["([^"]+)"\]/g)].map((match) => match[1]).sort();

assert.deepEqual(Object.keys(spec.paths).sort(), Object.keys(SDK_OPERATIONS).sort());
assert.deepEqual(usedSchemas, [...SDK_SCHEMAS].sort(), "SDK schema allowlist must match public type aliases");
assert.equal(spec.paths["/oauth/token"].post.operationId, "oauthToken");
for (const [path, methods] of Object.entries(SDK_OPERATIONS)) {
  assert.deepEqual(Object.keys(spec.paths[path]).sort(), [...methods].sort(), path);
}
for (const section of new Set([...Object.keys(spec.components), ...Object.keys(expected.components)])) {
  assert.deepEqual(
    Object.keys(spec.components[section] ?? {}).sort(),
    Object.keys(expected.components[section] ?? {}).sort(),
    `unrelated ${section} in SDK contract`,
  );
}
assert.equal(JSON.stringify(spec).includes("/internal/"), false, "internal route leaked into SDK contract");
console.log("ok: SDK contract contains only selected operations and reachable components");
