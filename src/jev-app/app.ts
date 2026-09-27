#!/usr/bin/env node
// Jev app: one local chat window for Claude Code and Codex. Jev picks agent, model and effort per
// message; a switch hands the full history over. Local only (127.0.0.1, per-user token), runs the
// official programs with the user's own sign-ins – no API key needed for the agents themselves.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CodexAppServer, resolveCodexBinary } from '../codex-app-server.js';
import { findClaudeSession, inspectChat, listClaudeSessions, readClaudeSession } from '../chat-inspect.js';
import { readCodexCatalog, type CodexCatalogModel } from '../codex-rollout.js';
import { gatewayKey } from '../gateway-key.js';
import { stateDirectory } from '../state-dir.js';
import type { HistoryTurn } from '../routing-context.js';
import { ConversationStore, isId, type AgentKind, type Conversation, type Message } from './store.js';
import { agentOf, candidates, chooseRoute, handover, labelOf, offeredEfforts, type Availability } from './route.js';
import { ClaudeRunner, CodexRunner, claudeReady, codexReady, type Approval, type Runner } from './runners.js';
import { APP_HTML } from './ui.js';

export type AppEvent = { type: string; conversationId?: string; [k: string]: unknown };
export type AppOptions = {
  stateDir: string; port?: number; token?: string;
  available?: () => Availability & { reasons?: Partial<Record<AgentKind, string | null>> };
  catalog?: () => CodexCatalogModel[]; key?: () => string | undefined; inspect?: typeof inspectChat;
  runner?: (agent: AgentKind) => Runner; approvalTimeoutMs?: number; defaultCwd?: string;
  codexCommand?: string[];
};

/** Existing chats as history turns → messages of a Jev conversation (commands and files go with the answer). */
export function turnsToMessages(turns: HistoryTurn[], agent: AgentKind): Omit<Message, 'id' | 'at'>[] {
  const out: Omit<Message, 'id' | 'at'>[] = [];
  for (const t of turns) {
    let activity: string[] = [];
    for (const i of t.items) {
      if (i.type === 'userMessage') out.push({ role: 'user', text: i.text });
      else if (i.type === 'agentMessage') { out.push({ role: 'assistant', agent, text: i.text, activity: activity.length ? activity : undefined }); activity = []; }
      else if (i.type === 'command') activity.push(`ausgeführt: ${i.command.slice(0, 200)}`);
      else if (i.type === 'fileChange') activity.push(...i.paths.map(p => `geändert: ${p}`));
      else if (i.type === 'tool') activity.push(`Werkzeug: ${i.name}`);
    }
  }
  return out;
}

export class JevAppEngine {
  readonly store: ConversationStore;
  private running = new Map<string, Runner>();
  private approvals = new Map<string, { conversationId: string; resolve: (d: 'accept' | 'decline') => void }>();
  constructor(private o: AppOptions, private emit: (e: AppEvent) => void) { this.store = new ConversationStore(o.stateDir); }

  isBusy(id: string) { return this.running.has(id); }
  available() { return this.o.available?.() ?? { claude: claudeReady().ready, codex: codexReady().ready }; }
  catalog() { return (this.o.catalog ?? readCodexCatalog)(); }

  resolveApproval(requestId: string, decision: 'accept' | 'decline') {
    const a = this.approvals.get(requestId); if (!a) return false;
    a.resolve(decision); return true;
  }
  stop(id: string) { this.running.get(id)?.interrupt(); }

