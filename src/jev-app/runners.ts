// Jev app: runs one message with Claude Code or Codex through their official programs, signed in
// with the user's own accounts (`claude` CLI in stream-json mode, `codex app-server`). Model and
// effort are set when the run starts, which a plugin inside the apps cannot do. Nothing is
// approved automatically: permission prompts go to the app's window.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAppServer, RpcError, isWriterConflict, resolveCodexBinary } from '../codex-app-server.js';

export type Approval = { kind: 'command' | 'fileChange' | 'tool'; title: string; detail: string | null };
export type RunEvents = {
  delta?: (text: string) => void;
  activity?: (line: string) => void;
  notice?: (text: string) => void;
  /** Asks the user; resolves with their decision. */
  approval: (a: Approval) => Promise<'accept' | 'decline'>;
};
export type RunInput = { cwd: string; sessionId: string | null; prompt: string; model: string; effort: string | null; access: 'read' | 'write' };
export type RunResult = { sessionId: string; text: string; activity: string[]; status: 'completed' | 'failed' | 'interrupted'; error: string | null; servedModel: string | null };
export interface Runner { run(input: RunInput, ev: RunEvents): Promise<RunResult>; interrupt(): void }

const short = (s: unknown, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------- Claude Code ----------
/** The Claude Code program: JEV_CLAUDE_BIN, else the newest copy the Claude desktop app keeps, else `claude` on PATH. */
export function resolveClaudeBinary(): string {
  if (process.env.JEV_CLAUDE_BIN) return process.env.JEV_CLAUDE_BIN;
  const root = join(process.env.APPDATA ?? '', 'Claude', 'claude-code');
  try {
    const versions = readdirSync(root).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const v of versions.reverse()) { const exe = join(root, v, process.platform === 'win32' ? 'claude.exe' : 'claude'); if (existsSync(exe)) return exe; }
  } catch {}
  return 'claude';
}
/** Started from inside a Claude Code session, these would make the child think it is nested. */
export function cleanClaudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_EFFORT', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_PID']) delete out[k];
  return out;
}
/** Signed in with the user's own Claude account? (`claude auth status`) */
export function claudeReady(binary = resolveClaudeBinary()): { ready: boolean; reason: string | null } {
  try {
    const r = spawnSync(binary, ['auth', 'status'], { encoding: 'utf8', env: cleanClaudeEnv(), windowsHide: true, timeout: 20_000 });
    const status = JSON.parse(r.stdout || '{}');
    return status.loggedIn ? { ready: true, reason: null } : { ready: false, reason: 'Claude Code ist nicht angemeldet (claude → /login).' };
  } catch { return { ready: false, reason: 'Claude Code nicht gefunden.' }; }
}

export class ClaudeRunner implements Runner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  constructor(private command: string[] = [resolveClaudeBinary()]) {}

  interrupt() { this.stopped = true; this.child?.kill(); }

  run(input: RunInput, ev: RunEvents): Promise<RunResult> {
    const sessionId = input.sessionId ?? randomUUID();
    const [binary, ...prefix] = this.command;
    const args = [...prefix, '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', input.model, ...(input.effort ? ['--effort', input.effort] : []),
      ...(input.sessionId ? ['--resume', input.sessionId] : ['--session-id', sessionId]),
      '--permission-mode', input.access === 'write' ? 'acceptEdits' : 'default', '--permission-prompts', 'host'];
    const child = this.child = spawn(binary!, args, { cwd: input.cwd, env: cleanClaudeEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
    const write = (msg: object) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + '\n'); };
    const activity: string[] = []; let text = '', streamed = '', servedModel: string | null = null, result: any = null;
    const note = (line: string) => { activity.push(line); ev.activity?.(line); };

    return new Promise<RunResult>(resolve => {
      createInterface({ input: child.stdout }).on('line', async line => {
        let m: any; try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          const r = m.request, name = String(r.tool_name ?? 'Werkzeug'), inp = r.input ?? {};
          const kind: Approval['kind'] = name === 'Bash' || name === 'PowerShell' ? 'command' : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) ? 'fileChange' : 'tool';
          const decision = await ev.approval({ kind, title: kind === 'command' ? `Befehl ausführen (${name})` : kind === 'fileChange' ? 'Datei ändern' : `Werkzeug „${name}“ benutzen`,
            detail: short(inp.command ?? inp.file_path ?? inp.url ?? JSON.stringify(inp), 600) || null });
          write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id,
            response: decision === 'accept' ? { behavior: 'allow', updatedInput: inp } : { behavior: 'deny', message: 'Vom Nutzer in der Jev-App abgelehnt.' } } });
          return;
        }
        if (m.type === 'control_request') { write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'NOT_SUPPORTED_IN_JEV_APP' } }); return; }
        if (m.type === 'system' && m.subtype === 'init' && typeof m.model === 'string') servedModel = m.model;
        if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') { streamed += m.event.delta.text; ev.delta?.(m.event.delta.text); }
        if (m.type === 'assistant' && !m.parent_tool_use_id) {
          if (typeof m.message?.model === 'string') servedModel = m.message.model;
          for (const b of m.message?.content ?? []) {
            if (b.type === 'text' && b.text) text += (text ? '\n\n' : '') + b.text;
            if (b.type === 'tool_use') {
              const i = b.input ?? {};
              note(b.name === 'Bash' || b.name === 'PowerShell' ? `ausgeführt: ${short(i.command)}` : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) ? `geändert: ${short(i.file_path ?? i.notebook_path)}` : `Werkzeug: ${b.name}`);
            }
          }
        }
        if (m.type === 'result') { result = m; child.stdin.end(); }
      });
      child.on('error', e => resolve({ sessionId, text, activity, status: 'failed', error: `Claude Code startet nicht: ${e.message}`, servedModel }));
      child.on('close', code => {
        this.child = null;
        if (this.stopped) return resolve({ sessionId, text: text || streamed, activity, status: 'interrupted', error: null, servedModel });
        if (result && !result.is_error) return resolve({ sessionId: result.session_id ?? sessionId, text: text || String(result.result ?? streamed), activity, status: 'completed', error: null, servedModel });
        resolve({ sessionId, text: text || streamed, activity, status: 'failed', servedModel,
          error: result ? short(result.result ?? result.subtype, 400) : `Claude Code beendet (Code ${code}) ${short(stderr, 400)}`.trim() });
      });
      write({ type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize' } });
      write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input.prompt }] }, parent_tool_use_id: null, session_id: sessionId });
    });
  }
}

