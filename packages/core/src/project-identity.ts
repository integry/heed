import { z } from "zod";

/** Project colours. Amber and teal are kept for status, so they are not here. */
export const PROJECT_COLORS = [
  "violet",
  "sky",
  "rose",
  "lime",
  "indigo",
  "clay",
] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];
export const ProjectColorSchema = z.enum(PROJECT_COLORS);

/** Bubble shapes for types of work, chosen by item tag. Circle is the default. */
export const ITEM_SHAPES = ["circle", "square", "diamond", "hexagon"] as const;
export type ItemShape = (typeof ITEM_SHAPES)[number];
export const ItemShapeSchema = z.enum(ITEM_SHAPES);
export const TagShapesSchema = z.record(z.string(), ItemShapeSchema);
export type TagShapes = z.infer<typeof TagShapesSchema>;
export const MAX_TAG_SHAPES = 20;

/** A project's badge: one to four letters or digits, shown in upper case. */
export const ProjectCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,4}$/, "Use one to four letters or digits")
  .transform((code) => code.toUpperCase());

type ProjectLike = { id: string; name: string; color: string | null };
type CodedProject = ProjectLike & { code?: string | null };

function hash(value: string) {
  let result = 2166136261;
  for (const char of value)
    result = Math.imul(result ^ char.codePointAt(0)!, 16777619);
  return result >>> 0;
}

/** Two letters from the name: initials of its first two words, else its first two letters. */
export function defaultProjectCode(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const code =
    words.length >= 2
      ? words[0][0] + words[1][0]
      : (words[0] ?? name).slice(0, 2);
  return code.toUpperCase();
}

export function isProjectColor(value: unknown): value is ProjectColor {
  return PROJECT_COLORS.includes(value as ProjectColor);
}

/** The project's colour; projects without a valid one get a stable colour from their ID. */
export function projectColor(project: ProjectLike): ProjectColor {
  return isProjectColor(project.color)
    ? project.color
    : PROJECT_COLORS[hash(project.id) % PROJECT_COLORS.length];
}

export function projectCode(project: CodedProject): string {
  return project.code || defaultProjectCode(project.name);
}

/** The least-used colour, in palette order, for a new project. */
export function nextProjectColor(used: readonly (string | null)[]) {
  const counts = new Map<ProjectColor, number>(
    PROJECT_COLORS.map((color) => [color, 0]),
  );
  for (const color of used)
    if (isProjectColor(color)) counts.set(color, counts.get(color)! + 1);
  return PROJECT_COLORS.reduce((best, color) =>
    counts.get(color)! < counts.get(best)! ? color : best,
  );
}

/** The shape for an item's tags: the first tag with a shape, else a circle. */
export function itemShape(
  tags: readonly string[],
  shapes: TagShapes | undefined,
): ItemShape {
  if (!shapes) return "circle";
  for (const tag of tags) {
    const shape = shapes[tag.trim().toLowerCase()];
    if (shape) return shape;
  }
  return "circle";
}

/** Reads an item's stored tags, which are a JSON array in a text column. */
export function readTags(tags: string): string[] {
  try {
    const value: unknown = JSON.parse(tags);
    return Array.isArray(value)
      ? value.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

/** A project's colour and badge, or null for Inbox, which has neither. */
export function projectIdentity(
  project: CodedProject,
): { color: ProjectColor; code: string } | null {
  return project.id === "inbox"
    ? null
    : { color: projectColor(project), code: projectCode(project) };
}
