import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeClaude = join(process.cwd(), 'tests/fixtures/fake-claude-cli.mjs');
const fakeCodex = join(process.cwd(), 'tests/fixtures/fake-codex-app-server.mjs');
const j = (choice, probabilities = { [choice]: 1 }) => ({ choice, confidence: 1, probabilities });
const jev = (kind, difficulty, newTask = 0.9) => async () => ({ ok: true, progress: j('advancing'), blocker: j('none'), next_step: j('continue'), question: null, nextModel: null,
  effort: j('medium', { low: 0, medium: 1, high: 0, xhigh: 0, max: 0 }), taskKind: j(kind), difficulty: j(difficulty), newTask: { yes: newTask }, stats: { mode: 'complete' }, usage: { input_tokens: 1, output_tokens: 1 } });
const catalog = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].map(slug => ({ slug, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort })) }));
const readLog = async file => (await readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l));

test('Jev app routing: one choice across Claude and Codex models; no new task keeps the agent; Jev down keeps it too', async () => {
  const { chooseRoute, candidates } = await import('../dist/jev-app/route.js');
  const conversation = { id: 'x', title: 't', cwd: '.', createdAt: 0, updatedAt: 0, access: 'read', agents: {}, messages: [] };
  const both = { claude: true, codex: true };
  assert.ok(candidates(both, catalog).includes('gpt-6-astra') && candidates(both, catalog).includes('claude-opus-5-5'));
  assert.ok(!candidates({ claude: true, codex: false }, catalog).some(m => m.startsWith('gpt')), 'a family that is not ready is never picked');
  const first = await chooseRoute({ conversation, text: 'Baue einen Parser', available: both, catalog, key: 'k', inspect: jev('coding', 'normal') });
  assert.deepEqual([first.agent, first.model, first.effort, first.source, first.switched], ['claude', 'claude-opus-5-5', 'medium', 'jev', false]);
  assert.match(first.line, /^Jev: Opus 5\.5 · Mittel \(Coding, normal\)$/);
  // Later in the conversation: a reply that is no new task stays with the same agent and setting.
  const withCodex = { ...conversation, messages: [{ role: 'user', text: 'a' }, { role: 'assistant', agent: 'codex', model: 'gpt-6-astra', effort: 'high', text: 'b' }] };
  const keep = await chooseRoute({ conversation: withCodex, text: 'ok danke', available: both, catalog, key: 'k', inspect: jev('coding', 'normal', 0.1) });
  assert.deepEqual([keep.agent, keep.model, keep.effort, keep.source, keep.switched], ['codex', 'gpt-6-astra', 'high', 'keep', false]);
  const down = await chooseRoute({ conversation: withCodex, text: 'weiter', available: both, catalog, key: undefined, inspect: async () => ({ ok: false, reason: 'JEV_KEY_MISSING', stats: null }) });
  assert.deepEqual([down.model, down.source], ['gpt-6-astra', 'keep']); assert.match(down.why, /JEV_KEY_MISSING/);
  // Chosen by hand: any ready model, its own effort levels.
  const hand = await chooseRoute({ conversation: withCodex, text: 'x', available: both, catalog, key: 'k', override: { model: 'claude-sonnet-5', effort: 'low' } });
  assert.deepEqual([hand.agent, hand.effort, hand.source, hand.switched], ['claude', 'low', 'user', true]);
  assert.match(hand.line, /Wechsel von GPT-6-Astra, der Verlauf geht mit/);
  await assert.rejects(chooseRoute({ conversation, text: 'x', available: { claude: false, codex: true }, catalog, key: 'k', override: { model: 'claude-opus-5-5' } }), /AGENT_NOT_READY claude/);
});

