import { z } from 'zod';

const shortText = z.string().trim().min(1).max(4000);
export const traceTriageSchema = z.object({
  task: shortText,
  instructions: shortText,
  turns: z.array(z.object({ role: z.enum(['user','assistant','system']), content: z.string().max(4000) }).strict()).max(30),
  toolCalls: z.array(z.object({ name: z.string().min(1).max(128), arguments: z.string().max(2000), result: z.string().max(3000) }).strict()).max(20),
  finalMessage: z.string().max(4000),
  feedback: z.string().max(2000).optional(),
  actions: z.array(z.object({ name: z.string().min(1).max(128), permitted: z.boolean(), performed: z.boolean() }).strict()).max(20).optional(),
}).strict().superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 24000) ctx.addIssue({ code:'custom', message:'Input exceeds 24000 bytes' });
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
export type TraceLabels = Record<TraceQuestionId,TraceLabel> & { usage?: { inputTokens:number; outputTokens:number } };
