import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Token } from "../shared/workspace";
import { decodeBase64Url, encodeBase64Url } from "./signed-cookie";
import { getWorkspaceStub } from "./workspace";

it("returns the plaintext once, persists only its hash, and revokes by ID", async () => {
  const workspaceId = crypto.randomUUID();
  const stub = getWorkspaceStub(env, workspaceId);
  const project = await stub.createProject({ name: "Builds" });
  const { token, ...metadata } = await stub.createToken(
    "Builder",
    "steer",
    project.id,
  );
  const prefix = `heed_${workspaceId}_`;
  expect(token.startsWith(prefix)).toBe(true);
  const secret = token.slice(prefix.length);
  expect(decodeBase64Url(secret)).toHaveLength(32);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  expect(metadata).toMatchObject({
    label: "Builder",
    scope: "steer",
    default_project_id: project.id,
    last_used_at: null,
  });
  expect(await stub.listTokens()).toEqual([metadata]);
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    const row = sql.exec<Token>("SELECT * FROM tokens").one();
    expect(row).toEqual({
      ...metadata,
      secret_hash: encodeBase64Url(new Uint8Array(digest)),
    });
  });
  expect(
    await getWorkspaceStub(env, crypto.randomUUID()).verifyToken(secret),
  ).toBeNull();
  expect(await stub.verifyToken(secret)).toEqual({
    kind: "agent",
    name: "Builder",
    token_id: metadata.id,
    scope: "steer",
    default_project_id: project.id,
  });
  await stub.deleteProject(project.id);
  expect(await stub.verifyToken(secret)).toMatchObject({
    default_project_id: null,
  });
  expect(await stub.revokeToken(metadata.id)).toBe(true);
  expect(await stub.revokeToken(metadata.id)).toBe(false);
  expect(await stub.listTokens()).toEqual([]);
  expect(await stub.verifyToken(secret)).toBeNull();
});

it("records token use at most once per hour", async () => {
  const id = crypto.randomUUID();
  const stub = getWorkspaceStub(env, id);
  const { token } = await stub.createToken("Reporter");
  const secret = token.slice(`heed_${id}_`.length);
  await runInDurableObject(stub, async (workspace, { storage: { sql } }) => {
    expect(await workspace.verifyToken(secret)).toMatchObject({
      scope: "report",
    });
    const [first] = workspace.listTokens();
    expect(first.last_used_at).not.toBeNull();

    const recent = new Date(Date.now() - 30 * 60_000).toISOString();
    sql.exec("UPDATE tokens SET last_used_at = ?", recent);
    await workspace.verifyToken(secret);
    expect(workspace.listTokens()[0].last_used_at).toBe(recent);

    const older = new Date(Date.now() - 61 * 60_000).toISOString();
    sql.exec("UPDATE tokens SET last_used_at = ?", older);
    await workspace.verifyToken(secret);
    expect(Date.parse(workspace.listTokens()[0].last_used_at!)).toBeGreaterThan(
      Date.parse(recent),
    );
  });
});
