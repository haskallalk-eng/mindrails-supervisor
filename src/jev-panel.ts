#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CodexAppServer, resolveCodexBinary } from './codex-app-server.js';
import { JevPanelSession, isThreadId, type PanelEvent } from './jev-panel-session.js';
import { PANEL_HTML } from './jev-panel-ui.js';
import { CLAUDE_MODELS, findClaudeSession, inspectChat, inspectLabels, listClaudeSessions, readClaudeSession, type ModelOption } from './chat-inspect.js';
import { gatewayKey } from './jev.js';
import type { routeModel } from './model-router.js';
import { describeContext } from './routing-context.js';
import { readFocus } from './jev-hook.js';

export type PanelOptions = {
  codex: string[]; cwd: string; threadId?: string | null; write: boolean; port: number; stateDir: string;
  token?: string; key?: () => string | undefined; route?: typeof routeModel; contextBudget?: number; inspect?: typeof inspectChat;
};

export function stateDirectory(): string {
  return process.env.JEV_PANEL_HOME ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'mindrails-jev') : join(homedir(), '.mindrails-jev'));
}

/** Stable per-user token so a bookmarked panel address keeps working across restarts. */
function panelToken(dir: string): string {
  const file = join(dir, 'panel-token');
  try { const t = readFileSync(file, 'utf8').trim(); if (/^[a-f0-9]{48}$/.test(t)) return t; } catch {}
  mkdirSync(dir, { recursive: true });
  const t = randomBytes(24).toString('hex'); writeFileSync(file, t, { mode: 0o600 }); return t;
}

