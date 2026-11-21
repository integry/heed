import process from "node:process";
import { URL } from "node:url";

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

const goal = await add("reliability", "Payment reliability", 10, {
  project: engineering.id,
  scheduled_on: dates[0],
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

const sample = [
  [
    inbox,
    "Triage requests",
    7,
    0,
    { status: "active", agent_name: "Triage agent" },
  ],
  [inbox, "Check access", 5, 1],
  [inbox, "Inbox cleanup", 6, 2],
  [inbox, "Read vendor notes", 4, 3],
  [engineering, "API rollout", 8, 1],
  [engineering, "Storage audit", 9, 2],
  [engineering, "Cache cleanup", 5, 3],
  [
    product,
    "Prototype review",
    9,
    0,
    { time_type: "fixed", time_at: timed(0, "14:00") },
  ],
  [product, "Onboarding copy", 8, 1],
  [product, "Usage dashboard", 6, 2],
  [product, "Email variants", 4, 3],
  [
    customer,
    "Client sync",
    8,
    0,
    { time_type: "deadline", time_at: timed(0, "17:00") },
  ],
  [customer, "Billing follow-up", 9, 1, { status: "blocked" }],
  [customer, "Help center refresh", 7, 2],
  [customer, "Support templates", 4, 3],
  [engineering, "Deploy log alerts", 6, 2, { status: "done" }],
];
for (const [
  index,
  [owner, title, priority, ring, options],
] of sample.entries()) {
  await add(index, title, priority, {
    project: owner.id,
    scheduled_on: dates[ring],
    ...options,
  });
}

if (dense) {
  const owners = [inbox, engineering, product, customer];
  const subjects = [
    "Review",
    "Document",
    "Prototype",
    "Measure",
    "Validate",
    "Plan",
  ];
  for (let index = 0; index < 300 - sample.length - 1; index++) {
    const owner = owners[index % owners.length];
    await add(
      `dense-${index}`,
      `${subjects[index % subjects.length]} ${owner.name} ${index + 1}`,
      1 + ((index * 7) % 10),
      {
        project: owner.id,
        scheduled_on: dates[Math.floor(index / owners.length) % dates.length],
      },
    );
  }
}
process.stdout.write(`Radar demo ready at ${server.origin}/auth/dev-login\n`);
