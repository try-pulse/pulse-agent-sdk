import { expect, test } from "bun:test";
import { readConfig } from "../src/config";

const valid = {
  ANTHROPIC_API_KEY: "anthropic-test",
  CLAUDE_AGENT_ID: "agent-test",
  CLAUDE_ENVIRONMENT_ID: "env-test",
  PULSE_CLIENT_ID: "client-test",
  PULSE_CLIENT_SECRET: "secret-test",
  PULSE_WEBHOOK_SECRET: "webhook-test",
  INSTALL_SECRET: "install-test",
  BASE_URL: "https://agent.example.com",
};

test("startup configuration requires every credential and a public base URL", () => {
  expect(() => readConfig({ ...valid, PULSE_WEBHOOK_SECRET: "" })).toThrow("PULSE_WEBHOOK_SECRET");
  expect(() => readConfig({ ...valid, BASE_URL: "" })).toThrow("BASE_URL");
  expect(() => readConfig({ ...valid, PORT: "99999" })).toThrow("PORT");
});

test("startup configuration returns normalized endpoint values", () => {
  const config = readConfig({ ...valid, BASE_URL: "https://agent.example.com/", PORT: "4000" });
  expect(config.baseUrl).toBe("https://agent.example.com");
  expect(config.port).toBe(4000);
  expect(config.pulseApiUrl).toBe("https://api.trypulse.tech/api/v1");
});
