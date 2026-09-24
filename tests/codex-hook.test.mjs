import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTraceFromTranscript } from '../plugins/jev-chat-review/hooks/codex-transcript.mjs';

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
  const trace = await buildTraceFromTranscript(path, 'Done.');
  assert.deepEqual(trace.turns.map(({ role }) => role), ['user', 'assistant']);
  assert.match(trace.turns[0].content, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(trace), /private system prompt|hidden reasoning|abc123|abc\.def\.ghi/);
  assert.deepEqual(trace.toolCalls, [{ name: 'read_file', arguments: '{"path":"a.txt"}', result: 'Bearer [REDACTED]' }]);
  assert.equal(trace.finalMessage, 'Done.');
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
