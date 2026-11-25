---
"@try-pulse/agent-sdk": minor
---

Add a durable webhook receiver that verifies signed deliveries and awaits an idempotent inbox write before acknowledgment. Bind verified events to their installation with `PulseAgentClient.forEvent`.

Keep the post-ack callback handler available for in-process agents. Deduplicate retried resource callbacks per installation, honor Stop across out-of-order callbacks, and refresh generated Pulse API issue types. Refuse API and OAuth redirects and bound automatic Retry-After waits.
