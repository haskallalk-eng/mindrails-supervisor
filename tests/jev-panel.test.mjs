import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRoutingContext, describeContext } from '../dist/routing-context.js';
import { routeModel } from '../dist/model-router.js';
import { startPanel } from '../dist/jev-panel.js';
import { acquireLock } from '../dist/jev-panel-session.js';

const fake = join(process.cwd(), 'tests/fixtures/fake-codex-app-server.mjs');
const models = ['astra', 'sol', 'luna'].map(t => ({ model: `gpt-6-${t}`, description: t, defaultReasoningEffort: 'medium' }));
const turn = (i, user, agent = `Antwort ${i}`, extra = []) => ({ id: `t${i}`, status: 'completed', items: [{ type: 'userMessage', text: user }, ...extra, { type: 'agentMessage', text: agent }] });

test('short history is sent completely and labeled as complete', () => {
  const { context, stats } = buildRoutingContext([turn(1, 'Baue einen Parser.'), turn(2, 'Jetzt Tests.')]);
  assert.equal(stats.mode, 'complete'); assert.equal(context.visibleHistory, 'complete'); assert.equal(context.turns.length, 2);
  assert.match(describeContext(stats), /Vollständiger sichtbarer Verlauf \(2 Turns/);
});

test('long history (~5 MB) becomes a labeled selection that keeps recent work, constraints, decisions and problems', async () => {
  const filler = 'Details zur Umsetzung ohne besondere Bedeutung. '.repeat(400);
  const turns = [turn(1, 'Ursprünglicher Auftrag: Baue den Jev-Router für Codex.')];
  for (let i = 2; i <= 260; i++) turns.push(turn(i, `Schritt ${i}. ${filler}`, `Erledigt ${i}. ${filler}`));
  turns[9] = turn(10, `Wichtig: Du darfst niemals den AI_GATEWAY_API_KEY ausgeben. ${filler}`);
  turns[120] = turn(121, `Weiter. ${filler}`, `Entscheidung: Wir verwenden thread/turns/list statt thread/read. ${filler}`);
  turns[250] = turn(251, `Der Test für lange Chats schlägt fehl mit Timeout. ${filler}`);
  turns.push(turn(261, 'Aktuell: Seitenfeld fertigstellen.', 'Offen: Lock-Freigabe prüfen.', [{ type: 'command', command: 'npm test', exitCode: 1, status: 'failed' }]));
  const { context, stats } = buildRoutingContext(turns);
  const sent = JSON.stringify(context);
  assert.ok(stats.sourceBytes > 4_000_000, `source ${stats.sourceBytes}`);
  assert.equal(stats.mode, 'selection'); assert.equal(context.visibleHistory, 'selection');
  assert.match(context.disclosure, /NOT the complete history/);
  assert.ok(Buffer.byteLength(sent) <= 24_000, `sent ${Buffer.byteLength(sent)}`);
  assert.equal(context.recentTurns.at(-1).user, 'Aktuell: Seitenfeld fertigstellen.');
  assert.deepEqual(context.recentTurns.at(-1).failedCommands, [{ command: 'npm test', exitCode: 1 }]);
  assert.match(sent, /niemals den AI_GATEWAY_API_KEY ausgeben/);
  assert.match(sent, /Entscheidung: Wir verwenden thread\/turns\/list/);
  assert.match(sent, /Ursprünglicher Auftrag/);
  assert.equal(stats.recentTurns + stats.digestedTurns + stats.omittedTurns, 261);
  assert.match(describeContext(stats), /^Auswahl, nicht der vollständige Verlauf/);
  // The selection fits the router limit, so Jev is actually asked instead of falling back.
  let calls = 0;
  const decision = await routeModel({ task: 'Weiter', context, models, baseline: 'gpt-6-astra', key: 'k' }, async (_u, o) => {
    calls++; assert.ok(Buffer.byteLength(o.body) < 64_000); assert.ok(!o.body.includes('AI_GATEWAY_API_KEY='));
    return new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers: { next_model: { type: 'choice', choice: 'gpt-6-sol', confidence: 0.6, probabilities: { 'gpt-6-astra': 0.3, 'gpt-6-sol': 0.6, 'gpt-6-luna': 0.1 } } }, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  assert.equal(calls, 1); assert.equal(decision.model, 'gpt-6-sol');
});

test('partially read history discloses that older turns were not read', () => {
  const { stats, context } = buildRoutingContext([turn(1, 'x'.repeat(30_000))], { olderUnread: true });
  assert.equal(stats.mode, 'selection'); assert.equal(context.firstRequest, null);
  assert.match(describeContext(stats), /noch ältere Turns nicht gelesen/);
});

test('cross-process lock prevents two panels from running one conversation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-lock-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const release = acquireLock(dir, 'abc');
  assert.throws(() => acquireLock(dir, 'abc'), /CONVERSATION_LOCKED/);
  release(); acquireLock(dir, 'abc')();
});

async function panel(t, routeImpl, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-panel-')); t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.FAKE_STATE = join(dir, 'state.json'); process.env.FAKE_LOG = join(dir, 'log.jsonl');
  const routeCalls = [];
  const route = async input => { routeCalls.push(input); return routeImpl(input, routeCalls.length); };
  const p = await startPanel({ codex: [process.execPath, fake], cwd: dir, write: false, port: 0, stateDir: dir, token: 'a'.repeat(48), key: () => 'k', route, ...extra });
  t.after(() => p.close());
  const base = p.url.split('/?')[0];
  const api = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-jev-token': 'a'.repeat(48), 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const events = [];
  const res = await fetch(`${base}/api/events?t=${'a'.repeat(48)}`);
  const reader = res.body.getReader(); let buf = '';
  (async () => { try { while (true) { const { done, value } = await reader.read(); if (done) break; buf += Buffer.from(value).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { events.push(JSON.parse(buf.slice(6, i))); buf = buf.slice(i + 2); } } } catch {} })();
  t.after(() => reader.cancel().catch(() => {}));
  const waitFor = async (pred, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { const e = events.find(pred); if (e) return e; await new Promise(r => setTimeout(r, 25)); } throw new Error('timeout waiting for event; got ' + events.map(e => e.type).join(',')); };
  const sendAndWait = async (text, id = crypto.randomUUID()) => {
    const r = await api('/api/send', { text, clientMessageId: id });
    const user = await waitFor(e => e.type === 'user' && e.clientMessageId === id);
    await waitFor(e => e.type === 'idle' && e.seq > user.seq); return r;
  };
  const log = async () => (await readFile(process.env.FAKE_LOG, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  return { p, base, api, events, waitFor, sendAndWait, log, routeCalls, dir };
}
const dist = (probabilities, model) => ({ model, source: 'jev', probabilities });

test('panel: first message routes then executes with the winner; follow-up hands over to a different model in the same conversation', async (t) => {
  const h = await panel(t, (input, n) => n === 1 ? dist({ 'gpt-6-astra': 0.1, 'gpt-6-sol': 0.2, 'gpt-6-luna': 0.7 }, 'gpt-6-luna') : dist({ 'gpt-6-astra': 0.8, 'gpt-6-sol': 0.15, 'gpt-6-luna': 0.05 }, 'gpt-6-astra'));
  assert.equal((await h.sendAndWait('Erkläre kurz die Variable x.')).status, 202);
  const first = h.events.find(e => e.type === 'decision');
  assert.equal(first.model, 'gpt-6-luna'); assert.equal(first.baseline, 'gpt-6-astra');
  assert.equal(h.events.find(e => e.type === 'turn').status, 'completed');
  assert.match(h.events.find(e => e.type === 'agent').text, /gpt-6-luna/);
  const threadId = h.events.find(e => e.type === 'thread' && e.created).threadId;
  assert.equal(h.p.session.threadId, threadId);

  await h.sendAndWait('Folgefrage: Entwirf jetzt die Architektur für verteilte Sperren.');
  const calls = await h.log();
  const turns = calls.filter(c => c.method === 'turn/start');
  assert.deepEqual(turns.map(c => [c.params.threadId, c.params.model]), [[threadId, 'gpt-6-luna'], [threadId, 'gpt-6-astra']]);
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(calls.filter(c => c.method === 'thread/resume').length, 1);
  // Follow-up routing saw the previous turn and used the conversation's current model as baseline.
  assert.equal(h.routeCalls[1].baseline, 'gpt-6-luna');
  assert.equal(h.routeCalls[1].context.visibleHistory, 'complete');
  assert.equal(h.routeCalls[1].context.turns[0].user, 'Erkläre kurz die Variable x.');
  assert.equal(h.events.filter(e => e.type === 'agent').at(-1).text, 'Antwort von gpt-6-astra');
});

test('panel: Jev failure falls back to the baseline model, shows the reason, and does not retry', async (t) => {
  let jevCalls = 0;
  const h = await panel(t, input => routeModel(input, async () => { jevCalls++; throw new Error('network'); }));
  await h.sendAndWait('Aufgabe');
  const d = h.events.find(e => e.type === 'decision');
  assert.equal(d.source, 'baseline'); assert.equal(d.probabilities, null); assert.equal(d.reason, 'JEV_UNAVAILABLE_OR_INVALID'); assert.equal(d.model, 'gpt-6-astra');
  assert.equal(jevCalls, 1);
  assert.equal((await h.log()).filter(c => c.method === 'turn/start')[0].params.model, 'gpt-6-astra');
});

test('panel: duplicate and parallel sends are rejected; nothing runs twice', async (t) => {
  process.env.FAKE_TURN_MS = '400'; t.after(() => delete process.env.FAKE_TURN_MS);
  const h = await panel(t, () => dist({ 'gpt-6-astra': 0.2, 'gpt-6-sol': 0.7, 'gpt-6-luna': 0.1 }, 'gpt-6-sol'));
  const [a, b] = await Promise.all([h.api('/api/send', { text: 'Eins', clientMessageId: 'm1' }), h.api('/api/send', { text: 'Zwei', clientMessageId: 'm2' })]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  await h.waitFor(e => e.type === 'idle');
  assert.equal((await h.api('/api/send', { text: 'Eins', clientMessageId: 'm1' })).status, 409);
  assert.equal((await h.log()).filter(c => c.method === 'turn/start').length, 1);
});

test('panel: a conversation held by the Codex app is not written; explicit fork continues in a copy', async (t) => {
  const h = await panel(t, () => dist({ 'gpt-6-astra': 0.5, 'gpt-6-sol': 0.3, 'gpt-6-luna': 0.2 }, 'gpt-6-astra'));
  await h.sendAndWait('Start');
  const original = h.p.session.threadId;
  const { writeFileSync, readFileSync } = await import('node:fs');
  const s = JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')); s.writerLocked = [original]; writeFileSync(process.env.FAKE_STATE, JSON.stringify(s));
  await h.sendAndWait('Weiter');
  const blocked = h.events.find(e => e.type === 'blocked');
  assert.equal(blocked.reason, 'CODEX_WRITER_ACTIVE'); assert.match(blocked.message, /Nicht gesendet/);
  assert.equal(h.events.filter(e => e.type === 'decision').length, 1, 'no Jev call for an unwritable conversation');
  assert.equal((await h.log()).filter(c => c.method === 'turn/start').length, 1);
  assert.equal((await h.api('/api/fork', {})).status, 200);
  const forked = h.p.session.threadId; assert.notEqual(forked, original);
  await h.sendAndWait('Weiter im Abzweig');
  const last = (await h.log()).filter(c => c.method === 'turn/start').at(-1);
  assert.equal(last.params.threadId, forked);
});

test('panel: approval requests are shown and only answered by the user', async (t) => {
  const h = await panel(t, () => dist({ 'gpt-6-astra': 0.6, 'gpt-6-sol': 0.3, 'gpt-6-luna': 0.1 }, 'gpt-6-astra'));
  await h.api('/api/send', { text: 'APPROVAL bitte', clientMessageId: 'x' });
  const req = await h.waitFor(e => e.type === 'approval');
  assert.equal(req.command, 'rm -rf build');
  assert.equal((await h.api('/api/approval', { requestId: req.requestId, decision: 'decline' })).status, 200);
  await h.waitFor(e => e.type === 'idle');
  assert.deepEqual((await h.log()).find(c => c.approvalResponse).approvalResponse, { decision: 'decline' });
});

test('panel: requests without token, wrong host or cross-site form posts are rejected', async (t) => {
  const h = await panel(t, () => dist({ 'gpt-6-astra': 1, 'gpt-6-sol': 0, 'gpt-6-luna': 0 }, 'gpt-6-astra'));
  assert.equal((await fetch(h.base + '/')).status, 403);
  assert.equal((await fetch(h.base + '/api/state')).status, 403);
  assert.equal((await fetch(h.base + '/api/send', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-jev-token': 'a'.repeat(48) }, body: '{}' })).status, 415);
  const page = await fetch(h.p.url); assert.equal(page.status, 200); assert.match(await page.text(), /Jev Seitenfeld/);
  const { request } = await import('node:http');
  const status = await new Promise(r => request(h.base + '/api/state', { headers: { host: 'evil.example:80', 'x-jev-token': 'a'.repeat(48) } }, res => r(res.statusCode)).end());
  assert.equal(status, 403);
});

test('Claude Code transcripts become visible turns without thinking, meta or side chains', async (t) => {
  const { readClaudeSession, listClaudeSessions, findClaudeSession } = await import('../dist/chat-inspect.js');
  const { mkdir, copyFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-')); t.after(() => rm(root, { recursive: true, force: true }));
  const id = '11111111-2222-4333-8444-555555555555';
  await mkdir(join(root, 'C--proj')); await copyFile('tests/fixtures/claude-session.jsonl', join(root, 'C--proj', `${id}.jsonl`));
  const turns = readClaudeSession(findClaudeSession(id, root));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].items[0].text, 'Baue den Parser. Du darfst niemals die Datenbank löschen.');
  assert.deepEqual(turns[0].items.slice(1).map(i => i.type), ['agentMessage', 'command', 'fileChange', 'agentMessage']);
  assert.equal(turns[0].items[2].status, 'failed');
  const all = JSON.stringify(turns); assert.ok(!all.includes('geheim') && !all.includes('Nebenagent') && !all.includes('meta') && !all.includes('intern'));
  const [listed] = listClaudeSessions(root); assert.equal(listed.title, 'Parser bauen'); assert.equal(listed.cwd, 'C:/proj');
  assert.equal(findClaudeSession('../../etc/passwd', root), null);
});

test('asking Jev about a chat: fixed judgments plus a yes/no probability; failures are reported, not invented', async () => {
  const { inspectChat } = await import('../dist/chat-inspect.js');
  const turns = [turn(1, 'Baue den Parser. password=hunter2', 'Ein Test schlägt fehl.')];
  const probs = keys => Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0]));
  const ok = { answers: {
    progress: { type: 'choice', choice: 'stalled', confidence: 0.8, probabilities: { ...probs(['stalled', 'advancing', 'complete', 'uncertain']) } },
    blocker: { type: 'choice', choice: 'ineffective_approach', confidence: 0.7, probabilities: probs(['ineffective_approach', 'none', 'missing_information', 'environment', 'verification_gap', 'requirement_mismatch', 'uncertain']) },
    next_step: { type: 'choice', choice: 'change_approach', confidence: 0.7, probabilities: probs(['change_approach', 'continue', 'ask_question', 'fix_environment', 'verify_result', 'realign', 'review']) },
    user_question: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 10, output_tokens: 5 } };
  let sent;
  const r = await inspectChat({ turns, question: 'Sind die Tests grün?', key: 'k', source: 'test' }, async (_u, o) => { sent = JSON.parse(o.body); return new Response(JSON.stringify(ok)); });
  assert.equal(r.ok, true); assert.equal(r.progress.choice, 'stalled'); assert.equal(r.question.yes, 0.1);
  assert.equal(sent.state.userQuestion, 'Sind die Tests grün?'); assert.equal(sent.questions.user_question.type, 'noul');
  assert.ok(!JSON.stringify(sent).includes('hunter2'));
  const bad = await inspectChat({ turns, key: 'k', source: 'test' }, async () => new Response(JSON.stringify({ ...ok, answers: { ...ok.answers, progress: { ...ok.answers.progress, choice: 'invented' } } })));
  assert.deepEqual([bad.ok, bad.reason], [false, 'JEV_INVALID_RESPONSE']);
  let calls = 0;
  const down = await inspectChat({ turns, key: 'k', source: 'test' }, async () => { calls++; return new Response('', { status: 503 }); });
  assert.deepEqual([down.ok, down.reason, calls], [false, 'JEV_HTTP_503', 1]);
  assert.equal((await inspectChat({ turns, key: '', source: 'test' })).reason, 'JEV_KEY_MISSING');
});

test('next-task model suggestion uses the highest probability among the offered models only', async () => {
  const { inspectChat, CLAUDE_MODELS } = await import('../dist/chat-inspect.js');
  const one = keys => Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0]));
  const base = { task_kind: { type: 'choice', choice: 'coding', confidence: 1, probabilities: { coding: 1, agentic: 0, reasoning: 0, research: 0, simple: 0 } }, difficulty: { type: 'choice', choice: 'normal', confidence: 1, probabilities: { easy: 0, normal: 1, hard: 0 } },
    progress: { type: 'choice', choice: 'advancing', confidence: 1, probabilities: one(['advancing', 'stalled', 'complete', 'uncertain']) },
    blocker: { type: 'choice', choice: 'none', confidence: 1, probabilities: one(['none', 'missing_information', 'environment', 'ineffective_approach', 'verification_gap', 'requirement_mismatch', 'uncertain']) },
    next_step: { type: 'choice', choice: 'continue', confidence: 1, probabilities: one(['continue', 'ask_question', 'fix_environment', 'change_approach', 'verify_result', 'realign', 'review']) } };
  const ids = CLAUDE_MODELS.map(m => m.id);
  const reply = next_model => async (_u, o) => { const b = JSON.parse(o.body); assert.equal(b.state.nextTask, 'Tippfehler fixen'); assert.deepEqual(Object.keys(b.questions.next_model.criteria), ids); return new Response(JSON.stringify({ answers: { ...base, next_model }, usage: { input_tokens: 1, output_tokens: 1 } })); };
  const input = { turns: [turn(1, 'x')], task: 'Tippfehler fixen', models: CLAUDE_MODELS, key: 'k', source: 't' };
  const r = await inspectChat(input, reply({ type: 'choice', choice: ids[0], confidence: 0.3, probabilities: { [ids[0]]: 0.2, [ids[1]]: 0.1, [ids[2]]: 0.7, [ids[3]]: 0 } }));
  assert.equal(r.nextModel.choice, ids[2], 'argmax wins over the stated choice');
  const bad = await inspectChat(input, reply({ type: 'choice', choice: 'gpt-4', confidence: 1, probabilities: { 'gpt-4': 1 } }));
  assert.deepEqual([bad.ok, bad.reason], [false, 'JEV_INVALID_RESPONSE']);
  const noTask = await inspectChat({ ...input, task: '' }, async (_u, o) => { assert.ok(!JSON.parse(o.body).questions.next_model); return new Response(JSON.stringify({ answers: base, usage: { input_tokens: 1, output_tokens: 1 } })); });
  assert.equal(noTask.nextModel, null);
});

test('prompt hook: #jev commands are recognized, normal prompts are not; focus round-trips', async (t) => {
  const { parseJevCommand, writeFocus, readFocus, formatResult } = await import('../dist/jev-hook.js');
  assert.equal(parseJevCommand('Mach weiter'), null);
  assert.equal(parseJevCommand('Bitte #jev nutzen'), null);
  assert.deepEqual(parseJevCommand('#jev'), { kind: 'analyze', task: undefined });
  assert.deepEqual(parseJevCommand('  #JEV  Baue Tests '), { kind: 'analyze', task: 'Baue Tests' });
  assert.deepEqual(parseJevCommand('#jev? Sind die Tests grün?'), { kind: 'question', question: 'Sind die Tests grün?' });
  assert.deepEqual(parseJevCommand('#jev an'), { kind: 'guard', enabled: true });
  assert.deepEqual(parseJevCommand('#jev AUS'), { kind: 'guard', enabled: false });
  assert.deepEqual(parseJevCommand('#jev hilfe'), { kind: 'help' });
  const dir = await mkdtemp(join(tmpdir(), 'jev-focus-')); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(readFocus(dir), null);
  writeFocus(dir, { kind: 'claude', id: '11111111-2222-4333-8444-555555555555', at: 5 });
  assert.equal(readFocus(dir).id, '11111111-2222-4333-8444-555555555555');
  assert.match(formatResult({ ok: false, reason: 'JEV_HTTP_503', stats: null }, null), /JEV_HTTP_503.*Keine Werte erfunden/);
});

test('prompt hook process: normal prompt passes silently and records focus; #jev without key is blocked with a reason', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'jev-hookproc-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, JEV_PANEL_HOME: dir, AI_GATEWAY_API_KEY: '', JEV_NO_USER_KEY: '1' };
  const ev = prompt => JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555', transcript_path: 'tests/fixtures/claude-session.jsonl', prompt });
  const normal = spawnSync(process.execPath, ['dist/jev-hook.js'], { input: ev('Mach weiter'), env, encoding: 'utf8' });
  assert.equal(normal.status, 0); assert.equal(normal.stdout, '');
  assert.equal(JSON.parse(await readFile(join(dir, 'focus.json'), 'utf8')).kind, 'claude');
  const cmd = spawnSync(process.execPath, ['dist/jev-hook.js'], { input: ev('#jev'), env, encoding: 'utf8' });
  const out = JSON.parse(cmd.stdout); assert.equal(out.decision, 'block'); assert.match(out.reason, /JEV_KEY_MISSING/);
});

