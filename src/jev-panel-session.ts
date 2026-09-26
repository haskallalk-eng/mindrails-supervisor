import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAppServer, isWriterConflict, RpcError } from './codex-app-server.js';
import { routeModel, type RouteDecision, type RoutingModel } from './model-router.js';
import { buildRoutingContext, describeContext, type ContextStats } from './routing-context.js';

export type PanelEvent = { seq?: number; at?: number; type: string; [key: string]: unknown };
type Approval = { resolve: (decision: 'accept' | 'decline') => void; timer: NodeJS.Timeout };

export type SessionOptions = {
  codex: string[]; cwd: string; threadId?: string | null; write: boolean; lockDir: string;
  key: () => string | undefined; route?: typeof routeModel; emit: (event: PanelEvent) => void;
  approvalTimeoutMs?: number; contextBudget?: number;
};

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isThreadId = (value: unknown): value is string => typeof value === 'string' && THREAD_ID.test(value);

/** Cross-process lock so two panels (or two tabs of one) never run the same conversation at once. */
export function acquireLock(dir: string, key: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${key}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx'); writeSync(fd, String(process.pid)); closeSync(fd);
      let released = false;
      return () => { if (!released) { released = true; try { unlinkSync(file); } catch {} } };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(file, 'utf8'));
      let alive = false; try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch (err: any) { alive = err?.code === 'EPERM'; }
      if (alive) throw new Error('CONVERSATION_LOCKED');
      try { unlinkSync(file); } catch {}
    }
  }
  throw new Error('CONVERSATION_LOCKED');
}

export class JevPanelSession {
  threadId: string | null;
  busy = false;
  private server: CodexAppServer | null = null;
  private turnId: string | null = null;
  private approvals = new Map<string, Approval>();
  private seenMessages = new Set<string>();

  constructor(private o: SessionOptions) { this.threadId = o.threadId ?? null; }

  isDuplicate(clientMessageId: string) { return this.seenMessages.has(clientMessageId); }

  selectThread(threadId: string | null) {
    if (this.busy) throw new Error('BUSY');
    if (threadId !== null && !isThreadId(threadId)) throw new Error('INVALID_THREAD_ID');
    this.threadId = threadId;
  }

  resolveApproval(requestId: string, decision: 'accept' | 'decline') {
    const pending = this.approvals.get(requestId);
    if (!pending) return false;
    pending.resolve(decision); return true;
  }

