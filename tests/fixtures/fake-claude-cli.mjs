// Minimal stand-in for `claude -p --input-format stream-json --output-format stream-json` used by the Jev app tests.
// Logs its arguments and every prompt to FAKE_CLAUDE_LOG.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const log = entry => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + '\n'); };
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const model = arg('--model'), effort = arg('--effort'), session = arg('--resume') ?? arg('--session-id');
log({ args, env: { CLAUDECODE: process.env.CLAUDECODE ?? null } });
let waiting = null;

createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request?.subtype === 'initialize') return send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  if (m.type === 'control_response') { log({ permission: m.response.response }); waiting?.(m.response.response); return; }
  if (m.type !== 'user') return;
  const text = m.message.content[0].text;
  log({ prompt: text });
  send({ type: 'system', subtype: 'init', model, session_id: session });
  const finish = extra => {
    const answer = `Claude ${model} (${effort}) sagt: ok${extra ?? ''}`;
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } });
    send({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text: answer }] }, parent_tool_use_id: null });
    send({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session });
  };
  if (text === 'TOOL_PARALLEL') {
    send({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run build' } },
    ] }, parent_tool_use_id: null });
    for (const [id, error] of [['unrelated', false], ['t2', false], ['t1', true]]) {
      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: 'synthetic tool result' }] }, parent_tool_use_id: null });
    }
    return finish();
  }
  if (text.includes('BEFEHL') || text.startsWith('TOOL_')) {
    const name = text.includes('DATEI') ? 'Edit' : text.includes('GENERIC') ? 'WebFetch' : 'Bash';
    const input = name === 'Edit' ? { file_path: 'src/parser.ts' } : name === 'Bash' ? { command: 'npm test' } : { url: 'https://example.test/' };
    const toolUse = { type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] }, parent_tool_use_id: null };
    send(toolUse);
    if (text.includes('REQUEST_ONLY')) return finish();
    waiting = r => {
      if (text.includes('APPROVAL_ONLY')) return finish();
      if (r.behavior === 'allow') log({ simulatedExecution: name });
      send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: r.behavior !== 'allow' || text.includes('FAILURE'), content: r.behavior === 'allow' ? 'synthetic tool result' : 'permission denied' }] }, parent_tool_use_id: null });
      // Duplicate intent must not erase the result already observed.
      send(toolUse);
      finish(` – Befehl ${r.behavior}`);
    };
    send({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_use_id: 't1', tool_name: name, input } });
  } else finish();
});
