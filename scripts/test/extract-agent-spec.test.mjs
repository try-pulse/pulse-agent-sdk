import assert from "node:assert/strict";
import { test } from "node:test";
import { createSdkSpec } from "../extract-agent-spec.mjs";

test("keeps only selected public operations and their referenced components", () => {
  const source = {
    openapi: "3.0.3",
    info: { title: "Pulse API", version: "1" },
    paths: {
      "/auth/me": { get: { responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/MeResponse" } } } } } } },
      "/issues/{id}": { get: { responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Issue" } } } } } }, delete: { responses: {} } },
      "/internal/secret": { get: { responses: {} } },
    },
    components: {
      schemas: {
        MeResponse: { properties: { user: { $ref: "#/components/schemas/User" } } },
        User: { type: "object" },
        Issue: { type: "object" },
        InternalSecret: { type: "object" },
      },
    },
  };

  const result = createSdkSpec(source, {
    operations: { "/auth/me": ["get"], "/issues/{id}": ["get"] },
    schemas: ["MeResponse", "Issue"],
  });
  assert.deepEqual(Object.keys(result.paths), ["/auth/me", "/issues/{id}"]);
  assert.deepEqual(Object.keys(result.paths["/issues/{id}"]), ["get"]);
  assert.deepEqual(Object.keys(result.components.schemas).sort(), ["Issue", "MeResponse", "User"]);
  assert.equal(JSON.stringify(result).includes("InternalSecret"), false);
});

test("fails when a required operation or referenced component is missing", () => {
  const source = { openapi: "3.0.3", info: { version: "1" }, paths: {}, components: { schemas: {} } };
  assert.throws(() => createSdkSpec(source, { operations: { "/oauth/token": ["post"] }, schemas: [] }), /missing operation/);
  source.paths["/auth/me"] = { get: { schema: { $ref: "#/components/schemas/Missing" } } };
  assert.throws(() => createSdkSpec(source, { operations: { "/auth/me": ["get"] }, schemas: [] }), /missing component/);
});
