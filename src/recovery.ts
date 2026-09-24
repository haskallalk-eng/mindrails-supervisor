import { SafeError } from './core.js';
import type { TraceLabel, TraceLabels } from './trace.js';

// Independent, bounded judgments share the same state in one Jev request.
export const recoveryQuestions = {
  progress: {
    advancing: 'The latest work adds useful evidence or advances the current user goal. Repeated tool names alone are not a loop.',
    stalled: 'The latest work repeats failed attempts or cannot advance the current user goal.',
    complete: 'The current user goal has been delivered and required checks are evidenced.',
    uncertain: 'The supplied trace does not establish current progress.',
  },
  blocker: {
    none: 'No material unresolved obstacle is visible.',
    missing_information: 'A specific user decision or unavailable requirement is necessary to proceed; the agent cannot obtain it with available tools.',
    environment: 'Access, credentials, unavailable tools, dependencies or an external service block progress. A larger language model cannot fix this prerequisite.',
    ineffective_approach: 'Attempts fail because the current solution approach is ineffective, without a missing external prerequisite.',
    verification_gap: 'Success is claimed but the requested verification or supporting result is absent or contradicts the claim.',
    requirement_mismatch: 'The current deliverable materially misses the latest applicable user requirement.',
    uncertain: 'The evidence does not identify one dominant unresolved obstacle.',
  },
  next_step: {
    continue: 'Continue the productive approach, or leave an already completed task alone.',
    ask_question: 'Ask the user for the one missing decision or requirement needed to proceed.',
    fix_environment: 'Diagnose and resolve the missing access, dependency or service prerequisite before retrying.',
    change_approach: 'Stop repeating the failed approach and test a different hypothesis with a small discriminating check.',
    verify_result: 'Check the claimed result against the requested acceptance criteria before declaring success.',
    realign: 'Compare the deliverable with the latest user requirement and address the missed requirement.',
    review: 'There is not enough evidence for one useful intervention.',
  },
} as const;
export type RecoveryQuestionId = keyof typeof recoveryQuestions;
export type RecoveryLabels = Record<RecoveryQuestionId, TraceLabel>;
export type RecoveryAdvice = {
  policyVersion: 'recovery-v1';
  action: 'none' | 'review' | 'ask_question' | 'fix_environment' | 'change_approach' | 'verify_result' | 'realign';
  status: 'supported' | 'uncertain';
  reason: 'AGREEMENT' | 'LOW_CONFIDENCE' | 'CONFLICTING_JUDGMENTS';
  title: string;
  suggestedPrompt?: string;
  signals: RecoveryLabels;
};

const remedies = {
  ask_question: ['Eine entscheidende Angabe fehlt.', 'Benenne die eine fehlende Entscheidung, ohne die du nicht weiterkommst. Prüfe zuerst, ob sie bereits im Verlauf steht oder mit verfügbaren Werkzeugen ermittelt werden kann. Falls nicht, stelle eine konkrete Frage.'],
  fix_environment: ['Zuerst die Arbeitsumgebung prüfen.', 'Prüfe den zuletzt gemeldeten Zugriffs-, Werkzeug- oder Umgebungsfehler. Benenne die fehlende Voraussetzung und den kleinsten passenden Prüfschritt. Wiederhole die fehlgeschlagene Aktion erst, wenn sich die Voraussetzung geändert hat. Gib keine Zugangsdaten im Chat aus.'],
  change_approach: ['Der bisherige Lösungsweg scheint festzustecken.', 'Fasse den bisherigen Ansatz und die Gegenbelege kurz zusammen. Wähle eine andere überprüfbare Hypothese und teste sie mit dem kleinsten aussagekräftigen Schritt. Wiederhole den bisherigen Ansatz nur mit neuer Evidenz.'],
  verify_result: ['Für den behaupteten Erfolg fehlt ein Nachweis.', 'Prüfe das behauptete Ergebnis anhand der vereinbarten Abnahmekriterien. Führe den passenden verfügbaren Test aus oder benenne genau, welcher Nachweis fehlt. Melde Erfolg erst, wenn die Belege ihn tragen.'],
  realign: ['Das Ergebnis weicht möglicherweise vom Auftrag ab.', 'Vergleiche das aktuelle Ergebnis mit dem neuesten gültigen Nutzerauftrag. Benenne die konkrete Abweichung und korrigiere sie innerhalb des beauftragten Umfangs.'],
} as const;

export function validateRecoveryLabels(value: RecoveryLabels): void {
  if (!value || Object.keys(value).length !== 3) throw new SafeError('INVALID_PROVIDER_RESPONSE');
  for (const id of Object.keys(recoveryQuestions) as RecoveryQuestionId[]) {
    const label = value[id], options = Object.keys(recoveryQuestions[id]);
    if (!label || !options.includes(label.choice) || !Number.isFinite(label.confidence) || label.confidence < 0 || label.confidence > 1 || !label.probabilities || Object.keys(label.probabilities).length !== options.length || options.some(option => !Number.isFinite(label.probabilities[option]) || label.probabilities[option]! < 0 || label.probabilities[option]! > 1) || Math.abs(options.reduce((sum, option) => sum + label.probabilities[option]!, 0) - 1) > .03 || Math.abs(label.probabilities[label.choice]! - Math.max(...Object.values(label.probabilities))) > .0001) throw new SafeError('INVALID_PROVIDER_RESPONSE');
  }
}

export function recoveryAdvice(signals: RecoveryLabels, labels: TraceLabels): RecoveryAdvice {
  validateRecoveryLabels(signals);
  const base = { policyVersion: 'recovery-v1' as const, signals };
  const abstain = (reason: 'LOW_CONFIDENCE' | 'CONFLICTING_JUDGMENTS'): RecoveryAdvice => ({ ...base, action: 'review', status: 'uncertain', reason, title: reason === 'LOW_CONFIDENCE' ? 'Jev hat keine ausreichend klare Grundlage für einen Eingriff.' : 'Jevs Einschätzungen widersprechen sich; daraus folgt keine konkrete Handlungsanweisung.' });
  // These are initial product thresholds, not measured accuracy guarantees.
  if (Object.values(signals).some(label => label.confidence < .75 || label.probabilities[label.choice]! < .8) || signals.progress.choice === 'uncertain' || signals.blocker.choice === 'uncertain' || signals.next_step.choice === 'review') return abstain('LOW_CONFIDENCE');
  const mapping: Record<string, string> = { none: 'continue', missing_information: 'ask_question', environment: 'fix_environment', ineffective_approach: 'change_approach', verification_gap: 'verify_result', requirement_mismatch: 'realign' };
  if (mapping[signals.blocker.choice] !== signals.next_step.choice || (signals.progress.choice === 'complete' && signals.blocker.choice !== 'none') || (signals.progress.choice === 'stalled' && signals.blocker.choice === 'none')) return abstain('CONFLICTING_JUDGMENTS');
  if (signals.next_step.choice === 'continue') {
    if (labels.run_health.choice !== 'healthy' || labels.user_outcome.choice === 'dissatisfied' || (signals.progress.choice === 'complete' && labels.task_outcome.choice !== 'complete')) return abstain('CONFLICTING_JUDGMENTS');
    return { ...base, action: 'none', status: 'supported', reason: 'AGREEMENT', title: 'Kein Eingriff empfohlen.' };
  }
  const action = signals.next_step.choice as keyof typeof remedies;
  const [title, suggestedPrompt] = remedies[action];
  return { ...base, action, status: 'supported', reason: 'AGREEMENT', title, suggestedPrompt };
}
