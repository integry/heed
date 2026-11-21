import { CreateTokenSchema } from "@heedwork/core";
import { bearerUnauthorized, readBearer } from "./agent-auth.js";
import { equalSecretHashes, hashSecret } from "./token-secrets.js";
import type { AppContext } from "./app.js";
import { checkLimit } from "./seams.js";

export interface TokenAdminEnv {
  ADMIN_SECRET?: string;
}

export async function handleTokenBootstrap(
  request: Request,
  env: TokenAdminEnv,
  app: AppContext,
  workspaceId: string | undefined,
): Promise<Response> {
  if (!env.ADMIN_SECRET || !workspaceId)
    return new Response("Not found", { status: 404 });
  const bearer = readBearer(request);
  if (
    !bearer ||
    !equalSecretHashes(
      await hashSecret(bearer),
      await hashSecret(env.ADMIN_SECRET),
    )
  ) {
    return bearerUnauthorized();
  }

  const input = CreateTokenSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!input.success) {
    return Response.json(
      { error: input.error.issues[0].message },
      { status: 400 },
    );
  }

  const { label, scope, default_project_id } = input.data;
  await checkLimit(app.limits, workspaceId, "token.create");
  const workspace = app.workspace(workspaceId);
  try {
    const token = await workspace.createToken(label, scope, default_project_id);
    return Response.json(token, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Default project not found"
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
