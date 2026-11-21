# Heed

Heed is a human-first attention view for work you do and work your agents do. See what needs your attention now, what’s coming up, and where work is blocked. Heed displays work. You assign it elsewhere, and agents report progress back to Heed.

> **Screenshot placeholder** — Radar and Horizon Stream showing active work and handoffs.
>
> **GIF placeholder** — Reschedule an item by dragging it, then open the Needs me filter.

## Features

- See the same workspace through Radar, Board, Treemap, and Dependencies lenses alongside the Horizon Stream.
- Use **Needs me** to find handoffs and active work whose agent has gone quiet.
- Drag, resize, reschedule, and hide items. Agents with report tokens respect the placement fields you lock.
- Give agents standing guidance on where to place work, what to prioritise, and when to interrupt you.
- Connect Claude Code, Cursor, or Codex over MCP, or send progress from session hooks over HTTP.
- Install Heed on mobile and opt in to Web Push handoffs. Add an AI provider to enable the chat and voice command bar.

## Quick start

**Deploy your own workspace** using the [self-hosting guide](docs/self-hosting.md). It covers Cloudflare deployment, Google sign-in, and creating your first agent token.

**Try it locally** from a copy of the [Heed source](https://github.com/integry/heed/tree/51-epic-heed-open-dcm). Use Node.js 22.22.2 or a newer release in the Node 22 series, with npm and OpenSSL installed. From the repository root:

```sh
npm ci
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

Paste the generated value into `SESSION_SECRET` in `.dev.vars` and set `DEV_LOGIN_EMAIL=dev@example.test` there. Start the local Worker:

```sh
npm run dev
```

In another terminal, optionally run `npm run seed:radar` to populate a demo workspace. Use `npm run seed:radar -- --dense` for a larger demo. Open <http://localhost:8787/auth/dev-login> to sign in. Restart the dev command after frontend changes to rebuild its static assets.

## Repository layout

- `packages/core` (`@heedwork/core`) contains the shared types, schemas, and derived-state functions.
- `packages/engine` (`@heedwork/engine`) contains the Cloudflare Worker and Workspace Durable Object.
- `packages/web` (`@heedwork/web`) contains the React app. The root [Wrangler configuration](wrangler.jsonc) serves `packages/web/dist` and points to the Worker entry in the engine.

Run `npm run check` from the repository root to typecheck, lint, test, and build all three workspaces.

## Documentation

- [Self-hosting on Cloudflare](docs/self-hosting.md)
- [Agent setup, session hooks, and guidance](docs/agents.md)
- [Operating costs and the Workers Free plan](docs/cost.md)
- [Product and architecture specification](docs/architecture.md)

Heed is released under the [MIT License](LICENSE).
