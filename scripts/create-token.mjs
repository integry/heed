import process from "node:process";
import { URL } from "node:url";

async function createToken() {
  const [label, scope = "report", defaultProjectId, ...extra] =
    process.argv.slice(2);
  if (!label?.trim() || !["report", "steer"].includes(scope) || extra.length) {
    throw new Error(
      "Usage: npm run token:create -- <label> [report|steer] [default_project_id]",
    );
  }

  try {
    process.loadEnvFile(".dev.vars");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { ADMIN_SECRET, HEED_URL = "http://localhost:8787" } = process.env;
  if (!ADMIN_SECRET)
    throw new Error("Set ADMIN_SECRET in the environment or in .dev.vars");

  const endpoint = new URL("/api/admin/tokens", HEED_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    endpoint.hostname,
  );
  if (!(
    endpoint.protocol === "https:" ||
    (endpoint.protocol === "http:" && loopback)
  )) {
    throw new Error("HEED_URL must use HTTPS or point to a local HTTP server");
  }

  const response = await globalThis.fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      label,
      scope,
      default_project_id: defaultProjectId,
    }),
    redirect: "error",
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const detail =
      typeof result?.error === "string" ? ` (${result.error})` : "";
    throw new Error(
      `Token creation failed with HTTP ${response.status}${detail}`,
    );
  }
  const { token } = await response.json();
  if (typeof token !== "string")
    throw new Error("The server did not return a token");
  process.stdout.write(`${token}\n`);
}

try {
  await createToken();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