test('guard mode: first send is held with a recommendation, the identical second send passes; short prompts pass', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const http = await import('node:http');
  const dir = await mkdtemp(join(tmpdir(), 'jev-guard-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, JEV_PANEL_HOME: dir, JEV_NO_USER_KEY: '1', AI_GATEWAY_API_KEY: '' };
  const run = (prompt) => spawnSync(process.execPath, ['dist/jev-hook.js'], { input: JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555', transcript_path: 'tests/fixtures/claude-session.jsonl', prompt }), env, encoding: 'utf8' });
  assert.match(JSON.parse(run('#jev an').stdout).reason, /für DIESEN Chat AN/);
  // Without a key Jev cannot answer: the prompt must go through (never blocked), with a visible notice.
  const noKey = JSON.parse(run('Baue bitte einen Parser für CSV-Dateien').stdout);
  assert.equal(noKey.decision, undefined); assert.match(noKey.systemMessage, /JEV_KEY_MISSING.*normal gesendet/);
  assert.equal(run('ok danke').stdout, '');
  assert.equal(run('/compact').stdout, '');
  assert.match(JSON.parse(run('#jev aus').stdout).reason, /AUS/);
  assert.equal(run('Baue bitte einen Parser für CSV-Dateien').stdout, '');
});

test('guard is per chat and passes immediately when Jev recommends the current model', async (t) => {
  const { setGuard, guardEnabled, sameModel } = await import('../dist/jev-hook.js');
  const dir = await mkdtemp(join(tmpdir(), 'jev-guard2-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const a = '11111111-2222-4333-8444-555555555555', b = '66666666-2222-4333-8444-555555555555';
  setGuard(dir, a, true);
  assert.equal(guardEnabled(dir, a), true); assert.equal(guardEnabled(dir, b), false);
  setGuard(dir, a, false); assert.equal(guardEnabled(dir, a), false);
  assert.equal(sameModel('claude-opus-4-7', 'tier-strong'), true);
  assert.equal(sameModel('claude-haiku-4-5-20251001', 'tier-fast'), true);
  assert.equal(sameModel('claude-opus-5-5', 'tier-everyday'), false);
  assert.equal(sameModel(null, 'tier-everyday'), false);
});

test('recommendation text shows task, model, benchmark reason, exact effort and how to continue', async () => {
  const { formatResult } = await import('../dist/jev-hook.js');
  const j = (choice, probabilities) => ({ choice, confidence: 1, probabilities });
  const app = { kind: 'claude', name: 'Claude', tiers: [], candidates: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    readTurns: () => [], current: () => ({ model: 'claude-fable-5-1', effort: null }), efforts: m => /haiku/.test(m) ? [] : ['low', 'medium', 'high', 'xhigh', 'max'],
    display: m => ({ 'claude-opus-5-5': 'Opus 5.5', 'claude-fable-5-1': 'Fable 5.1', 'claude-opus-5': 'Opus 5' })[m] ?? String(m) };
  const r = { ok: true, progress: j('advancing', { advancing: 1 }), blocker: j('none', { none: 1 }), next_step: j('continue', { continue: 1 }), question: null,
    nextModel: null, taskKind: j('coding', { coding: 0.9, simple: 0.1 }), difficulty: j('normal', { normal: 0.7, hard: 0.3 }),
    effort: j('xhigh', { xhigh: 0.6, high: 0.3, low: 0.1, medium: 0, max: 0, ultra: 0 }), stats: { mode: 'complete' }, usage: { input_tokens: 5, output_tokens: 1 } };
  const text = formatResult(r, 'x', app, { guard: true });
  assert.match(text, /Aufgabe: Coding · normal/);
  assert.match(text, /Modell:  Opus 5.5   \(aktuell: Fable 5.1\)/);
  assert.match(text, /FrontierCode v1.1 Main \(Herstellerangaben\): Opus 5.5 54,4 · Fable 5.1 50,3/);
  assert.match(text, /Effort:  Extra hoch \(xhigh\)/);
  assert.doesNotMatch(text, /sehr hoch/);
  assert.match(text, /dieselbe Nachricht nochmal senden/);
});

test('benchmark policy: small gaps never switch, clear gaps and big savings do', async () => {
  const { decideModel, MIN_SWITCH_POINTS } = await import('../dist/model-policy.js');
  const claude = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
  const codex = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'];
  assert.equal(MIN_SWITCH_POINTS, 4);
  // Coding on Fable 5.1: Opus 5.5 scores higher AND costs 60 % less -> switch.
  const f = decideModel({ kind: 'coding', difficulty: 'normal', current: 'claude-fable-5-1', candidates: claude });
  assert.deepEqual([f.recommended, f.interrupt], ['claude-opus-5-5', true]);
  // Coding on Opus 5.5: already best -> stay.
  assert.equal(decideModel({ kind: 'coding', difficulty: 'hard', current: 'claude-opus-5-5', candidates: claude }).interrupt, false);
  // Codex coding on Sol (49.3) vs Astra (53.3): exactly 4 points -> reaches the threshold, switch.
  const s = decideModel({ kind: 'coding', difficulty: 'hard', current: 'gpt-6-sol', candidates: codex });
  assert.deepEqual([s.recommended, s.interrupt, s.reason], ['gpt-6-astra', true, 'quality-gap']);
  // Opus 5 (48.0) vs Fable 5.1 (50.3) on hard coding: 2.3 points -> below threshold, stay.
  const u = decideModel({ kind: 'coding', difficulty: 'hard', current: 'claude-opus-5', candidates: ['claude-opus-5', 'claude-fable-5-1'] });
  assert.deepEqual([u.recommended, u.interrupt, u.reason], ['claude-fable-5-1', false, 'gap-below-threshold']);
  // Saving threshold 25 %: Sonnet 5 ($10) vs Haiku ($5) on a simple task saves 50 % -> switch.
  assert.equal(decideModel({ kind: 'simple', difficulty: 'easy', current: 'claude-sonnet-5', candidates: claude }).interrupt, true);
  // Codex agentic on GPT-5.6-Sol (37.3) vs Astra (57.9): clear 20.6-point gap -> switch.
  const a = decideModel({ kind: 'agentic', difficulty: 'normal', current: 'gpt-5.6-sol', candidates: codex });
  assert.deepEqual([a.recommended, a.interrupt, a.reason, a.gap], ['gpt-6-astra', true, 'quality-gap', 20.6]);
  // Codex reasoning, easy: Sol (48) within 10 of Astra (53) and cheaper -> saving on Astra.
  const e = decideModel({ kind: 'reasoning', difficulty: 'easy', current: 'gpt-6-astra', candidates: codex });
  assert.deepEqual([e.recommended, e.interrupt, e.reason], ['gpt-6-sol', true, 'saving']);
  // Simple task on Opus 5.5 -> Haiku (75 % cheaper); on Haiku -> stay.
  assert.deepEqual([decideModel({ kind: 'simple', difficulty: 'easy', current: 'claude-opus-5-5', candidates: claude }).recommended, decideModel({ kind: 'simple', difficulty: 'easy', current: 'claude-opus-5-5', candidates: claude }).interrupt], ['claude-haiku-4-5', true]);
  assert.equal(decideModel({ kind: 'simple', difficulty: 'easy', current: 'claude-haiku-4-5-20251001', candidates: claude }).interrupt, false);
  // No published comparable score (Sonnet 5 on coding, Opus 4.7) -> no benchmark decision.
  assert.equal(decideModel({ kind: 'coding', difficulty: 'normal', current: 'claude-sonnet-5', candidates: claude }).basis, 'none');
  assert.equal(decideModel({ kind: 'coding', difficulty: 'normal', current: 'claude-opus-4-7', candidates: claude }).basis, 'none');
  // Settings alias resolves.
  assert.equal(decideModel({ kind: 'coding', difficulty: 'normal', current: 'fable[1m]', candidates: claude }).recommended, 'claude-opus-5-5');
});

test('Codex: rollout, current model/effort, catalog tiers and exact effort ids', async (t) => {
  const { readCodexRollout, codexTurnSettings } = await import('../dist/codex-rollout.js');
  const { codexTiers, pickEffort } = await import('../dist/chat-inspect.js');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'jev-codex-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'rollout-x-11111111-2222-4333-8444-555555555555.jsonl');
  const ev = item => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } });
  await writeFile(file, [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol', effort: 'medium' } }),
    ev({ type: 'UserMessage', content: [{ type: 'text', text: 'Baue den Parser.' }] }),
    ev({ type: 'Reasoning', summary_text: ['geheim'] }),
    ev({ type: 'CommandExecution', command: ['pwsh', '-Command', 'npm test'], exit_code: 1 }),
    ev({ type: 'FileChange', changes: { 'src/a.ts': { type: 'update' } } }),
    ev({ type: 'AgentMessage', content: [{ type: 'Text', text: 'Ein Test schlägt fehl.' }] }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high' } }),
  ].join('\n'));
  const turns = readCodexRollout(file);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].items.map(i => i.type), ['userMessage', 'command', 'fileChange', 'agentMessage']);
  assert.deepEqual([turns[0].items[1].command, turns[0].items[1].status], ['npm test', 'failed']);
  assert.ok(!JSON.stringify(turns).includes('geheim'));
  assert.deepEqual(codexTurnSettings(file), { model: 'gpt-6-astra', effort: 'high' });
  const catalog = [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) },
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', supported_reasoning_levels: ['low', 'medium'].map(effort => ({ effort })) },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })) },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5' }, { slug: 'codex-auto-review' },
  ];
  const tiers = codexTiers(catalog);
  assert.deepEqual(tiers.map(x => [x.label, x.defaultModel]), [['Spitze', 'gpt-6-astra'], ['Alltag', 'gpt-6-sol'], ['Schnell', 'gpt-6-luna']]);
  assert.match(tiers[1].members, /GPT-6-Sol, GPT-5.5/);
  // Effort is clamped to what the model really offers: Luna has no "ultra".
  assert.equal(pickEffort({ probabilities: { ultra: 0.9, max: 0.1 } }, tiers[2].efforts), 'max');
  assert.equal(pickEffort({ probabilities: { high: 1 } }, []), null);
});

