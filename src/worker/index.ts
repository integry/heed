export { Workspace } from "./workspace";

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
