import { workspaceCalendar } from "./derived-state.js";
import { LockableFieldSchema } from "./item-operations.js";
import { INBOX_PROJECT_ID, RadarBandSchema, ScopeSchema } from "./workspace.js";
import type { RadarBand, Scope, Status } from "./workspace.js";
import type { WorkspaceMutation } from "./workspace-socket.js";
import { z } from "zod";

type Named = { id: string; title: string };
type CommandItem = Named & { handoff?: number | boolean; status?: Status };

export function hasOpenHandoff(
  item: Pick<CommandItem, "handoff" | "status">,
): boolean {
  return (
    Boolean(item.handoff) &&
    item.status !== "done" &&
    item.status !== "cancelled"
  );
}

export interface CommandContext {
  selected?: CommandItem | null;
  items: readonly CommandItem[];
  /** Current instant in milliseconds, converted to a calendar date in timezone. */
  today: number;
  timezone: string;
  replyTo?: CommandItem | null;
  projects?: readonly { id: string; name: string }[];
  lenses?: readonly { id: string; label: string }[];
}

const workspaceCommands = [
  "edit guidance",
  "sign out",
  "what needs me",
  "what is blocked",
  "enable notifications",
  "disable notifications",
  "test notification",
  "export workspace",
  "reset workspace",
  "history",
  "hidden items",
  "hide completed ghosts",
  "show completed ghosts",
  "list projects",
  "list tokens",
  "connected apps",
  "shadow judge",
  "account",
  "model keys",
] as const;
type WorkspaceCommand = (typeof workspaceCommands)[number];

export type CommandIntent =
  | { type: "unknown" }
  | { type: "message"; text: string }
  | {
      type: "mutate";
      mutation: WorkspaceMutation;
      text: string;
      confirm?: true;
    }
  | { type: "zoom"; band: RadarBand | null }
  | { type: "lens"; id: string }
  | { type: "select" | "details"; id: string }
  | {
      type: "token-label";
      scope: Scope;
      project?: { id: string; title: string };
    }
  | { type: "workspace"; command: WorkspaceCommand }
  | {
      type: "time";
      id: string;
      title: string;
      kind: "fixed" | "deadline";
      date: string;
      time: string;
    }
  | { type: "reopen-history"; name: string; reason: string }
  | { type: "revoke"; kind: "token" | "app"; name: string };

const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const datePattern = `today|tomorrow|next week|${weekdays.join("|")}|\\d{4}-\\d{2}-\\d{2}`;
const dateSchema = z.iso.date();
const schedulePattern = new RegExp(
  `^(?:(?:move|reschedule|schedule) (?:(?!to |for )(.+?) )?(?:to |for )?)?(${datePattern})$`,
  "i",
);
const timePattern = new RegExp(
  `^(fixed|deadline) (${datePattern}) (\\d{2}:\\d{2})$`,
  "i",
);
const priorities = new Map([
  ["urgent", 10],
  ["high", 8],
  ["normal", 5],
  ["low", 2],
]);

function commandDate(
  text: string,
  dates: ReturnType<typeof workspaceCalendar>,
) {
  const name = text.toLowerCase();
  if (name === "today") return dates.today;
  if (name === "tomorrow") return dates.tomorrow;
  if (name === "next week") return dates.nextWeek;
  const weekday = weekdays.indexOf(name);
  if (weekday >= 0) {
    const current = new Date(dates.today + "T00:00:00Z").getUTCDay();
    return dates.dateAfter((weekday - current + 7) % 7);
  }
  return dateSchema.safeParse(text).data;
}

export function matchCommandName<T extends Named>(
  name: string,
  candidates: readonly T[],
) {
  const query = name
    .trim()
    .replace(/^"(.+)"$/, "$1")
    .toLowerCase();
  if (!query) return [];
  const exact = candidates.filter(({ title }) => title.toLowerCase() === query);
  if (exact.length) return exact;
  const partial = candidates.filter(({ title }) =>
    title.toLowerCase().includes(query),
  );
  if (
    partial.length ||
    !query.startsWith("the ") ||
    name.trim().startsWith('"')
  )
    return partial;
  return matchCommandName(query.slice(4), candidates);
}

function withName<T extends Named>(
  name: string,
  candidates: readonly T[],
  run: (item: T) => CommandIntent,
): CommandIntent {
  const matches = matchCommandName(name, candidates);
  if (matches.length === 1) return run(matches[0]);
  return {
    type: "message",
    text: matches.length
      ? `“${name}” matches ${matches.map(({ title }) => title).join(", ")}. Use a more specific name.`
      : `No match for “${name}”.`,
  };
}

