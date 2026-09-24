import { createTraceTriage } from '../../../src/triage.js';
import { buildTraceFromTranscript } from './codex-transcript.mjs';

const emit = (systemMessage: string) => process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);
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
  const trace = await buildTraceFromTranscript(hookInput.transcript_path, hookInput.last_assistant_message);
  const result = await createTraceTriage('jev', process.env.AI_GATEWAY_API_KEY, 'vercel-ai-gateway').evaluate(trace);
  emit(`Jev-Prüfung (beratend): ${result.recommendation} · ${result.reasons.join(', ')}`);
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'REVIEW_FAILED';
  emit(`Jev konnte diesen Lauf nicht vollständig prüfen (${code}). Der Lauf wurde normal abgeschlossen.`);
}
