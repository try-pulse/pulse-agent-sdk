export type ExampleConfig = {
  anthropicApiKey: string;
  claudeAgentId: string;
  claudeEnvironmentId: string;
  pulseClientId: string;
  pulseClientSecret: string;
  pulseWebhookSecret: string;
  installSecret: string;
  baseUrl: string;
  pulseApiUrl: string;
  port: number;
};

export function readConfig(env: NodeJS.ProcessEnv): ExampleConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required (see .env.example)`);
    return value;
  };
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  const baseUrl = required("BASE_URL").replace(/\/+$/, "");
  const pulseApiUrl = (env.PULSE_API_URL?.trim() || "https://api.trypulse.tech/api/v1").replace(/\/+$/, "");
  for (const [name, value] of [["BASE_URL", baseUrl], ["PULSE_API_URL", pulseApiUrl]] as const) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be an absolute HTTP(S) URL`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${name} must be an absolute HTTP(S) URL without credentials`);
    }
  }
  return {
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    claudeAgentId: required("CLAUDE_AGENT_ID"),
    claudeEnvironmentId: required("CLAUDE_ENVIRONMENT_ID"),
    pulseClientId: required("PULSE_CLIENT_ID"),
    pulseClientSecret: required("PULSE_CLIENT_SECRET"),
    pulseWebhookSecret: required("PULSE_WEBHOOK_SECRET"),
    installSecret: required("INSTALL_SECRET"),
    baseUrl,
    pulseApiUrl,
    port,
  };
}
