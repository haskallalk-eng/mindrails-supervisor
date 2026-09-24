import { SafeError } from './core.js';
import { type TraceLabels, type TraceQuestionId, type TraceTriageInput, traceQuestions, traceTriageSchema, modelFitChoices } from './trace.js';
import { JevProvider, MockProvider } from './providers.js';
import { recoveryAdvice, type RecoveryAdvice } from './recovery.js';

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
  recoveryAdvice?: RecoveryAdvice;
  modelRecommendation?: { currentModel:string; action:'keep_current'|'try_more_capable'|'try_faster'|'uncertain'; confidence:number; basis:string[] };
};

function modelRecommendation(input:TraceTriageInput, labels:TraceLabels):TraceTriageResult['modelRecommendation'] {
  const currentModel=input.telemetry?.currentModel;
  if(!currentModel) return undefined;
  const label=labels.model_fit;
  if(!label || !Object.hasOwn(modelFitChoices,label.choice) || !Number.isFinite(label.confidence) || label.confidence<0 || label.confidence>1 || Object.keys(label.probabilities).length!==Object.keys(modelFitChoices).length || Object.keys(modelFitChoices).some(key=>!Number.isFinite(label.probabilities[key]) || label.probabilities[key]!<0 || label.probabilities[key]!>1) || Math.abs(Object.values(label.probabilities).reduce((a,b)=>a+b,0)-1)>0.03 || Math.abs(label.probabilities[label.choice]!-Math.max(...Object.values(label.probabilities)))>0.0001) throw new SafeError('INVALID_PROVIDER_RESPONSE');
  const confidence=label.confidence;
  const action=confidence<0.65 || label.probabilities[label.choice]!<0.75 ? 'uncertain' : label.choice as 'keep_current'|'try_more_capable'|'try_faster'|'uncertain';
  const basis=[`Jev hat ${input.turns.length} sichtbare Chatbeiträge und ${input.toolCalls.length} Werkzeugaufrufe erhalten.`];
  const usage=input.telemetry?.latestUsage;
  if(usage?.contextWindow && usage.totalTokens) basis.push(`Letzte Anfrage: ${usage.totalTokens.toLocaleString('de-DE')} von ${usage.contextWindow.toLocaleString('de-DE')} Kontext-Tokens (${Math.round(usage.totalTokens/usage.contextWindow*100)}%).`);
  if(input.telemetry?.rateLimits?.primaryUsedPercent!=null) basis.push(`Codex-Hauptlimit: ${Math.round(input.telemetry.rateLimits.primaryUsedPercent)}% verbraucht.`);
  const signatures=input.toolCalls.map(call=>`${call.name}\0${call.arguments}\0${call.result}`);
  const repeated=signatures.length-new Set(signatures).size;
  if(repeated) basis.push(`${repeated} exakt wiederholte Werkzeugaufrufe mit gleichem Ergebnis.`);
  const actionText={keep_current:'Jev hält das aktuelle Modell für vergleichbare Aufgaben für passend.',try_more_capable:'Jev sieht Hinweise auf eine mögliche Fähigkeitsgrenze und empfiehlt, bei ähnlichen Aufgaben ein stärkeres Modell zu testen.',try_faster:'Jev hält einen vorsichtigen Test mit einem schnelleren Modell bei ähnlich risikoarmen Aufgaben für sinnvoll; Einsparungen wurden nicht gemessen.',uncertain:'Jev hat nicht genug Belege für einen Modellwechsel.'}[action];
  basis.unshift(actionText);
  return {currentModel,action,confidence,basis};
}

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
      const recovery=labels.recovery ? recoveryAdvice(labels.recovery,labels) : undefined;
      const modelFit=modelRecommendation(input,labels);
      if (modelFit && recovery && modelFit.action !== 'uncertain' && modelFit.action !== 'keep_current') {
        const prerequisite = recovery.status === 'supported' && ['fix_environment','ask_question','verify_result','realign'].includes(recovery.action);
        const contradiction = recovery.status === 'uncertain' || (modelFit.action === 'try_faster' && recovery.action !== 'none');
        if (prerequisite || contradiction) {
          modelFit.action = 'uncertain';
          modelFit.basis = ['Kein Modellwechsel empfohlen: Zuerst die erkannte Voraussetzung klären oder die widersprüchlichen Einschätzungen prüfen.'];
        }
      }
      const {usage,...cleanLabels}=labels;
      const selected = pickRecommendation(input,cleanLabels);
      if (selected.recommendation === 'AUTO_CLOSE' && recovery && (recovery.status === 'supported' && recovery.action !== 'none' || recovery.reason === 'CONFLICTING_JUDGMENTS')) {
        selected.recommendation = 'HUMAN_REVIEW';
        selected.reasons = [recovery.reason === 'CONFLICTING_JUDGMENTS' ? 'RECOVERY_CONFLICT' : 'RECOVERY_NEEDED'];
      }
      return { ...base,...selected,labels:cleanLabels,...(usage ? {providerUsage:usage} : {}),...(modelFit ? {modelRecommendation:modelFit} : {}),...(recovery ? {recoveryAdvice:recovery} : {}) };
    } catch (error) {
      return { ...base,recommendation:'HUMAN_REVIEW',reasons:[error instanceof SafeError ? error.code : 'PROVIDER_FAILURE'] };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}

export function createTraceTriage(provider: 'mock'|'jev', key?: string, route: 'typesafe'|'vercel-ai-gateway' = 'typesafe') {
  const selected = provider === 'jev' ? new JevProvider(key ?? '',fetch,route) : new MockProvider();
  return new TraceTriage(selected);
}
