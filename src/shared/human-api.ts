import { z } from "zod";
import { FlagHandoffSchema, ReopenItemSchema } from "./item-operations";
import { GuidanceTextSchema, TimezoneSchema } from "./workspace";
import type { Item } from "./workspace";

export const HandoffBodySchema = z.union([
  FlagHandoffSchema.pick({ note: true }),
  z.strictObject({ clear: z.literal(true) }),
]);

export const ReopenBodySchema = z.strictObject({
  reason: ReopenItemSchema.shape.reason,
});

export const TimezoneBodySchema = z.strictObject({ timezone: TimezoneSchema });
export const GuidanceBodySchema = z.strictObject({ text: GuidanceTextSchema });

const instant = z.iso.datetime({ offset: true });
const historyCursor = z.string().refine((value) => {
  const separator = value.indexOf("|");
  const at = separator < 0 ? value : value.slice(0, separator);
  const id = separator < 0 ? null : value.slice(separator + 1);
  return instant.safeParse(at).success && id !== "";
}, "Invalid history cursor");

export const HistoryQuerySchema = z.strictObject({
  q: z.string().optional(),
  project: z.string().min(1).optional(),
  before: historyCursor.optional(),
  limit: z
    .union([z.string().regex(/^\d+$/).transform(Number), z.number()])
    .pipe(z.int().min(1).max(100))
    .default(50),
});

export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;
export type HistoryItem = Item & { history_at: string };
export interface HistoryPage {
  items: HistoryItem[];
  next_before: string | null;
}