export async function startPanel(o: PanelOptions): Promise<{ server: Server; url: string; session: JevPanelSession; close: () => Promise<void> }> {
  const token = o.token ?? panelToken(o.stateDir);
  const events: PanelEvent[] = []; let seq = 0;
  const clients = new Set<ServerResponse>();
  let title: string | null = null;
  const emit = (event: PanelEvent) => {
    const e: PanelEvent = { ...event, seq: ++seq, at: Date.now() };
    if (e.type === 'thread' && typeof e.title === 'string') title = e.title;
    if (e.type !== 'delta') { events.push(e); if (events.length > 2000) events.splice(0, events.length - 2000); }
    for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const session = new JevPanelSession({
    codex: o.codex, cwd: o.cwd, threadId: o.threadId ?? null, write: o.write, lockDir: join(o.stateDir, 'locks'),
    key: o.key ?? gatewayKey, route: o.route, emit, contextBudget: o.contextBudget,
  });

  const readOnly = async <T>(fn: (s: CodexAppServer) => Promise<T>): Promise<T> => {
    const s = new CodexAppServer(o.codex);
    try { await s.initialize(); return await fn(s); } finally { await s.close().catch(() => {}); }
  };
  // Shows recent history; reading does not need the conversation writer.
  const loadHistory = async () => {
    if (!session.threadId) { emit({ type: 'history', turns: [], total: 0 }); title = null; return; }
    const id = session.threadId;
    const { thread, page } = await readOnly(async s => ({
      thread: (await s.call('thread/read', { threadId: id, includeTurns: false })).thread,
      page: await s.call('thread/turns/list', { threadId: id, limit: 6, sortDirection: 'desc', itemsView: 'summary' }),
    }));
    title = thread?.name ?? thread?.preview ?? null;
    const turns = (page.data ?? []).reverse().map((t: any) => ({
      status: t.status,
      user: (t.items ?? []).filter((i: any) => i.type === 'userMessage').flatMap((i: any) => (i.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text)).join('\n').slice(0, 4000),
      agent: ((t.items ?? []).filter((i: any) => i.type === 'agentMessage').at(-1)?.text ?? '').slice(0, 8000),
    }));
    emit({ type: 'history', turns, total: page.nextCursor ? turns.length + 1 : turns.length });
    emit({ type: 'thread', threadId: id, title, cwd: thread?.cwd, model: thread?.model });
  };

  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const tokenOk = (value: unknown) => typeof value === 'string' && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const body = async (req: IncomingMessage): Promise<any> => {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 400_000) throw new Error('TOO_LARGE'); }
    return raw ? JSON.parse(raw) : {};
  };

  let port = o.port;
  let inspecting = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // DNS-rebinding guard: only loopback host names are served.
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return json(res, 403, { error: 'HOST' });
      if (req.method === 'GET' && url.pathname === '/') {
        if (!tokenOk(url.searchParams.get('t'))) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Jev-Seitenfeld: Token fehlt. Öffne die Adresse aus dem Startbefehl.'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'", 'x-frame-options': 'DENY' });
        return res.end(PANEL_HTML);
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!tokenOk(url.searchParams.get('t'))) return json(res, 403, { error: 'TOKEN' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const after = Number(url.searchParams.get('after') ?? 0);
        for (const e of events) if ((e.seq ?? 0) > after) res.write(`data: ${JSON.stringify(e)}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res));
        return;
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
      if (!tokenOk(req.headers['x-jev-token'])) return json(res, 403, { error: 'TOKEN' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { threadId: session.threadId, title, cwd: o.cwd, write: o.write, busy: session.busy });
      if (req.method === 'GET' && url.pathname === '/api/threads') {
        const list = await readOnly(s => s.call('thread/list', { limit: 40, sortKey: 'updated_at', useStateDbOnly: true }));
        return json(res, 200, { current: session.threadId, threads: (list.data ?? []).map((t: any) => ({ id: t.id, name: t.name, preview: String(t.preview ?? '').slice(0, 80), cwd: t.cwd })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/sources') {
        const codex = await readOnly(s => s.call('thread/list', { limit: 30, sortKey: 'updated_at', useStateDbOnly: true }));
        return json(res, 200, { labels: inspectLabels, claude: listClaudeSessions(), codex: (codex.data ?? []).map((t: any) => ({ kind: 'codex', id: t.id, title: t.name || String(t.preview ?? '').slice(0, 80) || t.id, updatedAt: (t.updatedAt ?? 0) * 1000, cwd: t.cwd })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/current') {
        // The panel cannot see which chat window is focused; the most recently updated chat is the best available signal.
        const [claude] = listClaudeSessions(undefined, 1);
        const codexList = await readOnly(s => s.call('thread/list', { limit: 1, sortKey: 'updated_at', useStateDbOnly: true })).catch(() => ({ data: [] }));
        const t = codexList.data?.[0];
        const codex = t ? { kind: 'codex', id: t.id, title: t.name || String(t.preview ?? '').slice(0, 80) || t.id, updatedAt: (t.updatedAt ?? 0) * 1000 } : null;
        let current: any = [claude, codex].filter(Boolean).sort((a: any, b: any) => b.updatedAt - a.updatedAt)[0] ?? null;
        if (current) current.via = 'updated';
        // Preferred: the chat you last typed in, reported by the Claude Code / Codex prompt hooks.
        const focus = readFocus(o.stateDir);
        if (focus && Date.now() - focus.at < 12 * 3600_000) {
          let title: string | null = null, updatedAt = focus.at;
          if (focus.kind === 'claude') { const s = listClaudeSessions(undefined, 60).find(x => x.id === focus.id); title = s?.title ?? null; updatedAt = s?.updatedAt ?? focus.at; }
          else { const t = await readOnly(s => s.call('thread/read', { threadId: focus.id, includeTurns: false })).catch(() => null); title = t?.thread?.name || t?.thread?.preview || null; updatedAt = (t?.thread?.updatedAt ?? 0) * 1000 || focus.at; }
          current = { kind: focus.kind, id: focus.id, title: title ?? focus.id, updatedAt, typedAt: focus.at, via: 'typed' };
        }
        return json(res, 200, { current, now: Date.now() });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'METHOD' });
      if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'CONTENT_TYPE' });
      const input = await body(req);
      if (url.pathname === '/api/send') {
        if (typeof input.text !== 'string' || typeof input.clientMessageId !== 'string' || input.clientMessageId.length > 100) return json(res, 400, { error: 'INVALID' });
        if (session.busy) return json(res, 409, { error: 'BUSY' });
        if (session.isDuplicate(input.clientMessageId)) return json(res, 409, { error: 'DUPLICATE' });
        const run = session.send(input.text, input.clientMessageId);
        run.catch(e => emit({ type: 'error', message: `Nicht gesendet: ${e.message}` }));
        emit({ type: 'busy' });
        return json(res, 202, { accepted: true });
      }
      if (url.pathname === '/api/inspect') {
        if (!isThreadId(input.id) || !['claude', 'codex'].includes(input.kind) || (input.question != null && typeof input.question !== 'string') || (input.task != null && typeof input.task !== 'string')) return json(res, 400, { error: 'INVALID' });
        if (inspecting) return json(res, 409, { error: 'BUSY' });
        inspecting = true;
        try {
          let turns, olderUnread = false;
          if (input.kind === 'claude') { const path = findClaudeSession(input.id); if (!path) return json(res, 404, { error: 'CHAT_NOT_FOUND' }); turns = readClaudeSession(path); }
          else ({ turns, olderUnread } = await readOnly(s => s.readHistory(input.id)));
          let models: ModelOption[] | undefined;
          if (input.task) models = input.kind === 'claude' ? CLAUDE_MODELS : (await readOnly(s => s.listModels())).map(m => ({ id: m.model, label: m.model.replace('gpt-6-', '').replace(/^./, c => c.toUpperCase()), description: m.description }));
          const result = await (o.inspect ?? inspectChat)({ turns, olderUnread, question: input.question ?? undefined, task: input.task ?? undefined, models, key: (o.key ?? gatewayKey)(), source: input.kind === 'claude' ? 'Claude Code session' : 'Codex conversation' });
          return json(res, 200, { ...result, description: result.stats ? describeContext(result.stats) : null, models: models ?? null });
        } finally { inspecting = false; }
      }
      if (url.pathname === '/api/approval') return json(res, session.resolveApproval(String(input.requestId), input.decision === 'accept' ? 'accept' : 'decline') ? 200 : 404, {});
      if (url.pathname === '/api/stop') { await session.interrupt(); return json(res, 200, {}); }
      if (url.pathname === '/api/thread') {
        if (session.busy) return json(res, 409, { error: 'BUSY' });
        if (input.threadId !== null && !isThreadId(input.threadId)) return json(res, 400, { error: 'INVALID_THREAD_ID' });
        session.selectThread(input.threadId); await loadHistory(); return json(res, 200, { threadId: session.threadId });
      }
      if (url.pathname === '/api/fork') {
        if (session.busy) return json(res, 409, { error: 'BUSY' });
        return json(res, 200, { threadId: await session.fork() });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return json(res, message === 'BUSY' || message === 'DUPLICATE' ? 409 : 500, { error: message });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  port = (server.address() as { port: number }).port;
  loadHistory().catch(e => emit({ type: 'error', message: `Verlauf nicht lesbar: ${e.message}` }));
  const close = async () => { for (const c of clients) c.end(); await new Promise<void>(r => server.close(() => r())); };
  return { server, url: `http://127.0.0.1:${port}/?t=${token}`, session, close };
}

function parseArgs(argv: string[]) {
  const out = { threadId: null as string | null, cwd: process.cwd(), write: false, port: 47821, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--thread') { out.threadId = argv[++i] ?? null; if (!isThreadId(out.threadId)) throw new Error('INVALID_THREAD_ID'); }
    else if (a === '--cwd') out.cwd = argv[++i] ?? out.cwd;
    else if (a === '--workspace-write') out.write = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--no-open') out.open = false;
    else throw new Error(`UNKNOWN_ARGUMENT ${a}`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('INVALID_PORT');
  return out;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Jev-Seitenfeld – lokales Eingabefeld mit Modellrouting vor jeder Nachricht\njev-panel [--thread UUID] [--cwd PFAD] [--workspace-write] [--port 47821] [--no-open]\nÖffne die ausgegebene Adresse im In-App-Browser von Codex neben dem Chat.\n--workspace-write gilt nur für neu angelegte Gespräche; fortgesetzte Gespräche behalten ihre eigenen Codex-Berechtigungen.');
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const codex = [resolveCodexBinary()];
  const { url } = await startPanel({ codex, cwd: args.cwd, threadId: args.threadId, write: args.write, port: args.port, stateDir: stateDirectory() });
  console.log(`Jev-Seitenfeld läuft: ${url}\nIn Codex: Adresse im In-App-Browser öffnen (neben dem Chat). Beenden mit Strg+C.`);
  if (args.open) {
    if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(e => { console.error(`Jev-Seitenfeld konnte nicht starten: ${e.message}`); process.exitCode = 1; });
