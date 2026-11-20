# Connect agents to Heed

[Create a Heed API token](self-hosting.md#first-sign-in-and-api-token) with `report` scope for each agent or hook. Use `steer` for a human-operated client that needs to change guidance or other protected fields. Set these variables in the environment that launches your client, substituting your Heed origin and the issued token.

```sh
export HEED_URL='https://your-heed.example'
export HEED_TOKEN='your-issued-token'
```

Heed uses Streamable HTTP at `/mcp`. The server sends current workspace guidance on initialization. If `guidance_updated_at` changes during a run, use `get_canvas` to read the latest guidance.

After connecting, ask the client to call `get_canvas` for an item you already work on. Use the returned ID to report progress, or create an item with `add_item` if you need one. A stable `external_key`, such as a pull request URL, lets repeated adds update the same item.

## Claude Code

Add this to `.mcp.json` at the project root. Start Claude Code with the variables above and run `/mcp` to confirm the connection. [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)

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

Add this to `~/.cursor/mcp.json` for all projects or `.cursor/mcp.json` for one project. Launch Cursor with the variables above and check that Heed appears in MCP settings. [Cursor MCP configuration](https://cursor.com/docs/mcp#config-interpolation)

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

Add this to `~/.codex/config.toml` and substitute your Heed origin. Launch Codex with `HEED_TOKEN` set and run `/mcp` to check the connection. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli#streamable-http-servers)

```toml
[mcp_servers.heed]
url = "https://your-heed.example/mcp"
bearer_token_env_var = "HEED_TOKEN"
```

## Session start and stop hooks

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

For Claude Code, register the hooks in `.claude/settings.json`. `Stop` runs when Claude finishes a response. Use `SessionEnd` in its place if you want the heartbeat only on session exit. Report the actual outcome with `report_progress` when the work is done or blocked. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

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

The script also works from other hook runners. Call it with `sh .claude/hooks/heed-report.sh start` at session start and `sh .claude/hooks/heed-report.sh stop` at session end, with the same environment variables.

## Write workspace guidance

Open **Guidance** in Heed and save up to 2,000 characters of standing instructions. Use the names of your projects, say where new work belongs, and give specific criteria for urgency and push notifications. Include how much detail you want in the workspace. If a handoff can wait, an agent can flag it for **Needs me** with `notify: false`.

Agents receive guidance when they connect and in `get_canvas`. The command bar also uses it, if enabled. Permissions, field locks, and limits still apply.

### Example guidance

**Billing week**

> Put invoice and payment work in Billing and schedule it for Today at high priority. Park routine marketing in the backlog unless it has a deadline. Flag decisions I owe you and send a push only if production payments are affected.

**Release checklist**

> Use one goal in Release for the rollout. Add a child item for each independently reviewable step. Keep progress notes to one line and link each completed step to its PR. Flag the go/no-go decision when checks pass. Send a push only if a failed check blocks today's release.

**Support triage**

> Keep one item per support case in Support. Schedule cases with a customer deadline for that day and keep routine follow-ups in the backlog. In handoff notes, include the decision you need and when you need it. Send a push if a customer cannot use the product and you need my input to restore access.

## Token scopes

| Scope    | What it can do                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report` | Read the canvas and guidance, add items and sub-items, record progress or status, edit unlocked fields, manage dependencies, reopen completed work, and flag handoffs. Handoffs can request push when Web Push is enabled and guidance calls for it. Updates to human-locked fields are ignored and listed in `ignored_fields`. |
| `steer`  | Do everything a report token can do, plus replace guidance, move an existing item between projects, change visibility, change sort order and layout position, and unlock fields. Steering writes to lockable fields set human locks.                                                                                            |

Create and revoke tokens in **Settings → API tokens**. Give each reporting agent or hook its own report token and reserve steer tokens for clients you operate yourself.
