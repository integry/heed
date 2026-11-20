import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("returns JSON from the health endpoint", async () => {
  const response = await exports.default.fetch("https://heed.test/api/health");

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ ok: true });
});
