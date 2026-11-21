# Repository conventions

[docs/architecture.md](docs/architecture.md) is the source of truth for product behavior, architecture, and cost constraints. Keep the implementation aligned with the spec.

## Layout and testing

- Put Worker routes, Durable Objects, and server-side operations in `src/worker`.
- Put runtime-independent contracts and utilities in `src/shared`.
- Put the React frontend in `src/web`. Vite builds its static assets into `dist/web`.
- Co-locate tests with the code they cover. Worker tests run under Vitest in workerd. Web tests run under Vitest with jsdom. Run `npm run check` before handing off changes.

## Operations

Keep one set of workspace operations in the Workspace Durable Object. MCP, HTTP, voice and chat, and the UI all use those operations. Keep behavior and authorization rules consistent across entry points.

## Operating cost

- Serve the SPA through Cloudflare Static Assets. Only `/api/*`, `/auth/*`, `/ws`, and `/mcp` invoke the Worker.
- Keep Durable Objects hibernatable. Use the WebSocket Hibernation API and avoid timers, alarms, and polling. Derive time-based UI state from timestamps. Keep MCP stateless and request/response only.
- Minimize SQLite writes. Persist heartbeat-only reports at most once per five minutes per item with no event. Write drags on drop and avoid secondary indexes on items. Prune events older than 90 days during ordinary writes at most once per day.
- Verify signed sessions and enforce per-token rate limits in the Worker before calling the Durable Object. Reject malformed and unknown-workspace tokens before a Durable Object lookup. Send UI mutations over the open WebSocket.
- Hash high-entropy API tokens with SHA-256. Bound `get_canvas` and tool responses, cap guidance at 2,000 characters, and prefer browser speech transcription when available.