  /** One message: Jev picks (or the user did), the chosen agent runs it with everything it has not seen yet. */
  async send(id: string, text: string, override: { model?: string | null; effort?: string | null } | null = null): Promise<void> {
    const c = this.store.get(id); if (!c) throw new Error('NOT_FOUND');
    if (this.running.has(id)) throw new Error('BUSY');
    if (!text.trim()) throw new Error('EMPTY');
    const placeholder: Runner = { run: async () => { throw new Error('unused'); }, interrupt: () => {} };
    this.running.set(id, placeholder);
    const emit = (e: { type: string; [k: string]: unknown }) => this.emit({ ...e, conversationId: id });
    try {
      const before: Conversation = { ...c, messages: [...c.messages] };
      emit({ type: 'user', message: this.store.add(c, { role: 'user', text }), title: c.title });
      emit({ type: 'phase', text: override?.model ? 'Starte …' : 'Jev wählt …' });
      const av = this.available();
      const route = await chooseRoute({ conversation: before, text, available: av, catalog: this.catalog(), key: (this.o.key ?? gatewayKey)(), override, inspect: this.o.inspect });
      const state = c.agents[route.agent];
      const { prompt, carried } = handover(before, route.agent, text);
      emit({ type: 'route', ...route, carried });
      const runner = (this.o.runner ?? ((a: AgentKind) => a === 'claude' ? new ClaudeRunner() : new CodexRunner(this.o.codexCommand)))(route.agent);
      this.running.set(id, runner);
      emit({ type: 'phase', text: `${labelOf(route.model)} arbeitet …` });
      const result = await runner.run({ cwd: c.cwd, sessionId: state?.sessionId ?? null, prompt, model: route.model, effort: route.effort, access: c.access }, {
        delta: t => emit({ type: 'delta', text: t }),
        activity: line => emit({ type: 'activity', line }),
        notice: t => emit({ type: 'notice', text: t }),
        approval: (a: Approval) => new Promise(done => {
          const requestId = randomUUID();
          const timer = setTimeout(() => { this.approvals.delete(requestId); done('decline'); }, this.o.approvalTimeoutMs ?? 600_000);
          this.approvals.set(requestId, { conversationId: id, resolve: d => { clearTimeout(timer); this.approvals.delete(requestId); emit({ type: 'approvalResolved', requestId, decision: d }); done(d); } });
          emit({ type: 'approval', requestId, ...a });
        }),
      });
      const fresh = this.store.get(id) ?? c;
      if (result.text || result.status === 'completed') {
        const msg = this.store.add(fresh, { role: 'assistant', agent: route.agent, model: result.servedModel ?? route.model, effort: route.effort, text: result.text || '(keine Textantwort)', activity: result.activity.length ? result.activity : undefined });
        emit({ type: 'assistant', message: msg });
      }
      if (result.sessionId && (result.status !== 'failed' || result.text)) { fresh.agents[route.agent] = { sessionId: result.sessionId, seenUpTo: fresh.messages.length }; this.store.save(fresh); }
      if (result.status !== 'completed') {
        const note = this.store.add(fresh, { role: 'note', text: result.status === 'interrupted' ? 'Angehalten.' : `Fehler bei ${labelOf(route.model)}: ${result.error ?? 'unbekannt'} – kein automatischer Neuversuch.` });
        emit({ type: 'note', message: note });
      }
    } catch (e) {
      const c2 = this.store.get(id);
      const message = e instanceof Error ? e.message : String(e);
      if (c2) emit({ type: 'note', message: this.store.add(c2, { role: 'note', text: `Nicht ausgeführt: ${message}` }) });
    } finally {
      for (const [rid, a] of this.approvals) if (a.conversationId === id) a.resolve('decline');
      this.running.delete(id);
      emit({ type: 'idle' });
    }
  }
}

function appToken(dir: string): string {
  const file = join(dir, 'app-token');
  try { const t = readFileSync(file, 'utf8').trim(); if (/^[a-f0-9]{48}$/.test(t)) return t; } catch {}
  mkdirSync(dir, { recursive: true });
  const t = randomBytes(24).toString('hex'); writeFileSync(file, t, { mode: 0o600 }); return t;
}

