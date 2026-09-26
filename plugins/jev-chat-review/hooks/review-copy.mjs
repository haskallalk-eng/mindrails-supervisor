const reasonCopy = {
  BASELINE_UNCERTAIN_RECOVERY: 'Die Aufgabe ist noch offen, aber Jev hat keinen klaren Eingriffsvorschlag. Der normale Ablauf bleibt bestehen.',
  RECOVERY_CONFLICT: 'Die Einschätzungen widersprechen sich. Jev greift nicht ein; Erfolg wird nicht bestätigt.',
  RECOVERY_NEEDED: 'Die Ursachenprüfung sieht noch einen offenen Punkt. Prüfe den vorgeschlagenen nächsten Schritt.',
  TRACE_COMPLETE_NO_USER_FEEDBACK: 'Der Lauf wirkt vollständig, aber es gibt noch keine Nutzerbestätigung.',
  TRACE_COMPLETE_AND_USER_SATISFIED: 'Der Lauf wirkt vollständig und der Nutzer hat das Ergebnis bestätigt.',
  LOW_CONFIDENCE_OR_UNCERTAIN: 'Die Belege sind nicht eindeutig. Jev lässt den normalen Ablauf unverändert und bestätigt keinen Erfolg.',
  BUDGET_EXHAUSTED: 'Das Jev-Prüflimit ist erreicht. Der normale Ablauf bleibt unverändert.',
  SUCCESS_CLAIM_WITHOUT_SUPPORT: 'Erfolg wird behauptet, aber im Verlauf nicht belegt. Prüfe Ergebnis oder Tests.',
  CLEAR_RUN_FAILURE: 'Ein konkreter Fehler ist sichtbar. Nutze den Fehlerbericht als nächsten Ansatzpunkt.',
  MATERIAL_EXPECTATION_GAP: 'Das Ergebnis könnte an der Anforderung vorbeigehen. Vergleiche beides kurz.',
  USER_REPORTED_DISSATISFACTION: 'Im Verlauf wurde ein Problem gemeldet. Prüfe die letzte Rückmeldung.',
  TASK_INCOMPLETE: 'Die Aufgabe wirkt noch offen. Prüfe, welcher angefragte Punkt fehlt.',
  CALLER_REPORTED_UNPERMITTED_ACTION: 'Eine nicht erlaubte Aktion wurde gemeldet. Prüfe die Berechtigungen.',
  PROVIDER_TIMEOUT: 'Der Jev-Dienst hat nicht rechtzeitig geantwortet.',
  PROVIDER_FAILURE: 'Der Jev-Dienst konnte die Prüfung nicht abschließen.',
  INVALID_PROVIDER_RESPONSE: 'Jev lieferte keine gültige Bewertung.',
  PROVIDER_HTTP_401: 'Der API-Schlüssel wurde abgelehnt. Prüfe deine Vercel-Verbindung.',
  PROVIDER_HTTP_429: 'Das Jev-Kontingent oder die Rate-Grenze ist erreicht.',
};

export function formatReviewCopy(recommendation, reasons = []) {
  const reason = reasons.map((code) => reasonCopy[code] ?? (/^PROVIDER_HTTP_/.test(code) ? 'Der Jev-Dienst hat einen Fehler gemeldet.' : '')).find(Boolean);
  const failure = reasons.some((code) => code.startsWith('PROVIDER_') || code === 'INVALID_PROVIDER_RESPONSE');
  if (reason) return { failure, text: reason };
  const text = {
    CONTINUE_BASELINE: 'Jev greift nicht ein. Der normale Ablauf bleibt unverändert; das ist keine Erfolgsbestätigung.',
    AUTO_CLOSE: 'Jev sieht den Lauf als vollständig an. (Es wird nichts automatisch geschlossen.)',
    HUMAN_REVIEW: 'Jev empfiehlt einen kurzen Blick auf den Lauf.',
    PRIORITY_REVIEW: 'Jev empfiehlt, den Lauf zeitnah zu prüfen.',
    FILE_ISSUE: 'Jev erkennt einen Fehler, den du prüfen solltest.',
    ROUTE_PAGE_ON_CALL: 'Jev empfiehlt eine Prüfung durch einen Verantwortlichen.',
  }[recommendation] ?? 'Jev konnte keine passende Empfehlung erzeugen.';
  return { failure, text };
}

export function formatReviewUsage({ calls, maxCalls, inputBytes, maxInputBytes, inputTokens, outputTokens }, currentUsage) {
  const perReview = currentUsage
    ? `Diese Prüfung: ${currentUsage.inputTokens} Eingabe- und ${currentUsage.outputTokens} Ausgabe-Tokens.`
    : 'Tokenverbrauch dieser Prüfung ist nicht verfügbar.';
  return `${perReview} Heute: ${inputTokens} Eingabe- und ${outputTokens} Ausgabe-Tokens; ${calls}/${maxCalls} Prüfungen und ${inputBytes}/${maxInputBytes} Byte Trace-Budget.`;
}

export function formatModelRecommendation(recommendation) {
  if (!recommendation) return '';
  if (recommendation.decisionBasis === 'baseline_fallback') return '';
  if (recommendation.decisionBasis === 'quality_fallback') return 'Vorsorglicher Modellhinweis: Bei der unklaren Fähigkeitsgrenze bevorzugt unsere Qualitätsregel ein stärkeres Modell. Das ist eine Empfehlung aus der Produktregel, keine sichere Jev-Diagnose; ein Wechsel kann mehr kosten.';
  if (recommendation.decisionBasis === 'prerequisite_override') return 'Modell beibehalten: Zuerst die erkannte Voraussetzung klären oder widersprüchliche Einschätzungen prüfen.';
  const confidence = `${Math.round(recommendation.confidence * 100)}%`;
  const text = {
    keep_current: `Jev hält das aktuelle Modell (${recommendation.currentModel}) für passend.`,
    try_more_capable: `Jev empfiehlt, für ähnliche Aufgaben ein stärkeres Modell zu testen.`,
    try_faster: 'Jev empfiehlt, für ähnliche risikoarme Aufgaben ein schnelleres Modell zu testen; Kosteneinsparungen sind nicht gemessen.',
    uncertain: 'Jev ist bei der Modellpassung unsicher und empfiehlt vorerst keinen Wechsel.',
  }[recommendation.action] ?? 'Jev konnte keine Modellpassung bestimmen.';
  const basis = recommendation.basis?.slice(0, 4).join(' ');
  return `Modellhinweis${recommendation.action === 'uncertain' ? '' : ` (${confidence})`}: ${text}${basis ? ` Grundlage: ${basis}` : ''}`;
}

export function formatRecoveryAdvice(advice) {
  if (!advice || advice.action === 'none') return '';
  return `Nächster Schritt: ${advice.title}${advice.suggestedPrompt ? ` Vorschlag zum Übernehmen: „${advice.suggestedPrompt}“` : ''}`;
}

export function shouldSurfaceReview(result) {
  if (result.recommendation !== 'CONTINUE_BASELINE') return true;
  if (formatReviewCopy(result.recommendation,result.reasons).failure) return true;
  return Boolean(formatRecoveryAdvice(result.recoveryAdvice)) || ['try_more_capable','try_faster'].includes(result.modelRecommendation?.action);
}