function mutate(
  mutation: WorkspaceMutation,
  text: string,
  confirm = false,
): CommandIntent {
  return {
    type: "mutate",
    mutation,
    text,
    ...(confirm ? { confirm: true } : {}),
  };
}

function answer(item: CommandItem, text: string) {
  return mutate(
    { type: "ANSWER_HANDOFF", input: { item_id: item.id, text } },
    `Answered “${item.title}”.`,
  );
}

const builtInLenses = ["radar", "board", "treemap", "list", "dependencies"].map(
  (id) => ({ id, label: id }),
);

export const COMMAND_HELP =
  "I didn’t catch that. Try “add <title>”, “done <item>”, “move <item> to friday” or “zoom into today”.";

export function interpretCommand(
  raw: string,
  context: CommandContext,
): CommandIntent {
  const text = raw.trim();
  if (!text) return { type: "unknown" };
  const { replyTo, selected } = context;
  if (replyTo && hasOpenHandoff(replyTo)) return answer(replyTo, text);
  const selectedHandoff =
    !replyTo && selected && hasOpenHandoff(selected) ? selected : undefined;
  const reply = /^reply(?: with)? (.+)$/i.exec(text);
  if (reply && selectedHandoff) return answer(selectedHandoff, reply[1]);

  const command = text.replace(/\?$/, "").toLowerCase();
  const dates = () => workspaceCalendar(context.today, context.timezone);
  const item = (
    name: string | undefined,
    run: (target: CommandItem) => CommandIntent,
  ) =>
    name && !/^it$/i.test(name)
      ? withName(name, context.items, run)
      : context.selected
        ? run(context.selected)
        : {
            type: "message" as const,
            text: "Select an item or include its name.",
          };
  const patch = (
    name: string | undefined,
    input: Omit<
      Extract<WorkspaceMutation, { type: "UPDATE_ITEM" }>["input"],
      "item_id"
    >,
  ) =>
    item(name, ({ id, title }) =>
      mutate(
        { type: "UPDATE_ITEM", input: { item_id: id, ...input } },
        `Updated “${title}”.`,
      ),
    );
  const project = (
    name: string,
    run: (id: string, title: string) => CommandIntent,
  ) =>
    withName(
      name,
      (context.projects ?? []).map(({ id, name }) => ({ id, title: name })),
      ({ id, title }) => run(id, title),
    );

  const workspace = workspaceCommands.find(
    (candidate) => candidate === command,
  );
  if (workspace) return { type: "workspace", command: workspace };
  if (command === "export")
    return { type: "workspace", command: "export workspace" };
  if (/^(?:fit(?: radar| the field)?|zoom out|show everything)$/.test(command))
    return { type: "zoom", band: null };
  if (command === "show this week by day")
    return { type: "zoom", band: "this-week" };
  const zoom = /^zoom(?: in)?(?: into| to)? (.+)$/.exec(command);
  if (zoom) {
    const band = RadarBandSchema.safeParse(zoom[1].replace(/ /g, "-"));
    if (band.success) return { type: "zoom", band: band.data };
  }

  const lensName = command
    .replace(/^(?:switch(?: lens)? to|lens) /, "")
    .replace(/ lens$/, "");
  const lens = (context.lenses ?? builtInLenses).find(
    ({ id, label }) =>
      id.toLowerCase() === lensName || label.toLowerCase() === lensName,
  );
  if (lens) return { type: "lens", id: lens.id };

  let match: RegExpExecArray | null;
  const marked = /^mark (.+) done$/i.exec(text);
  if (marked)
    return item(marked[1], ({ id, title }) =>
      mutate(
        { type: "SET_STATUS", input: { item_id: id, status: "done" } },
        `Marked “${title}” done.`,
      ),
    );
  if (
    (match =
      /^new (?:(report|steer) )?token(?:\?|(?: in ("[^"]+"|[^"].*?))?(?: for (.+))?)$/i.exec(
        text,
      ))
  ) {
    const [, scopeName, projectName, label] = match;
    const scope = ScopeSchema.parse(scopeName?.toLowerCase() ?? "report");
    const create = (defaultProject?: {
      id: string;
      title: string;
    }): CommandIntent =>
      label
        ? mutate(
            {
              type: "CREATE_TOKEN",
              input: {
                label,
                scope,
                ...(defaultProject && {
                  default_project_id: defaultProject.id,
                }),
              },
            },
            "Token created.",
          )
        : { type: "token-label", scope, project: defaultProject };
    return projectName
      ? project(projectName, (id, title) => create({ id, title }))
      : create();
  }
  if ((match = /^add child (.+?)(?: under (.+))?$/i.exec(text))) {
    const [, title, parent] = match;
    return item(parent, ({ id }) =>
      mutate(
        { type: "ADD_ITEM", input: { title, parent_id: id } },
        `Added “${title}”.`,
      ),
    );
  }
  if ((match = /^add (.+)$/i.exec(text))) {
    const title = match[1];
    return mutate(
      {
        type: "ADD_ITEM",
        input: {
          title,
          project: INBOX_PROJECT_ID,
          scheduled_on: dates().today,
        },
      },
      `Added “${title}” to Inbox for today.`,
    );
  }
  if ((match = /^(?:select|find) (.+)$/i.exec(text)))
    return item(match[1], ({ id }) => ({ type: "select", id }));
  if ((match = /^item details(?: (.+))?$/i.exec(text)))
    return item(match[1], ({ id }) => ({ type: "details", id }));

  if (
    (match =
      /^(done|mark done|reopen|cancel|show|unhide|hide|delete|clear handoff|unschedule)(?: (?!project )(.+))?$/i.exec(
        text,
      ))
  ) {
    const [, verb, target] = match;
    const action = verb.toLowerCase();
    const [name, reason] =
      action === "reopen"
        ? (target ?? "").split(/(?:^| )because (.+)/i)
        : [target];
    if (
      action === "reopen" &&
      name &&
      !/^it$/i.test(name) &&
      !matchCommandName(name, context.items).length
    )
      return {
        type: "reopen-history",
        name,
        reason: reason || "Reopened by user.",
      };
    return item(name || undefined, ({ id, title }) => {
      const item_id = id;
      if (action === "reopen")
        return mutate(
          {
            type: "REOPEN_ITEM",
            input: { item_id, reason: reason || "Reopened by user." },
          },
          `Reopened “${title}”.`,
        );
      if (action === "done" || action === "mark done" || action === "cancel")
        return mutate(
          {
            type: "SET_STATUS",
            input: {
              item_id,
              status: action === "cancel" ? "cancelled" : "done",
            },
          },
          action === "cancel"
            ? `Cancelled “${title}”.`
            : `Marked “${title}” done.`,
        );
      if (action === "clear handoff")
        return mutate(
          { type: "CLEAR_HANDOFF", input: { item_id } },
          `Cleared the question on “${title}”.`,
        );
      if (action === "delete")
        return mutate(
          { type: "DELETE_ITEM", input: { item_id } },
          `Deleted “${title}” and any children.`,
          true,
        );
      const input =
        action === "unschedule"
          ? { scheduled_on: null }
          : { hidden: action === "hide" };
      return mutate(
        { type: "UPDATE_ITEM", input: { item_id, ...input } },
        `Updated “${title}”.`,
      );
    });
  }

  const schedule = schedulePattern.exec(text);
  if (schedule) {
    const date = commandDate(schedule[2], dates());
    return date
      ? patch(schedule[1], {
          scheduled_on: date,
        })
      : { type: "message", text: "Enter a valid calendar date." };
  }

  if (
    (match =
      /^(?:make (.+?) |(?:set )?priority (?:to )?)?(urgent|high|normal|low|10|[1-9])$/i.exec(
        text,
      )) &&
    (match[1] || !/^\d+$/.test(text))
  ) {
    const [, name, value] = match;
    return patch(name, {
      priority: priorities.get(value.toLowerCase()) ?? Number(value),
    });
  }

  if (
    (match =
      /^(rename(?! project )|note|ask|link|tags|criteria|unlock) (.+)$/i.exec(
        text,
      ))
  ) {
    const [, verb, value] = match;
    switch (verb.toLowerCase()) {
      case "rename":
        return patch(undefined, { title: value });
      case "link":
        return patch(undefined, {
          ref_url: value.toLowerCase() === "clear" ? null : value,
        });
      case "tags":
        return patch(undefined, {
          tags:
            value.toLowerCase() === "clear"
              ? []
              : value
                  .split(",")
                  .map((part) => part.trim())
                  .filter(Boolean),
        });
      case "criteria":
        return patch(undefined, {
          acceptance:
            value.toLowerCase() === "clear"
              ? []
              : value.split("|").map((part) => part.trim()),
        });
      case "unlock": {
        const field = LockableFieldSchema.safeParse(
          value.toLowerCase().replace(/ /g, "_"),
        );
        return field.success
          ? patch(undefined, { unlock: field.data })
          : {
              type: "message",
              text: "Unlock priority, scheduled_on, sort_key, layout_pos, or acceptance.",
            };
      }
      case "note":
        return item(undefined, ({ id, title }) =>
          mutate(
            {
              type: "SET_NOTE",
              input: {
                item_id: id,
                note: value.toLowerCase() === "clear" ? null : value,
              },
            },
            `Updated the note on “${title}”.`,
          ),
        );
      case "ask":
        return item(undefined, ({ id, title }) =>
          mutate(
            { type: "FLAG_HANDOFF", input: { item_id: id, note: value } },
            `Added a question to “${title}”.`,
          ),
        );
    }
  }

  if (command === "flexible")
    return patch(undefined, { time_type: "flexible", time_at: null });
  if ((match = timePattern.exec(text))) {
    const [, kind, day, time] = match;
    const date = commandDate(day, dates());
    return date
      ? item(undefined, ({ id, title }) => ({
          type: "time",
          id,
          title,
          kind: kind.toLowerCase() === "fixed" ? "fixed" : "deadline",
          date,
          time,
        }))
      : { type: "message", text: "Enter a valid calendar date." };
  }
  if ((match = /^(block|unblock) on (.+)$/i.exec(text))) {
    const [, action, name] = match;
    return item(undefined, ({ id, title }) =>
      withName(name, context.items, (blocker) =>
        mutate(
          {
            type: "SET_DEPENDENCY",
            input: {
              item_id: id,
              blocked_by_id: blocker.id,
              action: action.toLowerCase() === "block" ? "add" : "remove",
            },
          },
          `Updated dependencies for “${title}”.`,
        ),
      ),
    );
  }

  if ((match = /^(?:set )?timezone (.+)$/i.exec(text)))
    return mutate(
      { type: "SET_TIMEZONE", input: { timezone: match[1] } },
      `Workspace timezone set to ${match[1]}.`,
    );
  if ((match = /^new project (.+)$/i.exec(text)))
    return mutate(
      { type: "CREATE_PROJECT", input: { name: match[1] } },
      `Created project “${match[1]}”.`,
    );
  if ((match = /^(?:move (?:(.+?) )?to project|project) (.+)$/i.exec(text))) {
    const [, target, name] = match;
    return project(name, (id) => patch(target, { project: id }));
  }
  if ((match = /^(hide|show|delete) project (.+)$/i.exec(text))) {
    const [, action, name] = match;
    return project(name, (id, title) =>
      action.toLowerCase() === "delete"
        ? mutate(
            { type: "DELETE_PROJECT", input: { project_id: id } },
            `Deleted project “${title}”.`,
            true,
          )
        : mutate(
            {
              type: "UPDATE_PROJECT",
              project_id: id,
              input: { hidden: action.toLowerCase() === "hide" ? 1 : 0 },
            },
            `Updated project “${title}”.`,
          ),
    );
  }
  if ((match = /^rename project (.+?) to (.+)$/i.exec(text))) {
    const [, name, next] = match;
    return project(name, (id, title) =>
      mutate(
        { type: "UPDATE_PROJECT", project_id: id, input: { name: next } },
        `Renamed “${title}” to “${next}”.`,
      ),
    );
  }
  if ((match = /^colou?r project (.+?) (#[0-9a-f]{6}|clear)$/i.exec(text))) {
    const [, name, color] = match;
    return project(name, (id, title) =>
      mutate(
        {
          type: "UPDATE_PROJECT",
          project_id: id,
          input: { color: color.toLowerCase() === "clear" ? null : color },
        },
        `Updated project “${title}”.`,
      ),
    );
  }
  if ((match = /^move project (.+?) (up|down)$/i.exec(text))) {
    const [, name, direction] = match;
    return project(name, (id, title) =>
      mutate(
        {
          type: "MOVE_PROJECT",
          input: {
            project_id: id,
            direction: direction.toLowerCase() === "up" ? "up" : "down",
          },
        },
        `Moved project “${title}”.`,
      ),
    );
  }
  if ((match = /^revoke (token|app) (.+)$/i.exec(text)))
    return {
      type: "revoke",
      kind: match[1].toLowerCase() === "token" ? "token" : "app",
      name: match[2],
    };

  if (selectedHandoff) return answer(selectedHandoff, text);
  return { type: "unknown" };
}
