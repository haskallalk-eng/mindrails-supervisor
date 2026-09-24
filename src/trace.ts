import { z } from 'zod';

const shortText = z.string().trim().min(1).max(6000);
export const traceTriageSchema = z.object({
  task: shortText,
  instructions: shortText,
  turns: z.array(z.object({ role: z.enum(['user','assistant','system']), content: z.string().max(6000) }).strict()).max(120),
  toolCalls: z.array(z.object({ name: z.string().min(1).max(128), arguments: z.string().max(4000), result: z.string().max(6000) }).strict()).max(50),
  finalMessage: z.string().max(6000),
  feedback: z.string().max(3000).optional(),
  actions: z.array(z.object({ name: z.string().min(1).max(128), permitted: z.boolean(), performed: z.boolean() }).strict()).max(20).optional(),
  telemetry: z.object({
    currentModel: z.string().trim().min(1).max(100).optional(),
    toolCount: z.number().int().nonnegative().max(500).optional(),
    repeatedActions: z.number().int().nonnegative().max(500).optional(),
    latestUsage: z.object({ inputTokens:z.number().int().nonnegative(), cachedInputTokens:z.number().int().nonnegative(), outputTokens:z.number().int().nonnegative(), reasoningOutputTokens:z.number().int().nonnegative(), totalTokens:z.number().int().nonnegative(), contextWindow:z.number().int().positive().nullable() }).strict().optional(),
    rateLimits: z.object({ primaryUsedPercent:z.number().finite().min(0).max(100).nullable(), secondaryUsedPercent:z.number().finite().min(0).max(100).nullable() }).strict().optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 48000) ctx.addIssue({ code:'custom', message:'Input exceeds 48000 bytes' });
});
export type TraceTriageInput = z.infer<typeof traceTriageSchema>;

export const traceQuestions = {
  task_outcome: {
    complete: 'The trace fulfills the user task with concrete evidence.',
    incomplete: 'The trace clearly leaves requested work unfinished or failed.',
    uncertain: 'The trace does not provide enough evidence to decide completion.',
  },
  user_outcome: {
    satisfied: 'The user explicitly confirms success or accepts the result.',
    dissatisfied: 'The user explicitly rejects the result or reports a problem.',
    no_feedback: 'There is no explicit user feedback about the outcome.',
  },
  run_health: {
    healthy: 'No material failure or mismatch is visible in the trace.',
    expectation_gap: 'The result may be usable, but materially misses the request or expected quality.',
    overt_failure: 'The trace shows a clear error, broken result, or failed operation.',
    silent_failure: 'The assistant claims success but the trace lacks evidence or contradicts that claim.',
  },
} as const;
export type TraceQuestionId = keyof typeof traceQuestions;
export type TraceLabel = { choice: string; confidence: number; probabilities: Record<string,number> };
export type TraceLabels = Record<TraceQuestionId,TraceLabel> & { model_fit?:TraceLabel; usage?: { inputTokens:number; outputTokens:number } };

export const modelFitChoices = {
  keep_current: 'The current model handled this task at an appropriate quality level. Keep it for comparable work.',
  try_more_capable: 'The trace shows a capability gap in reasoning or execution that a more capable model could plausibly address. Recommend testing one for this kind of work; do not select one by name.',
  try_faster: 'The task was low-risk and completed cleanly with substantial unused capability. A faster, lighter model could be tested on comparable tasks; do not claim a measured cost saving.',
  uncertain: 'The trace does not provide enough evidence to recommend a model change, or the obstacle is not model capability.',
} as const;