test('Jev app handover: a fresh agent gets the whole history; a returning agent only what the other one did since', async () => {
  const { handover } = await import('../dist/jev-app/route.js');
  const c = { agents: {}, messages: [
    { role: 'user', text: 'Baue den Parser' },
    { role: 'assistant', agent: 'claude', model: 'claude-opus-5-5', effort: 'medium', text: 'Parser gebaut', activity: ['geändert: src/csv.ts'] },
    { role: 'user', text: 'Jetzt die Tests' },
    { role: 'assistant', agent: 'codex', model: 'gpt-6-astra', effort: 'high', text: 'Tests geschrieben', activity: ['ausgeführt: npm test'] },
  ] };
  const fresh = handover(c, 'codex', 'Und die Doku');
  assert.equal(fresh.carried, 3, 'its own answer is not repeated');
  const claudeFresh = handover(c, 'claude', 'Und die Doku');
  assert.equal(claudeFresh.carried, 3);
  assert.match(claudeFresh.prompt, /^Jev-App, Übergabe: Du übernimmst ein laufendes Gespräch/);
  assert.match(claudeFresh.prompt, /Nutzer:\nBaue den Parser/);
  assert.match(claudeFresh.prompt, /Codex · GPT-6-Astra · Hoch:\nTests geschrieben\n\(ausgeführt: npm test\)/);
  assert.match(claudeFresh.prompt, /<\/verlauf>\n\nNeue Nachricht des Nutzers:\nUnd die Doku$/);
  // Claude saw everything up to its own answer: only the rest comes along.
  const back = handover({ ...c, agents: { claude: { sessionId: 's', seenUpTo: 2 } } }, 'claude', 'Und die Doku');
  assert.equal(back.carried, 2);
  assert.match(back.prompt, /^Jev-App, Übergabe: Seit deiner letzten Antwort hat ein anderer KI-Agent/);
  assert.doesNotMatch(back.prompt, /Baue den Parser/);
  assert.deepEqual(handover({ ...c, agents: { codex: { sessionId: 's', seenUpTo: 4 } } }, 'codex', 'weiter'), { prompt: 'weiter', carried: 0 });
  // Too long: the latest messages stay complete, older ones are shortened or dropped.
  const long = { agents: {}, messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', agent: 'codex', model: 'gpt-6-astra', text: `${i}:` + 'x'.repeat(2000) })) };
  const cut = handover(long, 'claude', 'neu', 20_000);
  assert.ok(cut.prompt.length < 26_000);
  assert.match(cut.prompt, /ältere Nachrichten ausgelassen|gekürzt/);
  assert.match(cut.prompt, /39:x{2000}/);
});

test('Claude runner: official CLI in stream-json mode with model, effort and session; permission prompts go to the user', async (t) => {
  const { ClaudeRunner, cleanClaudeEnv } = await import('../dist/jev-app/runners.js');
  const dir = await mkdtemp(join(tmpdir(), 'jev-claude-')); t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.FAKE_CLAUDE_LOG = join(dir, 'log.jsonl');
  assert.equal(cleanClaudeEnv({ CLAUDECODE: '1', CLAUDE_EFFORT: 'max', PATH: 'p' }).CLAUDECODE, undefined);
  const deltas = [], asked = [];
  const r1 = await new ClaudeRunner([process.execPath, fakeClaude]).run({ cwd: dir, sessionId: null, prompt: 'Hallo', model: 'claude-opus-5-5', effort: 'medium', access: 'read' },
    { delta: d => deltas.push(d), approval: async a => { asked.push(a); return 'accept'; } });
  assert.equal(r1.status, 'completed'); assert.equal(r1.text, 'Claude claude-opus-5-5 (medium) sagt: ok'); assert.equal(deltas.join(''), r1.text);
  assert.match(r1.sessionId, /^[0-9a-f-]{36}$/);
  const r2 = await new ClaudeRunner([process.execPath, fakeClaude]).run({ cwd: dir, sessionId: r1.sessionId, prompt: 'BEFEHL bitte', model: 'claude-sonnet-5', effort: 'low', access: 'write' },
    { approval: async a => { asked.push(a); return 'decline'; } });
  assert.equal(r2.status, 'completed'); assert.match(r2.text, /Befehl deny$/);
  assert.deepEqual(asked, [{ kind: 'command', title: 'Befehl ausführen (Bash)', detail: 'npm test' }]);
  assert.deepEqual(r2.activity, ['ausgeführt: npm test']);
  const log = await readLog(process.env.FAKE_CLAUDE_LOG);
  const [a1, a2] = log.filter(e => e.args).map(e => e.args);
  assert.deepEqual([a1[a1.indexOf('--model') + 1], a1[a1.indexOf('--effort') + 1], a1[a1.indexOf('--session-id') + 1], a1[a1.indexOf('--permission-mode') + 1], a1[a1.indexOf('--permission-prompts') + 1]], ['claude-opus-5-5', 'medium', r1.sessionId, 'default', 'host']);
  assert.deepEqual([a2[a2.indexOf('--resume') + 1], a2[a2.indexOf('--permission-mode') + 1]], [r1.sessionId, 'acceptEdits']);
  assert.deepEqual(log.find(e => e.permission).permission, { behavior: 'deny', message: 'Vom Nutzer in der Jev-App abgelehnt.' });
});

test('Jev app: one conversation switches from Claude to Codex and back; each agent gets what it has not seen; approvals come from the window', async (t) => {
  const { startApp } = await import('../dist/jev-app/app.js');
  const dir = await mkdtemp(join(tmpdir(), 'jev-app-')); t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.FAKE_STATE = join(dir, 'codex-state.json'); process.env.FAKE_LOG = join(dir, 'codex-log.jsonl'); process.env.FAKE_CLAUDE_LOG = join(dir, 'claude-log.jsonl');
  const { ClaudeRunner, CodexRunner } = await import('../dist/jev-app/runners.js');
  let kind = ['coding', 'normal'];
  const app = await startApp({ stateDir: dir, port: 0, token: 'b'.repeat(48), available: () => ({ claude: true, codex: true }), catalog: () => catalog, key: () => 'k',
    inspect: async () => jev(...kind)(), runner: a => a === 'claude' ? new ClaudeRunner([process.execPath, fakeClaude]) : new CodexRunner([process.execPath, fakeCodex]) });
  t.after(() => app.close());
  const base = app.url.split('/?')[0], H = { 'x-jev-token': 'b'.repeat(48), 'content-type': 'application/json' };
  const call = async (path, body) => { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: H, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  const events = []; const ctrl = new AbortController(); t.after(() => ctrl.abort());
  (async () => { const r = await fetch(`${base}/api/events?t=${'b'.repeat(48)}`, { signal: ctrl.signal }); const dec = new TextDecoder(); let buf = '';
    for await (const ch of r.body) { buf += dec.decode(ch); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); if (b.startsWith('data: ')) events.push(JSON.parse(b.slice(6))); } } })().catch(() => {});
  const idle = async n => { for (let i = 0; i < 300 && events.filter(e => e.type === 'idle').length < n; i++) await new Promise(r => setTimeout(r, 20)); };
  assert.equal((await fetch(base + '/api/state')).status, 403, 'token required');
  assert.equal((await call('/api/conversation', { cwd: join(dir, 'fehlt') })).status, 400);
  const conv = (await call('/api/conversation', { cwd: dir })).body;
  await new Promise(r => setTimeout(r, 50));
  // 1) Jev: coding → Claude Opus 5.5 · Mittel.
  assert.equal((await call('/api/send', { id: conv.id, text: 'Baue den Parser' })).status, 202);
  await idle(1);
  assert.equal(events.find(e => e.type === 'route').model, 'claude-opus-5-5');
  // 2) By hand to Codex: Codex gets the conversation so far as history.
  await call('/api/send', { id: conv.id, text: 'Schreib die Tests', model: 'gpt-6-astra', effort: 'high' });
  await idle(2);
  const codexTurn = (await readLog(process.env.FAKE_LOG)).find(e => e.method === 'turn/start').params;
  assert.deepEqual([codexTurn.model, codexTurn.effort], ['gpt-6-astra', 'high']);
  assert.match(codexTurn.input[0].text, /Du übernimmst ein laufendes Gespräch[\s\S]*Nutzer:\nBaue den Parser[\s\S]*Claude Code · Opus 5\.5 · Mittel:\nClaude claude-opus-5-5 \(medium\) sagt: ok[\s\S]*Neue Nachricht des Nutzers:\nSchreib die Tests$/);
  // 3) Jev keeps Codex for coding now (GPT-6-Astra is within tolerance and not 25 % cheaper than Opus 5.5 per task) …
  kind = ['coding', 'normal'];
  await call('/api/send', { id: conv.id, text: 'Und jetzt die Randfälle' });
  await idle(3);
  assert.deepEqual([events.filter(e => e.type === 'route')[2].model, events.filter(e => e.type === 'route')[2].source], ['gpt-6-astra', 'jev']);
  // 4) … back to Claude by hand: same Claude session, only Codex's part comes along; the command asks in the window.
  await call('/api/send', { id: conv.id, text: 'BEFEHL: lass die Tests laufen', model: 'claude-opus-5-5', effort: 'medium' });
  for (let i = 0; i < 300 && !events.some(e => e.type === 'approval'); i++) await new Promise(r => setTimeout(r, 20));
  const ask = events.find(e => e.type === 'approval');
  assert.deepEqual([ask.kind, ask.detail], ['command', 'npm test']);
  assert.equal((await call('/api/send', { id: conv.id, text: 'noch was' })).status, 409, 'one message at a time per conversation');
  assert.equal((await call('/api/approval', { requestId: ask.requestId, decision: 'accept' })).status, 200);
  await idle(4);
  const prompts = (await readLog(process.env.FAKE_CLAUDE_LOG)).filter(e => e.prompt).map(e => e.prompt);
  assert.equal(prompts[0], 'Baue den Parser', 'a new conversation needs no handover');
  assert.match(prompts[1], /^Jev-App, Übergabe: Seit deiner letzten Antwort hat ein anderer KI-Agent[\s\S]*Codex · GPT-6-Astra · Hoch:\nAntwort von gpt-6-astra[\s\S]*Neue Nachricht des Nutzers:\nBEFEHL: lass die Tests laufen$/);
  assert.doesNotMatch(prompts[1], /Baue den Parser/);
  const args = (await readLog(process.env.FAKE_CLAUDE_LOG)).filter(e => e.args).map(e => e.args);
  assert.equal(args[1][args[1].indexOf('--resume') + 1], args[0][args[0].indexOf('--session-id') + 1], 'Claude continues its own session');
  const saved = (await call(`/api/conversation?id=${conv.id}`)).body;
  assert.deepEqual(saved.messages.map(m => [m.role, m.agent ?? null]), [['user', null], ['assistant', 'claude'], ['user', null], ['assistant', 'codex'], ['user', null], ['assistant', 'codex'], ['user', null], ['assistant', 'claude']]);
  assert.match(saved.messages[7].text, /Befehl allow$/);
  assert.equal(saved.title, 'Baue den Parser');
  const state = (await call('/api/state')).body;
  assert.equal(state.conversations[0].id, conv.id);
  assert.ok(state.models.some(m => m.id === 'gpt-6-astra' && m.agent === 'codex') && state.models.some(m => m.id === 'claude-opus-5-5' && m.agent === 'claude'));
});
