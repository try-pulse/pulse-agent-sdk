---
"@try-pulse/agent-sdk": minor
---

Add a durable webhook receiver that verifies signed deliveries and awaits an idempotent inbox write before acknowledgment. Bind verified events to their installation with `PulseAgentClient.forEvent`.
