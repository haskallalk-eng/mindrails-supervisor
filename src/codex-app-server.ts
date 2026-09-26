import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { modelSchema, type RoutingModel } from './model-router.js';
import { toHistoryTurn, type HistoryTurn } from './routing-context.js';

export class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }
type ServerRequest = { id: number | string; method: string; params: any };

/**
 * One short-lived `codex app-server --stdio` connection. Codex allows only one
 * writer per conversation across processes, so a connection is opened per
 * message and closed right after the turn to hand the conversation back.
 */
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  /** Resolves when the Codex process ends for any reason. */
  readonly exited: Promise<void>;
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (request: ServerRequest) => Promise<unknown> = async () => { throw new RpcError(-32601, 'NOT_SUPPORTED'); };

  /** command: the Codex executable, optionally followed by fixed leading arguments. */
  constructor(command: string[]) {
    const [binary, ...prefix] = command;
    if (!binary) throw new Error('CODEX_BINARY_MISSING');
    this.child = spawn(binary, [...prefix, 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'error', MINDRAILS_JEV_AUTO_REVIEW: '0' } });
    this.child.stderr.resume();
    this.exited = new Promise(resolve => { this.child.once('exit', () => resolve()); this.child.once('error', () => resolve()); });
    const fail = () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('CODEX_APP_SERVER_CLOSED')); this.pending.clear(); };
    this.child.on('error', fail); this.child.on('exit', fail); this.child.stdin.on('error', fail);
    createInterface({ input: this.child.stdout }).on('line', line => {
      let msg: any; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id !== undefined) { void this.answer(msg); return; }
      if (msg.method) { this.onNotification(msg.method, msg.params); return; }
      const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
      msg.error ? p.reject(new RpcError(msg.error.code ?? -1, String(msg.error.message ?? 'CODEX_RPC_FAILED'))) : p.resolve(msg.result);
    });
  }

  private async answer(req: ServerRequest) {
    try { this.write({ id: req.id, result: await this.onRequest(req) }); }
    catch (e) { this.write({ id: req.id, error: { code: e instanceof RpcError ? e.code : -32000, message: e instanceof Error ? e.message : 'DECLINED' } }); }
  }
  private write(msg: object) { if (!this.closed) this.child.stdin.write(JSON.stringify(msg) + '\n'); }

  call<T = any>(method: string, params: object, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CODEX_APP_SERVER_CLOSED'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CODEX_RPC_TIMEOUT ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.write({ id, method, params });
    });
  }

  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'jev_panel', version: '0.2.0' } }, 20_000);
    this.write({ method: 'initialized' });
  }

  async listModels(): Promise<RoutingModel[]> {
    const models: RoutingModel[] = []; let cursor: string | null = null; let pages = 0;
    do {
      const page: any = await this.call('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }, 20_000);
      for (const entry of page.data ?? []) { if (entry.hidden) continue; const parsed = modelSchema.safeParse(entry); if (parsed.success) models.push(parsed.data); }
      cursor = page.nextCursor ?? null;
      if (++pages > 10) throw new Error('INVALID_MODEL_CATALOG');
    } while (cursor);
    if (!models.length) throw new Error('NO_GPT6_MODELS_AVAILABLE');
    return models;
  }

  /**
   * Reads visible history oldest-first: every turn in the compact summary view
   * (user message + final answer) and the most recent turns in full view so
   * commands, failures and changed files are available.
   */
  async readHistory(threadId: string, { fullRecent = 3, maxPages = 50 } = {}): Promise<{ turns: HistoryTurn[]; olderUnread: boolean }> {
    const summary: any[] = []; let cursor: string | null = null; let pages = 0;
    do {
      const page: any = await this.call('thread/turns/list', { threadId, limit: 200, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}) });
      summary.push(...(page.data ?? [])); cursor = page.nextCursor ?? null;
    } while (cursor && ++pages < maxPages);
    const full: any = fullRecent ? await this.call('thread/turns/list', { threadId, limit: fullRecent, sortDirection: 'desc', itemsView: 'full' }) : { data: [] };
    const byId = new Map<string, any>((full.data ?? []).map((t: any) => [t.id, t]));
    const turns = summary.map(t => toHistoryTurn(byId.get(t.id) ?? t)).reverse();
    return { turns, olderUnread: Boolean(cursor) };
  }

  /** Graceful close: ending stdin lets Codex release the conversation writer. */
  async close(timeoutMs = 10_000) {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), timeoutMs);
    await this.exited; clearTimeout(timer);
  }
}

/** JEV_CODEX_BIN, else the Codex desktop's bundled CLI (newest), else `codex` on PATH. */
export function resolveCodexBinary(): string {
  if (process.env.JEV_CODEX_BIN) return process.env.JEV_CODEX_BIN;
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (root) try {
    const found = readdirSync(root).map(d => join(root, d, 'codex.exe')).filter(p => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (found[0]) return found[0];
  } catch {}
  return 'codex';
}

export const isWriterConflict = (e: unknown) => e instanceof Error && /active writer/i.test(e.message);
