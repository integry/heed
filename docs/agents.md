# Connect agents to Heed

[Create a Heed API token](../README.md#bootstrap-an-agent-token) with `report` scope for each agent or hook. Use `steer` for a human-operated client that needs to change guidance or other protected fields. Set these variables in the environment that launches your client, substituting your Heed origin and the issued token.

```sh
export HEED_URL='https://your-heed.example'
export HEED_TOKEN='your-issued-token'
```

Heed uses Streamable HTTP at `/mcp`. The server sends current workspace guidance on initialization. If `guidance_updated_at` changes during a run, use `get_canvas` to read the latest guidance.

## Claude Code

Add this to `.mcp.json` at the project root. Start Claude Code with the variables above and run `/mcp` to confirm the connection. [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)

```json
{
  "mcpServers": {
    "heed": {
      "type": "http",
      "url": "${HEED_URL}/mcp",
      "headers": { "Authorization": "Bearer ${HEED_TOKEN}" }
    }
  }
}
```

## Cursor

Add this to `~/.cursor/mcp.json` for all projects or `.cursor/mcp.json` for one project. Launch Cursor with the variables above. [Cursor MCP configuration](https://cursor.com/docs/mcp#config-interpolation)

```json
{
  "mcpServers": {
    "heed": {
      "url": "${env:HEED_URL}/mcp",
      "headers": { "Authorization": "Bearer ${env:HEED_TOKEN}" }
    }
  }
}
```

## Codex

Add this to `~/.codex/config.toml` and substitute your Heed origin. Launch Codex with `HEED_TOKEN` set. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli#streamable-http-servers)

```toml
[mcp_servers.heed]
url = "https://your-heed.example/mcp"
bearer_token_env_var = "HEED_TOKEN"
```

## Claude Code start and stop hooks

Use `POST /api/report` to report directly from hooks. The hook below uses `curl` and `jq` and expects an existing open item. Set `HEED_ITEM_ID` to the ID returned by `get_canvas` or `add_item` before starting Claude Code. If you use a stable external key instead, substitute `external_key` and its value in the payload.

Save this as `.claude/hooks/heed-report.sh`.

```sh
#!/bin/sh
set -eu

# Skip sessions without a linked item.
[ -n "${HEED_ITEM_ID:-}" ] || exit 0
: "${HEED_URL:?Set HEED_URL}" "${HEED_TOKEN:?Set HEED_TOKEN}"

agent_name=${HEED_AGENT_NAME:-Claude Code}
case "$1" in
  start)
    payload=$(jq -nc --arg id "$HEED_ITEM_ID" --arg agent "$agent_name" \
      '{item_id: $id, agent_name: $agent, status: "active"}')
    ;;
  stop)
    # Stopping a turn can leave work in progress. Refresh the heartbeat.
    payload=$(jq -nc --arg id "$HEED_ITEM_ID" --arg agent "$agent_name" \
      '{item_id: $id, agent_name: $agent}')
    ;;
  *) exit 1 ;;
esac

curl --silent --show-error --fail --max-time 5 \
  --header "Authorization: Bearer $HEED_TOKEN" \
  --header "Content-Type: application/json" \
  --data "$payload" "${HEED_URL%/}/api/report" >/dev/null
```

Register the hooks in `.claude/settings.json`. `Stop` runs when Claude finishes a response. Use `SessionEnd` in its place if you want the heartbeat only on session exit. Report the actual outcome with `report_progress` when the work is done or blocked. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/heed-report.sh\" start"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/heed-report.sh\" stop"
          }
        ]
      }
    ]
  }
}
```
