import { DurableObject } from "cloudflare:workers";

export class Workspace extends DurableObject<Env> {}

export default {
  fetch(request) {
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/api/health"
    ) {
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
