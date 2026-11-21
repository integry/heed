# Operating costs

Heed targets the Cloudflare Workers Free plan for a typical single-user workspace. The basic app, Google sign-in, MCP, and Web Push can run without an AI provider.

## What keeps usage low

- **Opening the app.** Cloudflare serves the frontend files directly from Static Assets. API, auth, WebSocket and MCP requests invoke the Worker. The Worker verifies signed sessions locally, rejects malformed or unknown-workspace agent tokens, and rate-limits tokens before looking up the workspace.
- **Leaving a tab open.** An idle workspace can hibernate with browser WebSockets still connected. The browser works out time-based states from timestamps, so the server needs no recurring timer or poll. UI changes go over the existing connection. MCP uses short request/response calls.
- **Moving items and reporting progress.** Heed saves a drag when you drop the item. It saves heartbeat-only updates at most once every five minutes per item and skips the event log for those updates. Old events are pruned during ordinary writes, at most daily. The items table avoids secondary indexes, which would add writes to every edit.
- **Connecting an agent.** Heed hashes high-entropy tokens with SHA-256, limits canvas and tool responses, and caps standing guidance at 2,000 characters to keep the agent's context small.

## What to expect on Workers Free

Five agents reporting every five minutes for ten hours generate about 600 agent reports. With normal UI use, the [architecture estimate](architecture.md#9-operating-cost) is roughly 600–1,000 requests and 5,000 SQLite rows written per day. Many reports just refresh a heartbeat, and the workspace can sleep between requests. Actual usage depends on the size of your workspace, how frequently agents make changes, and the rest of your Cloudflare account's usage.

| Meter                         | Free allocation           |
| ----------------------------- | ------------------------- |
| Worker requests               | 100,000 per day           |
| Durable Object requests       | 100,000 per day           |
| Durable Object active compute | 13,000 GB-seconds per day |
| SQLite rows read              | 5 million per day         |
| SQLite rows written           | 100,000 per day           |

Static asset requests are free and unlimited. Daily quotas reset at midnight UTC. On Free, operations that exceed their quota can fail until it resets. Check your account's usage in Cloudflare. [Cloudflare Workers and Durable Objects pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Heed also limits agents to approximately 60 requests per minute per token at each Cloudflare location by default. Set `TOKEN_RATE_LIMIT_PER_MINUTE` to an integer from 1 to 1,000 to adjust it.

## Optional AI usage

Browser speech recognition, when available, avoids a Workers AI transcription call. Workers AI commands and Whisper fallback use Cloudflare's separate Workers AI allowance. Anthropic bills command calls against your Anthropic account. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

Heed defaults to eight requests per minute per signed-in session separately for commands and transcription (`COMMAND_RATE_LIMIT_PER_MINUTE`). It also defaults to 100 command calls (`COMMAND_DAILY_LIMIT`) and 100 transcriptions (`TRANSCRIBE_DAILY_LIMIT`) per workspace per day, resetting at midnight UTC. Audio recordings are limited to 30 seconds. Provider usage depends on the model and the work each call performs.
