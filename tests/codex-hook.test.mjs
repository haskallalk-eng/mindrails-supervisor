import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTraceFromTranscript } from '../plugins/jev-chat-review/hooks/codex-transcript.mjs';
import { parsePositiveLimit, recordUsage, reserveReview } from '../plugins/jev-chat-review/hooks/review-state.mjs';
import { formatReviewCopy, formatReviewUsage } from '../plugins/jev-chat-review/hooks/review-copy.mjs';

async function transcript(t, rows) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-hook-'));
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path;
}

test('Codex adapter preserves visible turns and tool activity, skips hidden messages, and redacts common credentials', async (t) => {
  const path = await transcript(t, [
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'private system prompt' }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'hidden reasoning' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Build this feature; API_KEY=abc123' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Bearer abc.def.ghi' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  ]);
  const { trace } = await buildTraceFromTranscript(path, 'Done.');
  assert.deepEqual(trace.turns.map(({ role }) => role), ['user', 'assistant']);
  assert.match(trace.turns[0].content, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(trace), /private system prompt|hidden reasoning|abc123|abc\.def\.ghi/);
  assert.deepEqual(trace.toolCalls, [{ name: 'read_file', arguments: '{"path":"a.txt"}', result: 'Bearer [REDACTED]' }]);
  assert.equal(trace.finalMessage, 'Done.');
});

test('daily limits reserve usage before requests and suppress duplicate transcript reviews', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-review-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const common = { dataDir: dir, sessionId: 'session-a', transcriptHash: 'hash-a', inputBytes: 100, maxCalls: 2, maxInputBytes: 250 };
  const first = await reserveReview(common);
  assert.equal(first.status, 'reserved');
  assert.equal(first.calls, 1);
  assert.equal((await reserveReview(common)).status, 'duplicate');
  assert.equal((await reserveReview({ ...common, transcriptHash: 'hash-b', inputBytes: 200 })).status, 'budget');
  await recordUsage(dir, { inputTokens: 900, outputTokens: 35 });
  const second = await reserveReview({ ...common, sessionId: 'session-b', transcriptHash: 'hash-c', inputBytes: 100 });
  assert.equal(second.status, 'reserved');
  assert.equal(second.calls, 2);
  assert.equal(second.inputTokens, 900);
  assert.equal(second.outputTokens, 35);
});

test('parallel Codex sessions cannot overshoot the shared daily call limit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-review-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = ['session-a', 'session-b'].map((sessionId) => reserveReview({
    dataDir: dir, sessionId, transcriptHash: sessionId, inputBytes: 1, maxCalls: 1, maxInputBytes: 100,
  }));
  const results = await Promise.all(requests);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['budget', 'reserved']);
  assert.equal(results.find(({ status }) => status === 'reserved').calls, 1);
});

test('daily limit configuration accepts safe positive values only', () => {
  assert.equal(parsePositiveLimit(undefined, 20, 500), 20);
  assert.equal(parsePositiveLimit('7', 20, 500), 7);
  assert.throws(() => parsePositiveLimit('0', 20, 500), /REVIEW_BUDGET_CONFIG_INVALID/);
  assert.throws(() => parsePositiveLimit('1.5', 20, 500), /REVIEW_BUDGET_CONFIG_INVALID/);
});

test('review feedback is actionable German and exposes usage without claiming a price', () => {
  assert.deepEqual(formatReviewCopy('HUMAN_REVIEW', ['TASK_INCOMPLETE']), {
    failure: false,
    text: 'Die Aufgabe wirkt noch offen. Prüfe, welcher angefragte Punkt fehlt.',
  });
  assert.deepEqual(formatReviewCopy('PRIORITY_REVIEW', ['SUCCESS_CLAIM_WITHOUT_SUPPORT']), {
    failure: false,
    text: 'Erfolg wird behauptet, aber im Verlauf nicht belegt. Prüfe Ergebnis oder Tests.',
  });
  const usage = formatReviewUsage({ calls: 3, maxCalls: 20, inputBytes: 5000, maxInputBytes: 350000, inputTokens: 2400, outputTokens: 110 }, { inputTokens: 800, outputTokens: 35 });
  assert.match(usage, /800 Eingabe- und 35 Ausgabe-Tokens/);
  assert.match(usage, /2400 Eingabe- und 110 Ausgabe-Tokens/);
  assert.doesNotMatch(usage, /\$/);
});

test('Codex adapter rejects missing, empty, oversized and overlong traces instead of silently sampling', async (t) => {
  await assert.rejects(buildTraceFromTranscript(undefined), /TRANSCRIPT_PATH_MISSING/);
  const empty = await transcript(t, [{ type: 'response_item', payload: { type: 'reasoning', summary: [] } }]);
  await assert.rejects(buildTraceFromTranscript(empty), /TRANSCRIPT_HAS_NO_VISIBLE_TURNS/);
  const long = await transcript(t, [{ type: 'event_msg', payload: { type: 'user_message', message: 'x'.repeat(6100) } }]);
  await assert.rejects(buildTraceFromTranscript(long), /TRANSCRIPT_EXCEEDS_FIELD_LIMITS/);
  const tooMany = await transcript(t, Array.from({ length: 121 }, (_, i) => ({ type: 'event_msg', payload: { type: 'user_message', message: `turn-${i}` } })));
  await assert.rejects(buildTraceFromTranscript(tooMany), /TRANSCRIPT_EXCEEDS_TRACE_LIMITS/);
});
