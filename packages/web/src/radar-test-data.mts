type DemoProject = "inbox" | "engineering" | "product" | "customer";
type DemoItem = [
  project: DemoProject,
  title: string,
  priority: number,
  ring: number,
  options?: {
    status?: "active" | "blocked" | "done";
    agent_name?: string;
    time_type?: "fixed" | "deadline";
    time?: string;
  },
];

export const demoGoal = [
  "engineering",
  "Payment reliability",
  10,
  0,
] satisfies DemoItem;

const sample: readonly DemoItem[] = [
  [
    "inbox",
    "Triage requests",
    7,
    0,
    { status: "active", agent_name: "Triage agent" },
  ],
  ["inbox", "Check access", 5, 1],
  ["inbox", "Inbox cleanup", 6, 2],
  ["inbox", "Read vendor notes", 4, 3],
  ["engineering", "API rollout", 8, 1],
  ["engineering", "Storage audit", 9, 2],
  ["engineering", "Cache cleanup", 5, 3],
  ["product", "Prototype review", 9, 0, { time_type: "fixed", time: "14:00" }],
  ["product", "Onboarding copy", 8, 1],
  ["product", "Usage dashboard", 6, 2],
  ["product", "Email variants", 4, 3],
  ["customer", "Client sync", 8, 0, { time_type: "deadline", time: "17:00" }],
  ["customer", "Billing follow-up", 9, 1, { status: "blocked" }],
  ["customer", "Help center refresh", 7, 2],
  ["customer", "Support templates", 4, 3],
  ["engineering", "Deploy log alerts", 6, 2, { status: "done" }],
];

export const demoProjects = [
  "inbox",
  "engineering",
  "product",
  "customer",
] as const;

export function* radarDemoItems(
  dense: boolean,
  projectNames: Record<DemoProject, string>,
) {
  for (const [index, item] of sample.entries())
    yield [String(index), item] as const;
  if (dense) {
    const subjects = [
      "Review",
      "Document",
      "Prototype",
      "Measure",
      "Validate",
      "Plan",
    ];
    for (let index = 0; index < 300 - sample.length - 1; index++) {
      const owner = demoProjects[index % demoProjects.length];
      const item: DemoItem = [
        owner,
        `${subjects[index % subjects.length]} ${projectNames[owner]} ${index + 1}`,
        1 + ((index * 7) % 10),
        Math.floor(index / demoProjects.length) % 4,
      ];
      yield [`dense-${index}`, item] as const;
    }
  }
}
