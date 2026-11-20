# Heed

Heed is an attention view for mixed human and agent work. See the [architecture specification](docs/architecture.md) for the product and technical design.

Use Node.js 22.22.2 or later in the Node 22 series.

```sh
npm ci
npm run dev
npm run check
```

Open the URL printed by Wrangler to view the placeholder page. `GET /api/health` returns `{"ok":true}`. Restart the dev command after changing the frontend to rebuild its static assets.
