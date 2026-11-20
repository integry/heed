# Heed

Heed is an attention view for mixed human and agent work. See the [architecture specification](docs/architecture.md) for the product and technical design.

Use Node.js 22.22.2 or later in the Node 22 series.

```sh
npm ci
npm run dev
npm run check
```

Open the URL printed by Wrangler to view the placeholder page. `GET /api/health` returns `{"ok":true}`. Restart the dev command after changing the frontend to rebuild its static assets.

## Bootstrap an agent token

Set `ADMIN_SECRET` to a random value in `.dev.vars` and start the local Worker. For a deployed Worker, set the same value as a Wrangler secret on the Worker and as an environment variable for the command. Set `HEED_URL` to your deployment's HTTPS origin when creating a token there.

```sh
npm run token:create -- "Build agent" report
```

Save the printed token when you create it. Send it as `Authorization: Bearer <token>` to `POST /api/report`. The scope defaults to `report`. Pass `steer` for human-operated clients that need steering permissions. You can pass a default project ID after the scope.

The Worker allows approximately 60 agent requests per minute per token at each Cloudflare location. Set the Worker variable `TOKEN_RATE_LIMIT_PER_MINUTE` to an integer from 1 to 1000 to adjust the limit.

## Web Push

Run `npm run vapid:generate` and put the two generated keys in `.dev.vars`
for local development. Set `VAPID_SUBJECT` to a contact URL or `mailto:`
address. For a deployed Worker, store `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
and `VAPID_SUBJECT` as Wrangler secrets. Set the Worker variable
`PUSH_RATE_LIMIT_PER_HOUR` to adjust the default of six handoff notifications
per token per rolling hour. Each handoff uses one slot and fans out to all
subscribed devices.

Enable notifications in Heed’s Settings on each device. On iOS, add Heed to
the Home Screen and open it from there first. **Send test notification**
shows a local notification to check that the device displays it.

## Radar demo

With local development sign-in configured in `.dev.vars` and Wrangler running,
run `npm run seed:radar` and open `http://localhost:8787/auth/dev-login`.
Use `npm run seed:radar -- --dense` to populate 300 overview bubbles.

## Enable voice and chat commands

Set `WORKERS_AI_COMMAND_MODEL` to a Workers AI model that supports multi-turn tool calling, or set `ANTHROPIC_COMMAND_MODEL` and the `ANTHROPIC_API_KEY` secret. Anthropic takes precedence when both are configured. The command bar appears when a provider is configured. See [the local configuration example](.dev.vars.example) for available settings. Uncomment the `ai` binding in `wrangler.jsonc` to enable Workers AI commands or Whisper. Local Wrangler requires Cloudflare sign-in when that binding is enabled.

Heed sends the command, standing guidance and a compact workspace view to the selected provider. Voice input uses browser speech recognition where available and falls back to Workers AI Whisper when the `AI` binding is present. Recordings are limited to 30 seconds. Each session can make eight requests per minute to each endpoint by default. The workspace daily caps default to 100 command calls and 100 transcriptions, resetting at midnight UTC.