test('guard threshold: never within a tier, only for a clear tier difference', async () => {
  const { guardDecision } = await import('../dist/chat-inspect.js');
  const p = (top, strong, everyday, fast) => ({ probabilities: { 'tier-top': top, 'tier-strong': strong, 'tier-everyday': everyday, 'tier-fast': fast } });
  // Opus 4.6 vs 4.7 vs 5.5: same tier, no interruption even at 100 %.
  assert.equal(guardDecision('claude-opus-4-6', p(0, 1, 0, 0)).reason, 'same-tier');
  assert.equal(guardDecision('claude-opus-4-6', p(0, 1, 0, 0)).interrupt, false);
  // Clear downgrade Opus -> Haiku.
  assert.deepEqual([guardDecision('claude-opus-5-5', p(0, 0.1, 0.1, 0.8)).interrupt, guardDecision('claude-opus-5-5', p(0, 0.1, 0.1, 0.8)).recommended.label], [true, 'Schnell']);
  // Clear upgrade Sonnet -> Fable.
  assert.equal(guardDecision('claude-sonnet-5', p(0.7, 0.2, 0.1, 0)).interrupt, true);
  // Leaning but not clear: top below 50 % or margin below 25 points.
  assert.equal(guardDecision('claude-opus-5-5', p(0, 0.3, 0.45, 0.25)).reason, 'unclear');
  assert.equal(guardDecision('claude-opus-5-5', p(0, 0.35, 0.55, 0.1)).reason, 'unclear');
  assert.equal(guardDecision('claude-opus-5-5', p(0, 0.25, 0.6, 0.15)).interrupt, true);
  // Unknown current model: never interrupt.
  assert.equal(guardDecision(null, p(0, 0, 0, 1)).reason, 'unknown-current');
  // Settings aliases are understood.
  assert.equal(guardDecision('fable[1m]', p(1, 0, 0, 0)).reason, 'same-tier');
});