  async interrupt() {
    if (this.server && this.threadId && this.turnId) await this.server.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  /** Routes one message with Jev, then executes it once with the selected model. Never retries. */
  async send(text: string, clientMessageId: string): Promise<void> {
    if (!text.trim()) throw new Error('EMPTY_TASK');
    if (Buffer.byteLength(text) > 200_000) throw new Error('TASK_TOO_LARGE');
    if (this.seenMessages.has(clientMessageId)) throw new Error('DUPLICATE');
    if (this.busy) throw new Error('BUSY');
    this.busy = true; this.seenMessages.add(clientMessageId);
    const emit = this.o.emit;
    let release: (() => void) | null = null;
    try {
      release = acquireLock(this.o.lockDir, this.threadId ?? `new-${process.pid}`);
    } catch (e) {
      this.busy = false;
      emit({ type: 'blocked', reason: 'PANEL_LOCK', message: 'Dieses Gespräch wird gerade von einem anderen Jev-Seitenfeld ausgeführt. Nicht gesendet.' });
      emit({ type: 'idle', threadId: this.threadId });
      return;
    }
    emit({ type: 'user', text, clientMessageId });
    const server = this.server = new CodexAppServer(this.o.codex);
    server.onNotification = (method, params) => this.onNotification(method, params);
    server.onRequest = req => this.onServerRequest(req);
    let phase = 'start';
    try {
      phase = 'connect'; emit({ type: 'phase', phase: 'connect', message: 'Verbinde mit Codex …' });
      await server.initialize();
      const models = await server.listModels();
      let threadModel: string | undefined;
      let context: unknown = null;
      let stats: ContextStats | null = null;
      if (this.threadId) {
        phase = 'resume';
        try {
          const resumed = await server.call('thread/resume', { threadId: this.threadId, excludeTurns: true });
          threadModel = resumed.model;
          if (resumed.thread?.status?.type === 'active') throw new Error('THREAD_ALREADY_RUNNING');
          emit({ type: 'thread', threadId: this.threadId, title: resumed.thread?.name ?? resumed.thread?.preview ?? null, cwd: resumed.cwd, model: resumed.model, effort: resumed.reasoningEffort });
        } catch (e) {
          if (isWriterConflict(e)) {
            emit({ type: 'blocked', reason: 'CODEX_WRITER_ACTIVE', message: 'Nicht gesendet: Die Codex-App hat dieses Gespräch gerade geöffnet und hält den Schreibzugriff. Codex erlaubt nur einen Schreiber pro Gespräch. Wechsle in der Codex-App zu einem anderen Chat oder schließe sie und sende erneut – oder setze bewusst in einem Abzweig fort.' });
            return;
          }
          throw e;
        }
        phase = 'context'; emit({ type: 'phase', phase: 'context', message: 'Lese sichtbaren Verlauf …' });
        const history = await server.readHistory(this.threadId);
        const built = buildRoutingContext(history.turns, { olderUnread: history.olderUnread, budget: this.o.contextBudget });
        context = built.context; stats = built.stats;
      } else stats = buildRoutingContext([]).stats;
      emit({ type: 'context', stats, description: describeContext(stats) });

      const baseline = models.find(m => m.model === threadModel) ?? models.find(m => m.isDefault) ?? models[0]!;
      phase = 'routing'; emit({ type: 'phase', phase: 'routing', message: 'Jev bewertet die Aufgabe …' });
      const decision: RouteDecision = await (this.o.route ?? routeModel)({ task: text, context, models, baseline: baseline.model, key: this.o.key() });
      const selected: RoutingModel = models.find(m => m.model === decision.model)!;
      emit({ type: 'decision', ...decision, baseline: baseline.model, effort: selected.defaultReasoningEffort, contextMode: stats?.mode });

      if (!this.threadId) {
        phase = 'start-thread';
        const started = await server.call('thread/start', { cwd: this.o.cwd, sandbox: this.o.write ? 'workspace-write' : 'read-only' });
        this.threadId = started.thread.id;
        emit({ type: 'thread', threadId: this.threadId, title: null, cwd: started.cwd, model: started.model, effort: started.reasoningEffort, created: true });
      }
      phase = 'run'; emit({ type: 'phase', phase: 'run', message: `${selected.model.replace('gpt-6-', '')} arbeitet …` });
      const completed = new Promise<any>(resolve => { this.turnDone = resolve; });
      const started = await server.call('turn/start', {
        threadId: this.threadId, clientUserMessageId: clientMessageId,
        input: [{ type: 'text', text, text_elements: [] }], model: selected.model, effort: selected.defaultReasoningEffort,
      });
      this.turnId = started.turn?.id ?? null;
      const turn = await Promise.race([completed, server.exited.then(() => ({ status: 'failed', error: { message: 'Codex-Prozess wurde während des Turns beendet' } }))]);
      emit({ type: 'turn', status: turn.status, error: turn.error?.message ?? null, durationMs: turn.durationMs ?? null, threadId: this.threadId, model: selected.model });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      emit({ type: 'error', phase, message: phase === 'run' || phase === 'start-thread' ? `Ausführung fehlgeschlagen: ${message}. Kein automatischer Neuversuch.` : `Nicht ausgeführt (${phase}): ${message}. Kein automatischer Neuversuch.` });
    } finally {
      for (const [id, a] of this.approvals) { clearTimeout(a.timer); a.resolve('decline'); this.approvals.delete(id); }
      this.turnDone = null; this.turnId = null; this.server = null;
      await server.close().catch(() => {});
      release?.();
      this.busy = false;
      emit({ type: 'idle', threadId: this.threadId });
    }
  }

  private turnDone: ((turn: any) => void) | null = null;

  /** Explicit user action: copy the visible history into a new conversation and continue there. */
  async fork(): Promise<string> {
    if (this.busy) throw new Error('BUSY');
    if (!this.threadId) throw new Error('NO_THREAD');
    this.busy = true;
    const server = new CodexAppServer(this.o.codex);
    try {
      await server.initialize();
      const forked = await server.call('thread/fork', { threadId: this.threadId });
      const source = this.threadId;
      this.threadId = forked.thread.id;
      this.o.emit({ type: 'thread', threadId: this.threadId, title: forked.thread?.name ?? null, cwd: forked.cwd, model: forked.model, forkedFrom: source, created: true });
      return this.threadId!;
    } finally { await server.close().catch(() => {}); this.busy = false; this.o.emit({ type: 'idle', threadId: this.threadId }); }
  }

  private onNotification(method: string, p: any) {
    const emit = this.o.emit;
    if (p?.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (method === 'item/agentMessage/delta') emit({ type: 'delta', itemId: p.itemId, text: p.delta });
    else if (method === 'item/completed') {
      const item = p.item;
      if (item?.type === 'agentMessage') emit({ type: 'agent', itemId: item.id, text: item.text });
      else if (item?.type === 'commandExecution') emit({ type: 'command', command: String(item.command ?? '').slice(0, 400), exitCode: item.exitCode ?? null, status: item.status });
      else if (item?.type === 'fileChange') emit({ type: 'files', paths: (item.changes ?? []).map((c: any) => c.path), status: item.status });
      else if (item?.type === 'mcpToolCall' || item?.type === 'dynamicToolCall') emit({ type: 'tool', name: item.tool ?? item.name, status: item.status });
    } else if (method === 'turn/completed') this.turnDone?.(p.turn);
    else if (method === 'model/rerouted') emit({ type: 'notice', message: `Codex hat das Modell umgeleitet: ${JSON.stringify(p).slice(0, 300)}` });
    else if (method === 'error') emit({ type: 'notice', message: `Codex-Fehlermeldung: ${String(p?.error?.message ?? p?.message ?? '').slice(0, 400)}` });
  }

  /** Approval requests are shown in the panel; nothing is approved automatically. */
  private async onServerRequest(req: { id: number | string; method: string; params: any }): Promise<unknown> {
    const kind = req.method === 'item/commandExecution/requestApproval' ? 'command' : req.method === 'item/fileChange/requestApproval' ? 'fileChange' : null;
    if (!kind) {
      this.o.emit({ type: 'notice', message: `Codex fragte „${req.method}“ – im Seitenfeld nicht unterstützt, daher abgelehnt.` });
      if (req.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
      throw new RpcError(-32000, 'NOT_SUPPORTED_IN_JEV_PANEL');
    }
    const requestId = `${req.id}`;
    const decision = await new Promise<'accept' | 'decline'>(resolve => {
      const timer = setTimeout(() => { this.approvals.delete(requestId); resolve('decline'); }, this.o.approvalTimeoutMs ?? 600_000);
      this.approvals.set(requestId, { resolve: d => { clearTimeout(timer); this.approvals.delete(requestId); resolve(d); }, timer });
      this.o.emit({ type: 'approval', requestId, kind, command: req.params?.command ?? null, cwd: req.params?.cwd ?? null, reason: req.params?.reason ?? null, grantRoot: req.params?.grantRoot ?? null });
    });
    this.o.emit({ type: 'approvalResolved', requestId, decision });
    return { decision };
  }
}
