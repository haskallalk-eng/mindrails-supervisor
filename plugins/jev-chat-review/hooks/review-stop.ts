import { createTraceTriage } from '../../../src/triage.js';
import { buildTraceFromTranscript } from './codex-transcript.mjs';
import { formatReviewCopy, formatReviewUsage, formatModelRecommendation } from './review-copy.mjs';
import { parsePositiveLimit, recordUsage, reserveReview } from './review-state.mjs';
import { readMonitorSession, recordMonitorUsage } from './monitor-state.mjs';

const emit = (systemMessage: string) => process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);
const readableFailure = (code: string) => ({
  PLUGIN_DATA_MISSING: 'Codex hat keinen lokalen Speicher für das Tageslimit bereitgestellt.',
  REVIEW_STATE_BUSY: 'der lokale Jev-Nutzungszähler ist gerade belegt.',
  REVIEW_STATE_INVALID: 'der lokale Jev-Nutzungszähler ist beschädigt.',
  REVIEW_BUDGET_CONFIG_INVALID: 'die Jev-Tageslimits sind ungültig konfiguriert.',
  TRANSCRIPT_PATH_MISSING: 'Codex hat keinen Chatverlauf übergeben.',
  TRANSCRIPT_HAS_NO_VISIBLE_TURNS: 'im Verlauf wurden keine lesbaren Chatbeiträge gefunden.',
  TRANSCRIPT_TOO_LARGE: 'der Chatverlauf ist für die lokale Prüfung zu groß.',
  TRANSCRIPT_EXCEEDS_TRACE_LIMITS: 'der Chat überschreitet die Zahl erlaubter Nachrichten oder Werkzeugaufrufe.',
  TRANSCRIPT_EXCEEDS_FIELD_LIMITS: 'eine Nachricht oder ein Werkzeugergebnis ist zu groß für eine sichere Prüfung.',
  TRANSCRIPT_EXCEEDS_TRACE_BYTE_LIMIT: 'der Chat überschreitet das sichere Jev-Eingabelimit.',
}[code] ?? (code.startsWith('PROVIDER_HTTP_') ? 'der Jev-Dienst hat einen Fehler gemeldet.' : 'die Prüfung konnte nicht abgeschlossen werden.'));
let raw = '';
let hookInputTooLarge = false;
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 1_000_000) { hookInputTooLarge = true; break; }
}

if (hookInputTooLarge) {
  emit('Jev konnte diesen Lauf nicht prüfen (HOOK_INPUT_TOO_LARGE). Der Lauf wurde normal abgeschlossen.');
} else if (process.env.MINDRAILS_JEV_AUTO_REVIEW === '0') {
  // Opted out; no conversation data is read or sent.
} else if (!process.env.AI_GATEWAY_API_KEY) {
  emit('Jev konnte diesen Lauf nicht prüfen: AI_GATEWAY_API_KEY ist nicht eingerichtet. Der Lauf wurde normal abgeschlossen.');
} else try {
  const hookInput = JSON.parse(raw);
  const dataDir = process.env.PLUGIN_DATA;
  if (!dataDir) throw new Error('PLUGIN_DATA_MISSING');
  const { trace, transcriptHash, tokenUsage, rateLimits } = await buildTraceFromTranscript(hookInput.transcript_path, hookInput.last_assistant_message);
  const observed = await readMonitorSession(dataDir, hookInput.session_id);
  await recordMonitorUsage(dataDir, hookInput.session_id, tokenUsage, rateLimits);
  const currentModel=observed?.currentModel ?? (typeof hookInput.model==='string' && hookInput.model.length<=100 ? hookInput.model : null);
  if (observed || currentModel || tokenUsage || rateLimits) trace.telemetry = {
    ...(currentModel ? { currentModel } : {}),
    ...(observed ? { toolCount: observed.toolCount, repeatedActions: observed.repeatedActions } : {}),
    ...(tokenUsage ? { latestUsage: tokenUsage } : {}),
    ...(rateLimits ? { rateLimits } : {}),
  };
  const maxCalls = parsePositiveLimit(process.env.MINDRAILS_JEV_DAILY_REVIEW_LIMIT, 20, 500);
  const maxInputBytes = parsePositiveLimit(process.env.MINDRAILS_JEV_DAILY_INPUT_BYTES, 350_000, 10_000_000);
  const reservation = await reserveReview({
    dataDir,
    sessionId: hookInput.session_id,
    transcriptHash,
    inputBytes: Buffer.byteLength(JSON.stringify(trace)),
    maxCalls,
    maxInputBytes,
  });
  if (reservation.status === 'duplicate') process.exitCode = 0;
  else if (reservation.status === 'budget') emit(`Jev hat heute sein lokales Nutzungslimit erreicht (${reservation.calls}/${maxCalls} Prüfungen oder ${reservation.inputBytes}/${maxInputBytes} Byte). Keine Anfrage wurde gesendet; Codex läuft normal weiter.`);
  else {
    const result = await createTraceTriage('jev', process.env.AI_GATEWAY_API_KEY, 'vercel-ai-gateway').evaluate(trace);
    const usage = result.providerUsage;
    const totals = await recordUsage(dataDir, usage);
    const copy = formatReviewCopy(result.recommendation, result.reasons);
    const usageLine = formatReviewUsage({ ...totals, maxCalls, maxInputBytes }, usage);
    const modelLine=formatModelRecommendation(result.modelRecommendation);
    emit(`${copy.failure ? 'Jev-Prüfung fehlgeschlagen' : 'Jev (beratend)'}: ${copy.text}${modelLine ? ` ${modelLine}` : ''} ${usageLine}`);
  }
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'REVIEW_FAILED';
  emit(`Jev konnte diesen Lauf nicht vollständig prüfen: ${readableFailure(code)} Es wurde kein Ergebnis bestätigt; Codex läuft normal weiter.`);
}
