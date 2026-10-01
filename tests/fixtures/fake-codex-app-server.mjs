// Minimal stand-in for `codex app-server --stdio` used by the panel tests.
// State persists in FAKE_STATE across processes, like Codex's rollout files.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const stateFile = process.env.FAKE_STATE, logFile = process.env.FAKE_LOG;
const load = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { threads: {}, writerLocked: [] };
const save = s => writeFileSync(stateFile, JSON.stringify(s));
const log = entry => appendFileSync(logFile, JSON.stringify(entry) + '\n');
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const models = ['astra', 'sol', 'luna'].map(t => ({ id: `gpt-6-${t}`, model: `gpt-6-${t}`, description: t, defaultReasoningEffort: t === 'luna' ? 'low' : 'medium', isDefault: t === 'astra', hidden: false }));
let pendingApproval = null;
const threadView = (id, t) => ({ id, name: t.name ?? null, preview: t.turns[0]?.user ?? '', cwd: t.cwd, model: t.model, status: { type: 'idle' } });
const turnView = (t, full) => ({ id: t.id, status: 'completed', itemsView: full ? 'full' : 'summary', error: null, items: [
  { type: 'userMessage', id: t.id + 'u', content: [{ type: 'text', text: t.user }] },
  ...(full && t.command ? [{ type: 'commandExecution', id: t.id + 'c', command: t.command, exitCode: 1, status: 'failed' }] : []),
  { type: 'agentMessage', id: t.id + 'a', text: t.agent } ] });

createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) { log({ approvalResponse: msg.result ?? msg.error }); pendingApproval?.(msg.result); return; }
  if (!msg.method || msg.id === undefined) return;
  const s = load(), p = msg.params ?? {};
  log({ method: msg.method, params: p });
  const reply = result => send({ id: msg.id, result }), fail = message => send({ id: msg.id, error: { code: -32600, message } });
  switch (msg.method) {
    case 'initialize': return reply({});
    case 'model/list': return reply({ data: models, nextCursor: null });
    case 'thread/list': return reply({ data: Object.entries(s.threads).map(([id, t]) => threadView(id, t)), nextCursor: null });
    case 'thread/read': return s.threads[p.threadId] ? reply({ thread: threadView(p.threadId, s.threads[p.threadId]) }) : fail('thread not found');
    case 'thread/resume': {
      if (s.writerLocked.includes(p.threadId)) return fail(`thread ${p.threadId} already has an active writer`);
      const t = s.threads[p.threadId]; if (!t) return fail('thread not found');
      return reply({ thread: threadView(p.threadId, t), model: t.model, cwd: t.cwd, reasoningEffort: 'medium' });
    }
    case 'thread/start': { const id = randomUUID(); s.threads[id] = { cwd: p.cwd, model: 'gpt-6-astra', sandbox: p.sandbox, turns: [] }; save(s); return reply({ thread: threadView(id, s.threads[id]), model: 'gpt-6-astra', cwd: p.cwd }); }
    case 'thread/fork': { const id = randomUUID(); s.threads[id] = { ...s.threads[p.threadId], forkedFrom: p.threadId }; save(s); return reply({ thread: threadView(id, s.threads[id]), model: s.threads[id].model, cwd: s.threads[id].cwd }); }
    case 'thread/turns/list': {
      const t = s.threads[p.threadId]; if (!t) return fail('thread not found');
      const all = [...t.turns].reverse(); const start = Number(p.cursor ?? 0); const page = all.slice(start, start + p.limit);
      return reply({ data: page.map(x => turnView(x, p.itemsView === 'full')), nextCursor: start + p.limit < all.length ? String(start + p.limit) : null });
    }
    case 'turn/start': {
      const t = s.threads[p.threadId]; const text = p.input[0].text; const turnId = randomUUID();
      reply({ turn: { id: turnId, items: [], status: 'inProgress' } });
      const finish = decision => {
        const answer = `Antwort von ${p.model}${decision ? ` (Freigabe: ${decision})` : ''}`;
        send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId, itemId: 'm1', delta: answer } });
        send({ method: 'item/completed', params: { threadId: p.threadId, turnId, item: { type: 'agentMessage', id: 'm1', text: answer } } });
        const fresh = load(); fresh.threads[p.threadId].model = p.model; fresh.threads[p.threadId].turns.push({ id: turnId, user: text, agent: answer }); save(fresh);
        setTimeout(() => send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'completed', items: [], error: null, durationMs: 5 } } }), Number(process.env.FAKE_TURN_MS ?? 20));
      };
      if (text.includes('APPROVAL')) { pendingApproval = r => finish(r?.decision); send({ id: 'appr-1', method: 'item/commandExecution/requestApproval', params: { threadId: p.threadId, turnId, itemId: 'c1', command: 'rm -rf build', reason: 'test' } }); }
      else finish();
      return;
    }
    case 'turn/interrupt': return reply({});
    default: return fail(`unsupported ${msg.method}`);
  }
});