export async function startApp(o: AppOptions): Promise<{ server: Server; url: string; engine: JevAppEngine; close: () => Promise<void> }> {
  const token = o.token ?? appToken(o.stateDir);
  const clients = new Set<ServerResponse>();
  const emit = (e: AppEvent) => { for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`); };
  const engine = new JevAppEngine(o, emit);
  const codexCommand = o.codexCommand ?? [resolveCodexBinary()];
  const codexRead = async <T>(fn: (s: CodexAppServer) => Promise<T>): Promise<T> => {
    const s = new CodexAppServer(codexCommand);
    try { await s.initialize(); return await fn(s); } finally { await s.close().catch(() => {}); }
  };
  let availability: (Availability & { reasons?: Partial<Record<AgentKind, string | null>> }) | null = null;
  const checkAvailability = () => {
    if (o.available) return availability = o.available();
    const cl = claudeReady(), cx = codexReady();
    return availability = { claude: cl.ready, codex: cx.ready, reasons: { claude: cl.reason, codex: cx.reason } };
  };

  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const tokenOk = (v: unknown) => typeof v === 'string' && v.length === token.length && timingSafeEqual(Buffer.from(v), Buffer.from(token));
  const body = async (req: IncomingMessage): Promise<any> => { let raw = ''; for await (const ch of req) { raw += ch; if (raw.length > 400_000) throw new Error('TOO_LARGE'); } return raw ? JSON.parse(raw) : {}; };
  const folder = (p: unknown): string | null => { if (typeof p !== 'string' || !p.trim()) return null; const full = resolve(p.trim()); try { return statSync(full).isDirectory() ? full : null; } catch { return null; } };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return json(res, 403, { error: 'HOST' });
      if (req.method === 'GET' && url.pathname === '/') {
        if (!tokenOk(url.searchParams.get('t'))) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Jev: Zugangsschlüssel fehlt. Öffne die Adresse aus dem Startbefehl.'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'", 'x-frame-options': 'DENY' });
        return res.end(APP_HTML);
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!tokenOk(url.searchParams.get('t'))) return json(res, 403, { error: 'TOKEN' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
      if (!tokenOk(req.headers['x-jev-token'])) return json(res, 403, { error: 'TOKEN' });
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const av = url.searchParams.get('refresh') || !availability ? checkAvailability() : availability;
        const catalog = engine.catalog();
        const models = candidates(av, catalog).map(m => ({ id: m, label: labelOf(m), agent: agentOf(m), efforts: offeredEfforts(m, catalog) }));
        return json(res, 200, { available: av, conversations: engine.store.list().map(c => ({ ...c, busy: engine.isBusy(c.id) })), models, defaultCwd: o.defaultCwd ?? homedir() });
      }
      if (req.method === 'GET' && url.pathname === '/api/conversation') {
        const id = url.searchParams.get('id'); const c = isId(id) ? engine.store.get(id) : null;
        return c ? json(res, 200, { ...c, busy: engine.isBusy(c.id) }) : json(res, 404, { error: 'NOT_FOUND' });
      }
      if (req.method === 'GET' && url.pathname === '/api/chats') {
        const claude = listClaudeSessions(undefined, 25);
        const codex = await codexRead(s => s.call('thread/list', { limit: 25, sortKey: 'updated_at', useStateDbOnly: true })).then((l: any) => (l.data ?? []).map((t: any) => ({ kind: 'codex', id: t.id, title: t.name || String(t.preview ?? '').slice(0, 80) || t.id, updatedAt: (t.updatedAt ?? 0) * 1000, cwd: t.cwd ?? null }))).catch(() => []);
        return json(res, 200, { claude, codex });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'METHOD' });
      if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'CONTENT_TYPE' });
      const input = await body(req);
      if (url.pathname === '/api/conversation') {
        const cwd = folder(input.cwd); if (!cwd) return json(res, 400, { error: 'FOLDER_NOT_FOUND' });
        return json(res, 200, engine.store.create({ cwd, access: input.access === 'write' ? 'write' : 'read' }));
      }
      if (url.pathname === '/api/import') {
        if (!['claude', 'codex'].includes(input.kind) || !isId(input.id)) return json(res, 400, { error: 'INVALID' });
        let turns: HistoryTurn[]; let cwd = folder(input.cwd);
        if (input.kind === 'claude') { const p = findClaudeSession(input.id); if (!p) return json(res, 404, { error: 'CHAT_NOT_FOUND' }); turns = readClaudeSession(p); }
        else turns = (await codexRead(s => s.readHistory(input.id))).turns;
        cwd ??= folder(o.defaultCwd) ?? homedir();
        const c = engine.store.create({ cwd, access: 'read', title: String(input.title ?? '').slice(0, 60) || undefined, origin: { kind: input.kind, id: input.id, title: String(input.title ?? '') } });
        for (const m of turnsToMessages(turns, input.kind)) engine.store.add(c, m);
        return json(res, 200, { id: c.id, messages: c.messages.length });
      }
      if (url.pathname === '/api/send') {
        if (!isId(input.id) || typeof input.text !== 'string') return json(res, 400, { error: 'INVALID' });
        if (engine.isBusy(input.id)) return json(res, 409, { error: 'BUSY' });
        const override = typeof input.model === 'string' && input.model ? { model: input.model, effort: typeof input.effort === 'string' ? input.effort : null } : null;
        void engine.send(input.id, input.text, override).catch(e => emit({ type: 'note', conversationId: input.id, message: { role: 'note', text: `Nicht gesendet: ${e.message}` } }));
        return json(res, 202, { accepted: true });
      }
      if (url.pathname === '/api/access') {
        const c = isId(input.id) ? engine.store.get(input.id) : null; if (!c) return json(res, 404, { error: 'NOT_FOUND' });
        if (engine.isBusy(c.id)) return json(res, 409, { error: 'BUSY' });
        c.access = input.access === 'write' ? 'write' : 'read'; engine.store.save(c); return json(res, 200, { access: c.access });
      }
      if (url.pathname === '/api/approval') return json(res, engine.resolveApproval(String(input.requestId), input.decision === 'accept' ? 'accept' : 'decline') ? 200 : 404, {});
      if (url.pathname === '/api/stop') { if (isId(input.id)) engine.stop(input.id); return json(res, 200, {}); }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return json(res, message === 'BUSY' ? 409 : 500, { error: message });
    }
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(o.port ?? 47831, '127.0.0.1', () => ok()); });
  const port = (server.address() as { port: number }).port;
  const close = async () => { for (const c of clients) c.end(); await new Promise<void>(r => server.close(() => r())); };
  return { server, url: `http://127.0.0.1:${port}/?t=${token}`, engine, close };
}

/** Opens the app in its own window (Edge app mode: no address bar), else the default browser. */
function openWindow(url: string) {
  if (process.platform === 'win32') {
    const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
    if (edge) { spawn(edge, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref(); return; }
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return;
  }
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) { console.log('Jev-App – ein Chat für Claude Code und Codex; Jev wählt Modell und Effort.\njev-app [--cwd ORDNER] [--port 47831] [--no-open]'); return; }
  const at = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const { url } = await startApp({ stateDir: stateDirectory(), port: Number(at('--port') ?? 47831), defaultCwd: at('--cwd') ?? process.cwd() });
  console.log(`Jev-App läuft: ${url}\nBeenden mit Strg+C.`);
  if (!argv.includes('--no-open')) openWindow(url);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(e => { console.error(`Jev-App konnte nicht starten: ${e.message}`); process.exitCode = 1; });