// ---------- Codex ----------
export function codexReady(): { ready: boolean; reason: string | null } {
  try { const b = resolveCodexBinary(); return b ? { ready: true, reason: null } : { ready: false, reason: 'Codex nicht gefunden.' }; }
  catch { return { ready: false, reason: 'Codex nicht gefunden.' }; }
}

export class CodexRunner implements Runner {
  private server: CodexAppServer | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  constructor(private command: string[] = [resolveCodexBinary()]) {}

  interrupt() { if (this.server && this.threadId && this.turnId) void this.server.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {}); }

  async run(input: RunInput, ev: RunEvents): Promise<RunResult> {
    const server = this.server = new CodexAppServer(this.command);
    const activity: string[] = []; let text = '';
    const note = (line: string) => { activity.push(line); ev.activity?.(line); };
    let done: (turn: any) => void = () => {};
    const completed = new Promise<any>(r => { done = r; });
    server.onNotification = (method, p) => {
      if (p?.threadId && this.threadId && p.threadId !== this.threadId) return;
      if (method === 'item/agentMessage/delta') ev.delta?.(String(p.delta ?? ''));
      else if (method === 'item/completed') {
        const item = p.item;
        if (item?.type === 'agentMessage') text += (text ? '\n\n' : '') + String(item.text ?? '');
        else if (item?.type === 'commandExecution') note(`ausgeführt: ${short(item.command)}`);
        else if (item?.type === 'fileChange') for (const c of item.changes ?? []) note(`geändert: ${short(c.path)}`);
        else if (item?.type === 'mcpToolCall' || item?.type === 'dynamicToolCall') note(`Werkzeug: ${item.tool ?? item.name}`);
      } else if (method === 'turn/completed') done(p.turn);
      else if (method === 'error') ev.notice?.(`Codex: ${short(p?.error?.message ?? p?.message, 400)}`);
    };
    server.onRequest = async req => {
      const kind = req.method === 'item/commandExecution/requestApproval' ? 'command' : req.method === 'item/fileChange/requestApproval' ? 'fileChange' : null;
      if (!kind) {
        if (req.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
        throw new RpcError(-32000, 'NOT_SUPPORTED_IN_JEV_APP');
      }
      const decision = await ev.approval({ kind, title: kind === 'command' ? 'Befehl ausführen' : 'Dateien ändern', detail: short(req.params?.command ?? req.params?.reason, 600) || null });
      return { decision };
    };
    try {
      await server.initialize();
      if (input.sessionId) {
        try {
          const resumed = await server.call('thread/resume', { threadId: input.sessionId, excludeTurns: true });
          if (resumed.thread?.status?.type === 'active') throw new Error('THREAD_ALREADY_RUNNING');
          this.threadId = input.sessionId;
        } catch (e) {
          if (!isWriterConflict(e)) throw e;
          // The Codex app holds this conversation: continue in a copy instead (history comes along).
          const forked = await server.call('thread/fork', { threadId: input.sessionId });
          this.threadId = forked.thread.id;
          ev.notice?.('Das Codex-Gespräch ist gerade in der Codex-App offen; Jev arbeitet in einer Kopie weiter.');
        }
      } else {
        const started = await server.call('thread/start', { cwd: input.cwd, sandbox: input.access === 'write' ? 'workspace-write' : 'read-only' });
        this.threadId = started.thread.id;
      }
      const started = await server.call('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }], model: input.model, ...(input.effort ? { effort: input.effort } : {}) });
      this.turnId = started.turn?.id ?? null;
      const turn = await Promise.race([completed, server.exited.then(() => ({ status: 'failed', error: { message: 'Codex wurde während der Antwort beendet' } }))]);
      const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
      return { sessionId: this.threadId!, text, activity, status, error: status === 'failed' ? short(turn.error?.message ?? 'Codex-Fehler', 400) : null, servedModel: input.model };
    } catch (e) {
      return { sessionId: this.threadId ?? input.sessionId ?? '', text, activity, status: 'failed', error: short(e instanceof Error ? e.message : e, 400), servedModel: null };
    } finally {
      this.server = null; this.turnId = null;
      await server.close().catch(() => {});
    }
  }
}
