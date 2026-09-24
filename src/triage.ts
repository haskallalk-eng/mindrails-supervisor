import { SafeError } from './core.js';
import { type TraceLabels, type TraceQuestionId, type TraceTriageInput, traceQuestions, traceTriageSchema } from './trace.js';
import { JevProvider, MockProvider } from './providers.js';

export interface TraceTriageProvider {
  readonly mode: 'mock' | 'jev';
  readonly model?: string;
  evaluateTrace(input: TraceTriageInput, signal: AbortSignal): Promise<TraceLabels>;
}
export type TraceTriageResult = {
  recommendation: 'AUTO_CLOSE' | 'HUMAN_REVIEW' | 'PRIORITY_REVIEW' | 'FILE_ISSUE' | 'ROUTE_PAGE_ON_CALL';
  reasons: string[];
  provider: 'jev' | 'mock';
  model: string;
  policyVersion: 'agent-trace-triage-v1';
  synthetic: boolean;
  labels?: TraceLabels;
  providerUsage?: { inputTokens:number; outputTokens:number };
};

function pickRecommendation(input: TraceTriageInput, labels: TraceLabels): { recommendation:TraceTriageResult['recommendation']; reasons:string[] } {
  if (input.actions?.some(action => action.performed && !action.permitted)) return { recommendation:'ROUTE_PAGE_ON_CALL', reasons:['CALLER_REPORTED_UNPERMITTED_ACTION'] };
  const weakest = (Object.keys(traceQuestions) as TraceQuestionId[]).some(id => labels[id].confidence < 0.75 || labels[id].probabilities[labels[id].choice]! < 0.8);
  if (weakest || labels.task_outcome.choice === 'uncertain') return { recommendation:'HUMAN_REVIEW', reasons:['LOW_CONFIDENCE_OR_UNCERTAIN'] };
  if (labels.run_health.choice === 'silent_failure') return { recommendation:'PRIORITY_REVIEW', reasons:['SUCCESS_CLAIM_WITHOUT_SUPPORT'] };
  if (labels.run_health.choice === 'overt_failure') return { recommendation:'FILE_ISSUE', reasons:['CLEAR_RUN_FAILURE'] };
  if (labels.run_health.choice === 'expectation_gap') return { recommendation:'HUMAN_REVIEW', reasons:['MATERIAL_EXPECTATION_GAP'] };
  if (labels.user_outcome.choice === 'dissatisfied') return { recommendation:'HUMAN_REVIEW', reasons:['USER_REPORTED_DISSATISFACTION'] };
  if (labels.task_outcome.choice === 'incomplete') return { recommendation:'HUMAN_REVIEW', reasons:['TASK_INCOMPLETE'] };
  return { recommendation:'AUTO_CLOSE', reasons:[labels.user_outcome.choice === 'no_feedback' ? 'TRACE_COMPLETE_NO_USER_FEEDBACK' : 'TRACE_COMPLETE_AND_USER_SATISFIED'] };
}

export class TraceTriage {
  private calls = 0;
  constructor(private provider: TraceTriageProvider, private limits = { maxCalls:25, timeoutMs:8000 }) {
    if (!Number.isSafeInteger(limits.maxCalls) || limits.maxCalls < 1 || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1) throw new SafeError('INVALID_LIMIT');
  }
  async evaluate(raw: unknown): Promise<TraceTriageResult> {
    const input = traceTriageSchema.parse(raw);
    const base = { provider:this.provider.mode, model:this.provider.model ?? (this.provider.mode === 'jev' ? 'typesafe-ai/jev' : 'synthetic-trace-fixture-v1'), policyVersion:'agent-trace-triage-v1' as const, synthetic:this.provider.mode === 'mock' };
    if (input.actions?.some(action => action.performed && !action.permitted)) return { ...base,recommendation:'ROUTE_PAGE_ON_CALL',reasons:['CALLER_REPORTED_UNPERMITTED_ACTION'] };
    if (this.calls >= this.limits.maxCalls) return { ...base,recommendation:'HUMAN_REVIEW',reasons:['BUDGET_EXHAUSTED'] };
    this.calls++;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const labels = await Promise.race([this.provider.evaluateTrace(input,controller.signal),new Promise<never>((_,reject) => { timer=setTimeout(()=>{controller.abort();reject(new SafeError('PROVIDER_TIMEOUT'));},this.limits.timeoutMs); })]);
      const keys = Object.keys(traceQuestions) as TraceQuestionId[];
      for (const id of keys) {
        const label = labels[id], options = Object.keys(traceQuestions[id]);
        if (!label || !options.includes(label.choice) || !Number.isFinite(label.confidence) || label.confidence < 0 || label.confidence > 1 || Object.keys(label.probabilities).length !== options.length || options.some(option => !Number.isFinite(label.probabilities[option]) || label.probabilities[option]! < 0 || label.probabilities[option]! > 1) || Math.abs(options.reduce((sum,option)=>sum+label.probabilities[option]!,0)-1) > 0.03 || Math.abs(label.probabilities[label.choice]!-Math.max(...options.map(option=>label.probabilities[option]!))) > 0.0001) throw new SafeError('INVALID_PROVIDER_RESPONSE');
      }
      const {usage,...cleanLabels}=labels;
      const selected = pickRecommendation(input,cleanLabels);
      return { ...base,...selected,labels:cleanLabels,...(usage ? {providerUsage:usage} : {}) };
    } catch (error) {
      return { ...base,recommendation:'HUMAN_REVIEW',reasons:[error instanceof SafeError ? error.code : 'PROVIDER_FAILURE'] };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}

export function createTraceTriage(provider: 'mock'|'jev', key?: string, route: 'typesafe'|'vercel-ai-gateway' = 'typesafe') {
  const selected = provider === 'jev' ? new JevProvider(key ?? '',fetch,route) : new MockProvider();
  return new TraceTriage(selected);
}
