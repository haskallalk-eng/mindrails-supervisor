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
