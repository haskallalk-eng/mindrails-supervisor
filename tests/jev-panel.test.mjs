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
  // Jev's own gate: with `gate` the same request also asks whether this is a new task at all.
  const top = { type: 'choice', choice: ids[0], confidence: 1, probabilities: Object.fromEntries(ids.map((k, i) => [k, i === 0 ? 1 : 0])) };
  const gated = await inspectChat({ ...input, gate: true }, async (_u, o) => {
    const b = JSON.parse(o.body); assert.equal(b.questions.new_task.type, 'noul');
    return new Response(JSON.stringify({ answers: { ...base, next_model: top, new_task: { type: 'noul', noul: 0.2 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  assert.deepEqual(gated.newTask, { yes: 0.2 });
  const missing = await inspectChat({ ...input, gate: true }, reply(top));
  assert.deepEqual([missing.ok, missing.reason], [false, 'JEV_INVALID_RESPONSE'], 'no invented gate answer');
  assert.equal(r.newTask, null, 'the gate question is only asked when requested');
});

test('prompt hook: #jev commands are recognized, normal prompts are not; focus round-trips', async (t) => {
  const { parseJevCommand, writeFocus, readFocus, formatResult } = await import('../dist/jev-hook.js');
  assert.equal(parseJevCommand('Mach weiter'), null);
  assert.equal(parseJevCommand('Bitte #jev nutzen'), null);
  assert.deepEqual(parseJevCommand('#jev'), { kind: 'analyze' });
  assert.deepEqual(parseJevCommand('  #JEV  Baue Tests '), { kind: 'once', task: 'Baue Tests' });
  assert.deepEqual(parseJevCommand('#jev? Sind die Tests grün?'), { kind: 'question', question: 'Sind die Tests grün?' });
  assert.deepEqual(parseJevCommand('#jev an'), { kind: 'guard', enabled: true });
  // The reported bug: "#jev an <Text>" was read as "#jev <Aufgabe>" and held back.
  assert.deepEqual(parseJevCommand('#jev an Ich kann Jev auch selber prüfen'), { kind: 'guard', enabled: true, rest: 'Ich kann Jev auch selber prüfen' });
  assert.deepEqual(parseJevCommand('#jev an: Baue X'), { kind: 'guard', enabled: true, rest: 'Baue X' });
  assert.deepEqual(parseJevCommand('#jev anpassen: Parser'), { kind: 'once', task: 'anpassen: Parser' });
  assert.deepEqual(parseJevCommand('#jev AUS'), { kind: 'guard', enabled: false });
  assert.deepEqual(parseJevCommand('#jev hilfe'), { kind: 'help' });
  assert.deepEqual(parseJevCommand('#jev Status'), { kind: 'status' });
  assert.deepEqual(parseJevCommand('#jev figur aus'), { kind: 'badge', action: 'aus' });
  assert.deepEqual(parseJevCommand('#jev Figur an'), { kind: 'badge', action: 'an' });
  assert.deepEqual(parseJevCommand('#jev figur test'), { kind: 'badge', action: 'test' });
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

test('guard mode: "#jev an <Text>" sends the text, and Jev itself decides which messages need a look', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'jev-guard-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, JEV_PANEL_HOME: dir, JEV_NO_USER_KEY: '1', AI_GATEWAY_API_KEY: '', JEV_CLAUDE_DESKTOP_SESSIONS: join(dir, 'none') };
  const run = (prompt) => spawnSync(process.execPath, ['dist/jev-hook.js'], { input: JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555', transcript_path: 'tests/fixtures/claude-session.jsonl', prompt }), env, encoding: 'utf8' });
  // Switched on AND the text goes through (it used to be held with only "edit prompt" left).
  const on = JSON.parse(run('#jev an Ich kann Jev auch selber prüfen lassen').stdout);
  assert.equal(on.decision, undefined);
  assert.equal(on.systemMessage, 'Jev ist für diesen Chat jetzt AN. Jev: keine Einschätzung (JEV_KEY_MISSING) – die Nachricht läuft normal.');
  assert.match(on.hookSpecificOutput.additionalContext, /„#jev an“ ist ein Befehl an das Jev-Plugin/);
  // No length rule of ours: every message goes to Jev, which answers "new task?" itself. Without a key: notice, never held.
  for (const p of ['ok danke', 'Baue bitte einen Parser für CSV-Dateien']) {
    const o = JSON.parse(run(p).stdout); assert.equal(o.decision, undefined); assert.match(o.systemMessage, /JEV_KEY_MISSING/);
  }
  assert.equal(run('/compact').stdout, '');
  const status = JSON.parse(run('#jev status').stdout).reason;
  assert.match(status, /Jev: {10}AN – prüft jede Nachricht selbst; ab 2 Stufen daneben wird einmal angehalten/);
  assert.match(status, /Jev-Figur: {4}an/);
  assert.match(JSON.parse(run('#jev figur aus').stdout).reason, /Jev-Figur ist AUS/);
  assert.match(JSON.parse(run('#jev status').stdout).reason, /Jev-Figur: {4}aus/);
  const off = JSON.parse(run('#jev aus und jetzt weiter').stdout);
  assert.deepEqual([off.decision, off.systemMessage], [undefined, 'Jev ist für diesen Chat jetzt AUS.']);
  assert.equal(run('Baue bitte einen Parser für CSV-Dateien').stdout, '');
  assert.match(JSON.parse(run('#jev an').stdout).reason, /für DIESEN Chat AN/);
  const once = JSON.parse(run('#jev Refaktoriere den Parser').stdout);
  assert.equal(once.decision, undefined); assert.match(once.hookSpecificOutput.additionalContext, /„#jev“ ist ein Befehl/);
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

test('Jev card by distance: fits gets a check mark, one step a note, two or more steps hold the message; models count capability tiers', async () => {
  const { assess, jevCard, recommendationLine, recommend, effortFor } = await import('../dist/jev-hook.js');
  const { CLAUDE_TIERS, codexTiers } = await import('../dist/chat-inspect.js');
  const j = (choice, probabilities) => ({ choice, confidence: 1, probabilities });
  const names = { 'claude-opus-5-5': 'Opus 5.5', 'claude-fable-5-1': 'Fable 5.1', 'claude-opus-5': 'Opus 5', 'claude-haiku-4-5': 'Haiku 4.5', 'gpt-6-astra': 'GPT-6-Astra' };
  const app = current => ({ kind: 'claude', name: 'Claude', tiers: CLAUDE_TIERS, candidates: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    readTurns: () => [], current: () => current, efforts: m => /haiku/.test(m) ? [] : ['low', 'medium', 'high', 'xhigh', 'max'], display: m => names[m] ?? String(m) });
  const answer = (kind, difficulty) => ({ ok: true, progress: j('advancing', { advancing: 1 }), blocker: j('none', { none: 1 }), next_step: j('continue', { continue: 1 }), question: null,
    nextModel: null, taskKind: j(kind, { [kind]: 1 }), difficulty: j(difficulty, { [difficulty]: 1 }), newTask: { yes: 0.9 },
    effort: j('xhigh', { xhigh: 0.6, high: 0.3, low: 0.1, medium: 0, max: 0, ultra: 0 }), stats: { mode: 'complete' }, usage: { input_tokens: 5, output_tokens: 1 } });
  const coding = answer('coding', 'normal');
  const card = current => { const a = app(current); const x = assess(coding, a); return { ...x, card: jevCard(x, a) }; };
  // Opus 5.5 · Mittel fits coding (its effort comes from the evidence for Opus 5.5, not Jev's generic xhigh).
  const fits = card({ model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual([fits.level, fits.card.text, fits.card.badge], ['fits', '✓ Jev (Coding, normal): Opus 5.5 · Mittel passt.', null]);
  // One step (Hoch instead of Mittel): a note; the message runs on and the Jev figure is offered.
  const one = card({ model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual([one.level, one.kind, one.effortSteps], ['note', 'effort', 1]);
  assert.deepEqual(one.card.text.split('\n'), [
    '⚙ JEV · EFFORT ÄNDERN – 1 STUFE ZU HOCH',
    'Hoch → Mittel (medium)',
    '○ Niedrig   ◆ Mittel   ● Hoch   ○ Extra hoch   ○ Max      ◆ empfohlen  ● eingestellt',
    'Opus 5.5 passt (Coding, normal).',
    'Unten rechts den Effort auf „Mittel“ stellen. Nur eine Empfehlung – noch nicht umgestellt. Die aktuelle Nachricht läuft weiter.']);
  assert.deepEqual(one.card.badge, { title: 'Effort → Mittel', body: 'Unten rechts umstellen · die Nachricht läuft weiter' });
  assert.match(card({ model: 'claude-opus-5-5', effort: 'low' }).card.text, /^⚙ JEV · EFFORT ÄNDERN – 1 STUFE ZU NIEDRIG/);
  // Three steps (Max instead of Mittel): held, with both ways forward.
  const three = card({ model: 'claude-opus-5-5', effort: 'max' });
  assert.deepEqual([three.level, three.effortSteps], ['stop', 3]);
  assert.equal(three.card.text.split('\n')[0], '⛔ JEV · ANGEHALTEN – EFFORT 3 STUFEN ZU HOCH');
  assert.match(three.card.text, /So geht's weiter: unten rechts den Effort auf „Mittel“ stellen und die Nachricht erneut senden\.\nOhne Umstellen erneut senden = sie läuft so, wie es gerade eingestellt ist\.$/);
  assert.equal(three.card.badge.body, 'Nachricht angehalten – umstellen, dann erneut senden');
  // Model one tier off (Fable 5.1 "Spitze" → Opus 5.5 "Stark" for coding): a note, with the benchmark reason.
  const fable = card({ model: 'claude-fable-5-1', effort: 'max' });
  assert.deepEqual([fable.level, fable.kind, fable.modelSteps], ['note', 'model', 1]);
  assert.deepEqual(fable.card.text.split('\n').slice(0, 3), ['⚙ JEV · MODELL: BESSERE WAHL', 'Fable 5.1 · Max → Opus 5.5 · Mittel   (Spitze → Stark)',
    'Grund: FrontierCode v1.1 Main: Opus 5.5 54,4 · Fable 5.1 50,3 – gleich gut, mind. 25 % günstiger.']);
  assert.equal(recommend(coding, app({ model: 'claude-fable-5-1', effort: 'max' })).interrupt, true);
  // Model two tiers off (Opus 5.5 "Stark" → Haiku 4.5 "Schnell" for a simple task): held.
  const simpleApp = app({ model: 'claude-opus-5-5', effort: 'medium' }), simple = assess(answer('simple', 'easy'), simpleApp);
  assert.deepEqual([simple.level, simple.kind, simple.modelSteps, simple.target], ['stop', 'model', 2, 'claude-haiku-4-5']);
  assert.deepEqual(jevCard(simple, simpleApp).text.split('\n').slice(0, 2), ['⛔ JEV · ANGEHALTEN – MODELL 2 STUFEN DANEBEN', 'Opus 5.5 · Mittel → Haiku 4.5   (Stark → Schnell)']);
  // A hard task gets one level above the model's sweet spot (Opus 5.5: Hoch), but never into the range rated "too much" (Fable 5.1 stays below Max).
  const hard = answer('coding', 'hard');
  assert.equal(assess(hard, app({ model: 'claude-opus-5-5', effort: 'high' })).level, 'fits');
  assert.equal(effortFor('claude-fable-5-1', answer('agentic', 'hard'), app({ model: 'claude-fable-5-1', effort: 'xhigh' })).effort, 'xhigh');
  assert.equal(effortFor('claude-fable-5-1', answer('agentic', 'normal'), app({ model: 'claude-fable-5-1', effort: 'xhigh' })).effort, 'xhigh');
  // Unknown setting: a plain recommendation, never a hold.
  assert.match(recommendationLine(coding, app({ model: null, effort: null })), /^Jev \(Coding, normal\): empfohlen .+ – die aktuelle Einstellung ist noch unbekannt\.$/);
  // Codex wording ("Denkaufwand", model menu) with the model's own levels, including ultra.
  const catalog = [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) },
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', supported_reasoning_levels: ['low', 'medium'].map(effort => ({ effort })) }];
  const codex = { kind: 'codex', name: 'Codex', tiers: codexTiers(catalog), candidates: ['gpt-6-astra', 'gpt-6-sol'], readTurns: () => [], current: () => ({ model: 'gpt-6-astra', effort: 'high' }),
    efforts: m => (catalog.find(c => c.slug === m)?.supported_reasoning_levels ?? []).map(l => l.effort), display: m => names[m] ?? String(m) };
  const cx = jevCard(assess(coding, codex), codex);
  assert.deepEqual(cx.text.split('\n'), [
    '⚙ JEV · DENKAUFWAND ÄNDERN – 1 STUFE ZU HOCH',
    'Hoch → Mittel (medium)',
    '○ Niedrig   ◆ Mittel   ● Hoch   ○ Extra hoch   ○ Max   ○ Ultra      ◆ empfohlen  ● eingestellt',
    'GPT-6-Astra passt (Coding, normal).',
    'Im Modellmenü den Denkaufwand auf „Mittel“ stellen. Nur eine Empfehlung – noch nicht umgestellt. Die aktuelle Nachricht läuft weiter.']);
  assert.deepEqual(cx.badge, { title: 'Denkaufwand → Mittel', body: 'Im Modellmenü umstellen · die Nachricht läuft weiter' });
});

test('a held message: the next send in that chat passes once within 15 minutes; the hook says so and asks Jev nothing', async (t) => {
  const { markHeld, takePass, PASS_WINDOW_MS } = await import('../dist/jev-hook.js');
  const { spawnSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'jev-held-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const s = '11111111-2222-4333-8444-555555555555';
  assert.equal(takePass(dir, s), false);
  markHeld(dir, s, 1000);
  assert.equal(takePass(dir, s, 1000 + PASS_WINDOW_MS - 1), true);
  assert.equal(takePass(dir, s, 2000), false, 'only once');
  markHeld(dir, s, 1000);
  assert.equal(takePass(dir, s, 1000 + PASS_WINDOW_MS + 1), false, 'expired');
  await writeFile(join(dir, 'guard.json'), JSON.stringify({ sessions: { [s]: true } }));
  markHeld(dir, s);
  const env = { ...process.env, JEV_PANEL_HOME: dir, JEV_NO_USER_KEY: '1', AI_GATEWAY_API_KEY: '', JEV_CLAUDE_DESKTOP_SESSIONS: join(dir, 'none') };
  const out = JSON.parse(spawnSync(process.execPath, ['dist/jev-hook.js'], { input: JSON.stringify({ session_id: s, transcript_path: 'tests/fixtures/claude-session.jsonl', prompt: 'Baue bitte einen Parser für CSV-Dateien' }), env, encoding: 'utf8' }).stdout);
  assert.deepEqual([out.decision, out.systemMessage], [undefined, 'Jev: Die angehaltene Nachricht geht jetzt durch.']);
});

test('Claude desktop: the chat\'s live menu setting comes from the app\'s session file (read-only)', async (t) => {
  const { claudeMenu } = await import('../dist/jev-hook.js');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'jev-desktop-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'acct', 'org'), { recursive: true });
  const a = '11111111-2222-4333-8444-555555555555', b = '22222222-2222-4333-8444-555555555555';
  await writeFile(join(root, 'acct', 'org', 'local_a.json'), JSON.stringify({ sessionId: 'local_a', cliSessionId: a, model: 'claude-opus-5-5', effort: 'max', title: 'x' }));
  await writeFile(join(root, 'acct', 'org', 'local_b.json'), JSON.stringify({ sessionId: 'local_b', cliSessionId: b, model: 'claude-sonnet-5', effort: 'low' }));
  assert.deepEqual(claudeMenu(a, root), { model: 'claude-opus-5-5', effort: 'max' });
  assert.deepEqual(claudeMenu(b, root), { model: 'claude-sonnet-5', effort: 'low' });
  assert.equal(claudeMenu('33333333-2222-4333-8444-555555555555', root), null);
  assert.equal(claudeMenu('keine-id', root), null);
  assert.equal(claudeMenu(a, join(root, 'fehlt')), null);
});

test('Claude transcript: the setting the latest reply really ran on', async (t) => {
  const { claudeSetting } = await import('../dist/jev-hook.js');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'jev-setting-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 's.jsonl');
  const reply = (model, extra) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] }, ...extra });
  await writeFile(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Aufgabe' } }),
    reply('claude-fable-5-1', { effort: 'max', perTurnEffort: 'max' }),
    reply('claude-opus-5-5', { effort: 'max', perTurnEffort: 'xhigh' }),
    reply('claude-haiku-4-5', { isSidechain: true, effort: 'low' }),
    reply('<synthetic>', {}),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Nächste Nachricht' } }),
  ].join('\n'));
  assert.deepEqual(claudeSetting(file), { model: 'claude-opus-5-5', effort: 'xhigh' }, 'per-turn effort wins, side agents and synthetic replies are skipped');
  assert.deepEqual(claudeSetting(join(dir, 'fehlt.jsonl')), { model: null, effort: null });
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
  // Codex coding on Sol: Astra leads by 4 points AND Sol is rated weak for coding by credible voices -> switch.
  const s = decideModel({ kind: 'coding', difficulty: 'hard', current: 'gpt-6-sol', candidates: codex });
  assert.deepEqual([s.recommended, s.interrupt, s.reason], ['gpt-6-astra', true, 'current-vetoed']);
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
  // No published comparable benchmark for Sonnet 5 -> the weighted spectrum decides; Opus 4.7 has neither -> none.
  assert.equal(decideModel({ kind: 'coding', difficulty: 'normal', current: 'claude-sonnet-5', candidates: claude }).basis, 'spectrum');
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

test('weighted spectrum: veto on benchmark picks, fallback where no benchmark exists, per-model effort', async () => {
  const { decideModel, spectrumEffort, spectrumKey, vetoed } = await import('../dist/model-policy.js');
  const claude = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  const codex = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'];
  assert.equal(spectrumKey('gpt-5.6-sol'), 'gpt-5-6-sol');
  assert.equal(spectrumKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(spectrumKey('fable[1m]'), 'claude-fable-5-1');
  // GPT-6 Sol is rated weak for research by many credible voices: never recommended there.
  assert.equal(vetoed('gpt-6-sol', 'research'), true);
  const r = decideModel({ kind: 'research', difficulty: 'easy', current: 'gpt-6-astra', candidates: codex });
  assert.notEqual(r.recommended, 'gpt-6-sol'); assert.ok(r.vetoedModels.includes('gpt-6-sol'));
  // Sonnet 5 has no comparable research benchmark: the spectrum decides (Opus 5.5 well ahead -> switch).
  const sp = decideModel({ kind: 'research', difficulty: 'normal', current: 'claude-sonnet-5', candidates: claude });
  assert.deepEqual([sp.basis, sp.recommended, sp.interrupt, sp.reason], ['spectrum', 'claude-opus-5-5', true, 'spectrum-gap']);
  // Sonnet 5 coding: Opus 5.5 is rated higher but by less than 30 points -> no interruption.
  const sc = decideModel({ kind: 'coding', difficulty: 'normal', current: 'claude-sonnet-5', candidates: claude });
  assert.deepEqual([sc.basis, sc.interrupt], ['spectrum', false]);
  // Effort differs per model.
  assert.equal(spectrumEffort('claude-opus-5-5', 'coding').effort, 'medium');
  assert.equal(spectrumEffort('claude-fable-5-1', 'coding').effort, 'xhigh');
  assert.equal(spectrumEffort('claude-fable-5-1', 'coding').avoidFrom, 'max');
  assert.equal(spectrumEffort('gpt-6-astra', 'agentic').effort, 'medium');
  assert.equal(spectrumEffort('claude-haiku-4-5-20251001', 'simple'), null);
});

