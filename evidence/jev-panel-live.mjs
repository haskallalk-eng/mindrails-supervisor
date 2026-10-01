// Live end-to-end check of the Jev side panel against the real Codex app-server
// and real Jev (Vercel AI Gateway). Uses a throwaway project directory for all
// executions. The long-history check only READS the given conversation and asks
// Jev once; it never executes a turn there. Costs: a few small Jev calls and
// Codex turns. Usage: node evidence/jev-panel-live.mjs [LONG_THREAD_ID]
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPanel } from '../dist/jev-panel.js';
import { CodexAppServer, resolveCodexBinary } from '../dist/codex-app-server.js';
import { buildRoutingContext, describeContext } from '../dist/routing-context.js';
import { routeModel } from '../dist/model-router.js';
import { gatewayKey } from '../dist/jev.js';

const codex = [resolveCodexBinary()];
const key = gatewayKey();
if (!key) throw new Error('AI_GATEWAY_API_KEY missing');
const work = await mkdtemp(join(tmpdir(), 'jev-panel-live-'));
const stateDir = join(work, '.state');
const report = { timestamp: new Date().toISOString(), codex: 'desktop-bundled CLI', steps: [] };

async function openPanel(opts) {
  const p = await startPanel({ codex, cwd: work, write: false, port: 0, stateDir, token: 'b'.repeat(48), key: () => key, ...opts });
  const base = p.url.split('/?')[0], events = [];
  const res = await fetch(`${base}/api/events?t=${'b'.repeat(48)}`); const reader = res.body.getReader(); let buf = '';
  (async () => { try { while (true) { const { done, value } = await reader.read(); if (done) break; buf += Buffer.from(value).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { events.push(JSON.parse(buf.slice(6, i))); buf = buf.slice(i + 2); } } } catch {} })();
  const send = async text => {
    const id = crypto.randomUUID(); const from = events.length; const t0 = Date.now();
    const r = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'x-jev-token': 'b'.repeat(48), 'content-type': 'application/json' }, body: JSON.stringify({ text, clientMessageId: id }) });
    if (r.status !== 202) return { http: r.status };
    while (!events.slice(from).some(e => e.type === 'idle')) await new Promise(r => setTimeout(r, 100));
    const ev = events.slice(from).filter(e => e.type !== 'delta');
    const d = ev.find(e => e.type === 'decision');
    return { ms: Date.now() - t0, threadId: p.session.threadId,
      context: ev.find(e => e.type === 'context')?.description ?? null,
      decision: d ? { model: d.model, source: d.source, reason: d.reason ?? null, probabilities: d.probabilities, baseline: d.baseline, effort: d.effort, usage: d.usage ?? null } : null,
      answer: ev.filter(e => e.type === 'agent').map(e => e.text).join('\n').slice(0, 600),
      turn: ev.find(e => e.type === 'turn')?.status ?? null,
      blocked: ev.find(e => e.type === 'blocked')?.reason ?? null,
      errors: ev.filter(e => e.type === 'error' || e.type === 'notice').map(e => e.message) };
  };
  return { p, send, close: async () => { await reader.cancel().catch(() => {}); await p.close(); } };
}

// 1+2: new conversation, then a follow-up in the same conversation (new process, resume).
let panel = await openPanel({});
report.steps.push({ step: 'first message (new conversation)', ...await panel.send('Antworte ausschließlich mit PANEL_OK_1. Verwende keine Tools und ändere keine Dateien.') });
report.steps.push({ step: 'follow-up, same conversation', ...await panel.send('Folgefrage zum selben Gespräch: Welche Invariante garantiert ein Fencing-Token bei einem Lease-basierten verteilten Lock, und kann Uhrenversatz sie verletzen? Höchstens drei Sätze. Keine Tools, keine Dateiänderungen.') });
const threadId = panel.p.session.threadId;
await panel.close();

// 3: Jev outage (invalid key) — baseline model, visible reason, no retry, still executes.
panel = await openPanel({ threadId, key: () => 'invalid-test-key' });
report.steps.push({ step: 'Jev outage (invalid key), same conversation', ...await panel.send('Antworte ausschließlich mit PANEL_OK_3. Keine Tools.') });
await panel.close();

// 4: another process holds the conversation writer (as the Codex app does) — must be blocked, not written.
const holder = new CodexAppServer(codex); await holder.initialize();
await holder.call('thread/resume', { threadId, excludeTurns: true });
panel = await openPanel({ threadId });
report.steps.push({ step: 'conversation held by another Codex process', ...await panel.send('Antworte ausschließlich mit PANEL_SHOULD_NOT_RUN.') });
await panel.close(); await holder.close();

// 5: history check — all turns are in the conversation, in order, with the models used.
const reader = new CodexAppServer(codex); await reader.initialize();
const history = await reader.readHistory(threadId);
report.conversation = { threadId, turns: history.turns.map(t => ({ user: t.items.find(i => i.type === 'userMessage')?.text.slice(0, 60), answer: t.items.filter(i => i.type === 'agentMessage').at(-1)?.text.slice(0, 80) })) };

// 6: long real conversation — read only, build the context, ask Jev once, do not execute.
const longId = process.argv[2];
if (longId) {
  const t0 = Date.now();
  const long = await reader.readHistory(longId);
  const built = buildRoutingContext(long.turns, { olderUnread: long.olderUnread });
  const models = await reader.listModels();
  const decision = await routeModel({ task: 'Setze die Arbeit am Jev-Seitenfeld fort: prüfe den offenen Punkt aus dem letzten Turn.', context: built.context, models, baseline: 'gpt-6-astra', key });
  report.longHistory = { threadId: longId, readMs: Date.now() - t0, stats: built.stats, description: describeContext(built.stats), decision: { model: decision.model, source: decision.source, reason: decision.reason ?? null, probabilities: decision.probabilities, usage: decision.usage ?? null }, executed: false };
}
await reader.close();

await mkdir('evidence/results', { recursive: true });
const out = `evidence/results/jev-panel-live-${report.timestamp.slice(0, 10)}.json`;
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2)); console.log('written', out);
process.exit(0);
