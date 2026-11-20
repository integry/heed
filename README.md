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
