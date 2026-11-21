import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { fetchOpen } from "./worker-test-helpers";
import { newTokenSecret } from "./token-secrets";
import { getWorkspaceStub } from "./workspace";

function request(path: string, token?: string, body: object = {}) {
  return new Request(`https://heed.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

it("rejects malformed and unknown-workspace tokens before the limiter or Workspace lookup", async () => {
  const getByName = vi.fn(() => {
    throw new Error("Unexpected workspace lookup");
  });
  const limit = vi.fn();
  const bindings = {
    ...env,
    TOKEN_RATE_LIMITER: { limit },
    WORKSPACE: { getByName } as unknown as Env["WORKSPACE"],
  };
  const secret = newTokenSecret();
  for (const token of [
    undefined,
    "heed_default_wrong",
    `heed_other_${secret}`,
    `heed_default_${secret.slice(0, -1)}B`,
  ]) {
    for (const path of ["/api/report", "/mcp"]) {
      const response = await fetchOpen(request(path, token), bindings);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
  }
  expect(getByName).not.toHaveBeenCalled();
  expect(limit).not.toHaveBeenCalled();
});

it("limits each token before Workspace lookup across both agent routes", async () => {
  const counts = new Map<string, number>();
  const limit = vi.fn(async ({ key, delta = 1 }: RateLimitOptions) => {
    const count = counts.get(key) ?? 0;
    if (count >= 1_000_000) return { success: false };
    counts.set(key, count + delta);
    return { success: true };
  });
  const stub = getWorkspaceStub(env, "default");
  const getByName = vi.fn(() => stub);
  const bindings = {
    ...env,
    TOKEN_RATE_LIMIT_PER_MINUTE: "2",
    TOKEN_RATE_LIMITER: { limit },
    WORKSPACE: { getByName } as unknown as Env["WORKSPACE"],
  };
  const token = `heed_default_${newTokenSecret()}`;
  for (const path of ["/api/report", "/mcp"]) {
    expect((await fetchOpen(request(path, token), bindings)).status).toBe(401);
  }
  const throttled = await fetchOpen(request("/api/report", token), bindings);
  expect(throttled.status).toBe(429);
  expect(throttled.headers.get("Retry-After")).toBe("60");
  expect(getByName).toHaveBeenCalledTimes(2);

  const another = `heed_default_${newTokenSecret()}`;
  expect(
    (await fetchOpen(request("/api/report", another), bindings)).status,
  ).toBe(401);
  expect(limit).toHaveBeenCalledTimes(4);
  expect(limit.mock.calls[0][0]).toEqual({
    key: expect.any(String),
    delta: 500_000,
  });
  expect(limit.mock.calls[0][0].key).not.toContain(token);
  expect(counts.size).toBe(2);
});

it("returns JSON for an authenticated report and throttles the next report", async () => {
  const stub = getWorkspaceStub(env, "default");
  const { token } = await stub.createToken("Session hook");
  const { item_id } = await stub.addItem(
    { kind: "human" },
    { title: "Build", external_key: "repo#branch" },
  );
  const limit = vi
    .fn<RateLimit["limit"]>()
    .mockResolvedValueOnce({ success: true })
    .mockResolvedValueOnce({ success: false });
  const bindings = { ...env, TOKEN_RATE_LIMITER: { limit } };
  const send = () =>
    fetchOpen(
      request("/api/report", token, {
        external_key: "repo#branch",
        status: "active",
      }),
      bindings,
    );

  const first = await send();
  expect(first.status).toBe(200);
  expect(first.headers.get("Content-Type")).toContain("application/json");
  expect(await first.json()).toMatchObject({
    item_id,
    items: [{ status: "active" }],
    guidance_updated_at: null,
  });
  const second = await send();
  expect(second.status).toBe(429);
  expect(second.headers.get("Retry-After")).toBe("60");
});

it("creates tokens through the guarded bootstrap and uses their scope on reports", async () => {
  const bootstrap = "/api/admin/tokens";
  const admin = "test-only-bootstrap-secret";
  const bindings = {
    ...env,
    ADMIN_SECRET: admin,
    TOKEN_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  expect(
    (
      await fetchOpen(request(bootstrap, admin), {
        ...bindings,
        ADMIN_SECRET: "",
      })
    ).status,
  ).toBe(404);
  expect((await fetchOpen(request(bootstrap, "wrong"), bindings)).status).toBe(
    401,
  );
  expect(
    (
      await fetchOpen(
        request(bootstrap, admin, { label: "Bad", scope: "owner" }),
        bindings,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await fetchOpen(
        request(bootstrap, admin, {
          label: "Bad",
          default_project_id: "missing",
        }),
        bindings,
      )
    ).status,
  ).toBe(400);

  const response = await fetchOpen(
    request(bootstrap, admin, { label: "Build agent" }),
    bindings,
  );
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const { id, token, scope } = await response.json<{
    id: string;
    token: string;
    scope: string;
  }>();
  expect(scope).toBe("report");

  const stub = getWorkspaceStub(env, "default");
  const { item_id } = await stub.addItem(
    { kind: "human" },
    { title: "Backlog", scheduled_on: null },
  );
  const body = { item_id, status: "active" };
  const report = await fetchOpen(request("/api/report", token, body), bindings);
  expect(report.status).toBe(200);
  expect(await report.json()).toMatchObject({
    item_id,
    ignored_fields: ["scheduled_on"],
  });
  expect(
    (
      await fetchOpen(
        request("/api/report", token, { item_id: "missing" }),
        bindings,
      )
    ).status,
  ).toBe(404);
  expect(await stub.revokeToken(id)).toBe(true);
  expect(
    (await fetchOpen(request("/api/report", token, body), bindings)).status,
  ).toBe(401);
});
