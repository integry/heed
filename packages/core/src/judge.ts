import { z } from "zod";

const model = z.string().trim().min(1).max(256);
export const JudgeProbabilitySchema = z.number().min(0).max(1);

export const JudgeConfigurationSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  apiKey: z.string().trim().min(1),
  model,
});

export const JudgedDetailSchema = z
  .strictObject({
    status_event_id: z.int().positive(),
    model,
    criteria: z.array(z.string().min(1)).min(1).max(8),
    probabilities: z.array(JudgeProbabilitySchema.nullable()).min(1).max(8),
    evidence_supplied: z.boolean(),
  })
  .refine(
    ({ criteria, probabilities }) => criteria.length === probabilities.length,
  );

export const JudgeFeedbackDetailSchema = z.strictObject({
  judged_event_id: z.int().positive(),
  agrees: z.boolean(),
});

export const JudgeUsageSchema = z.object({
  type: z.literal("judge"),
  model,
  inputTokens: z.int().nonnegative().nullable(),
});

export const JudgeLimitActionSchema = z.literal("judge");

export type JudgeConfiguration = z.infer<typeof JudgeConfigurationSchema>;
export type JudgedDetail = z.infer<typeof JudgedDetailSchema>;
export type JudgeFeedbackDetail = z.infer<typeof JudgeFeedbackDetailSchema>;
export type JudgeUsage = z.infer<typeof JudgeUsageSchema>;
export type JudgeLimitAction = z.infer<typeof JudgeLimitActionSchema>;

export type JudgeAgreement = {
  verdicts: number;
  reviewed: number;
  agreed: number;
};

export function classifyJudgeProbability(probability: number | null) {
  if (probability === null) return "Unclear";
  if (probability >= 0.7) return "Likely met";
  if (probability <= 0.3) return "Likely not met";
  return "Unclear";
}
