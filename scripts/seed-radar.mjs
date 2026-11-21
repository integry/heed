import process from "node:process";
import { URL } from "node:url";
import { demoGoal, radarDemoItems } from "./radar-demo.mts";

const args = process.argv.slice(2);
const dense = args.includes("--dense");
const server = new URL(
  args.find((arg) => !arg.startsWith("--")) ?? "http://localhost:8787",
);
if (server.protocol !== "http:" || server.hostname !== "localhost") {
  throw new Error("Run the radar seed against a local Wrangler workspace.");
}

const login = await globalThis.fetch(new URL("/auth/dev-login", server), {
  redirect: "manual",
});
const cookie = login.headers.getSetCookie()[0]?.split(";")[0];
if (!cookie) {
  throw new Error(
    "Enable DEV_LOGIN_EMAIL and SESSION_SECRET in the local Wrangler environment.",
  );
}

async function api(path, body, method = body ? "POST" : "GET") {
  const response = await globalThis.fetch(new URL("/api/" + path, server), {
    method,
    headers: {
      cookie,
      origin: server.origin,
      "content-type": "application/json",
    },
    body: body && JSON.stringify(body),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`${method} ${path}: ${await response.text()}`);
  return response.json();
}

const { timezone } = await api("settings");
const base = Date.parse(
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
);
const date = (days) =>
  new Date(base + days * 86_400_000).toISOString().slice(0, 10);
const timed = (days, time) => `${date(days)}T${time}:00.000Z`;
const dates = [date(0), date(1), date(14), null];

const projects = await api("projects");
async function project(name, color, sort) {
  return (
    projects.find((candidate) => candidate.name === name) ??
    api("projects", { name, color, sort })
  );
}

const engineering = await project("Engineering", "#86cbbb", 1);
const product = await project("Product", "#9fa6ec", 2);
const customer = await project("Customer Success", "#dda981", 3);
const inbox = projects.find(({ id }) => id === "inbox");

async function add(key, title, priority, options = {}) {
  const { item_id } = await api("items", {
    external_key: `radar-demo-${key}`,
    title,
    priority,
    ...options,
  });
  return item_id;
}

const [, goalTitle, goalPriority, goalRing] = demoGoal;
const goal = await add("reliability", goalTitle, goalPriority, {
  project: engineering.id,
  scheduled_on: dates[goalRing],
});
const verify = await add("verify", "Verify gateway failover", 7, {
  parent_id: goal,
  status: "active",
  agent_name: "Build agent",
});
const retries = await add("retries", "Review retry policy", 9, {
  parent_id: goal,
});
await api(`items/${retries}/handoff`, {
  note: "Confirm the maximum retry window.",
});
const audit = await add("audit", "Audit idempotency keys", 6, {
  parent_id: goal,
});
await api("dependencies", { item_id: audit, blocked_by_id: verify });
await add("trace", "Trace checkout errors", 5, {
  parent_id: goal,
  status: "done",
});

const owners = { inbox, engineering, product, customer };
const projectNames = Object.fromEntries(
  Object.entries(owners).map(([key, { name }]) => [key, name]),
);
for (const [key, [owner, title, priority, ring, options]] of radarDemoItems(
  dense,
  projectNames,
)) {
  const { time, ...fields } = options ?? {};
  await add(key, title, priority, {
    project: owners[owner].id,
    scheduled_on: dates[ring],
    ...fields,
    ...(time && { time_at: timed(0, time) }),
  });
}
process.stdout.write(`Radar demo ready at ${server.origin}/auth/dev-login\n`);
