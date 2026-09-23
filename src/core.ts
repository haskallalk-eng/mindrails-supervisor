import { z } from 'zod';

const text = z.string().trim().min(1).max(8000);
export const completionSchema = z.object({
  task: text,
  currentResult: text,
  requirements: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: text, evidence: text.optional() }).strict()).min(1).max(20),
  evidence: text.optional(),
  trustedChecks: z.array(z.object({ id: z.string().min(1).max(64), status: z.enum(['pass', 'fail', 'unknown']) }).strict()).max(20).optional(),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.requirements.map(r => r.id)).size !== v.requirements.length) ctx.addIssue({code:'custom',message:'Duplicate requirement IDs'});
  if (Buffer.byteLength(JSON.stringify(v)) > 32000) ctx.addIssue({code:'custom',message:'Input exceeds 32000 bytes'});
});
export type CompletionInput = z.infer<typeof completionSchema>;
export interface Signals { requirements: Record<string, number>; taskSatisfied: number; evidenceSufficient: number; contradictions: number }
export interface DecisionProvider { readonly mode: 'mock' | 'jev'; evaluate(input: CompletionInput, signal: AbortSignal): Promise<Signals> }
export class SafeError extends Error { constructor(public code: string) { super(code); } }
export type Decision = { decision: 'finish' | 'continue' | 'review'; reasons: string[]; requirementIds: string[]; provider: string; model: string; policyVersion: string; synthetic: boolean; modelSignals?: Signals };

export class Supervisor {
  private calls = 0;
  private bytes = 0;
  constructor(private provider: DecisionProvider, private limits = { maxCalls: 100, maxInputBytes: 320000, timeoutMs: 5000, threshold: 0.9 }) {
    for (const [k,v] of Object.entries(limits)) if (!Number.isFinite(v) || v <= 0) throw new SafeError('INVALID_LIMIT');
    if (limits.threshold > 1 || !Number.isInteger(limits.maxCalls)) throw new SafeError('INVALID_LIMIT');
  }
  async check(raw: unknown): Promise<Decision> {
    const input = completionSchema.parse(raw);
    const base = { provider: this.provider.mode, model:this.provider.mode === 'jev' ? 'jev-1.13.0' : 'synthetic-markers-v1', policyVersion:'0.1.0', synthetic:this.provider.mode === 'mock', requirementIds: [] as string[] };
    if (input.trustedChecks?.some(c => c.status !== 'pass')) return { ...base, decision:'review', reasons:['HOST_CHECK_NOT_PASSED'] };
    if (!input.evidence && !input.requirements.every(r => r.evidence)) return { ...base, decision:'continue', reasons:['SUPPLIED_EVIDENCE_MISSING'] };
    const size = Buffer.byteLength(JSON.stringify(input));
    if (this.calls >= this.limits.maxCalls || this.bytes + size > this.limits.maxInputBytes) return { ...base, decision:'review', reasons:['BUDGET_EXHAUSTED'] };
    this.calls++; this.bytes += size;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const s = await Promise.race([this.provider.evaluate(input, controller.signal), new Promise<never>((_,reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SafeError('PROVIDER_TIMEOUT')); }, this.limits.timeoutMs);
      })]);
      const number = z.number().finite().min(0).max(1);
      z.object({ requirements:z.record(z.string(),number), taskSatisfied:number, evidenceSufficient:number, contradictions:number }).strict().parse(s);
      if (Object.keys(s.requirements).length !== input.requirements.length || input.requirements.some(r => !Object.hasOwn(s.requirements,r.id))) throw new SafeError('INVALID_PROVIDER_RESPONSE');
      const missing = input.requirements.filter(r => s.requirements[r.id]! < this.limits.threshold).map(r => r.id);
      const reasons: string[] = [];
      if (s.contradictions > 0.1) reasons.push('CONTRADICTION_SIGNAL');
      if (s.evidenceSufficient < this.limits.threshold) reasons.push('EVIDENCE_INSUFFICIENT');
      if (missing.length) reasons.push('REQUIREMENTS_INCOMPLETE');
      if (s.taskSatisfied < this.limits.threshold) reasons.push('TASK_INCOMPLETE');
      return { ...base, decision: reasons.length ? 'continue' : 'finish', reasons:reasons.length ? reasons : ['POLICY_PASSED'], requirementIds:missing, modelSignals:s };
    } catch (e) {
      return { ...base, decision:'review', reasons:[e instanceof SafeError ? e.code : 'PROVIDER_FAILURE'] };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}

export const stuckSchema = z.object({ steps:z.array(z.object({ action:z.string().min(1).max(1000), input:z.string().max(2000), result:z.string().max(2000), progress:z.boolean() }).strict()).max(50) }).strict();
export function detectStuck(raw: unknown) {
  const { steps } = stuckSchema.parse(raw);
  const last = steps.slice(-3);
  const repeated = last.length === 3 && last.every(s => !s.progress && s.action === last[0]!.action && s.input === last[0]!.input && s.result === last[0]!.result);
  return { decision:repeated ? 'review' : 'continue', stuck:repeated, repetitionCount:repeated ? 3 : 0, matchedIndices:repeated ? [steps.length-3,steps.length-2,steps.length-1] : [], reason:repeated ? 'THREE_IDENTICAL_STEPS_WITHOUT_REPORTED_PROGRESS' : 'NO_REPEAT_PATTERN', source:'caller_supplied_trace' };
}
