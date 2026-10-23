// Jev app: conversations are owned by the app, not by Claude Code or Codex. Each conversation
// keeps the full history (user messages, answers, what the agents ran and changed) and, per
// agent, its own native session plus how far that session has already seen the history. A
// switch hands the unseen part over as text (src/jev-app/route.ts, handover).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type AgentKind = 'claude' | 'codex';
export type Message = {
  id: string; at: number; role: 'user' | 'assistant' | 'note';
  text: string;
  agent?: AgentKind; model?: string; effort?: string | null;
  /** Tool lifecycle evidence: requests, permissions and results (short lines). */
  activity?: string[];
};
export type AgentState = { sessionId: string; seenUpTo: number };
export type Conversation = {
  id: string; title: string; cwd: string; createdAt: number; updatedAt: number;
  /** "read": agents may only read; "write": they may change files in `cwd` (commands still ask). */
  access: 'read' | 'write';
  messages: Message[];
  agents: Partial<Record<AgentKind, AgentState>>;
  /** Imported from an existing Claude or Codex chat, if any. */
  origin?: { kind: AgentKind; id: string; title: string } | null;
};
export type ConversationSummary = Pick<Conversation, 'id' | 'title' | 'cwd' | 'updatedAt' | 'access'> & { last?: { agent?: AgentKind; model?: string } };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

// Preserve unknown metadata for forward compatibility, but never coerce broken records.
const agentKind = z.enum(['claude', 'codex']);
const timestamp = z.number().int().nonnegative();
const messageSchema = z.looseObject({
  id: z.string().regex(ID), at: timestamp, role: z.enum(['user', 'assistant', 'note']), text: z.string(),
  agent: agentKind.optional(), model: z.string().optional(), effort: z.string().nullable().optional(), activity: z.array(z.string()).optional(),
});
const agentStateSchema = z.looseObject({ sessionId: z.string().min(1), seenUpTo: z.number().int().nonnegative() });
const conversationSchema = z.looseObject({
  id: z.string().regex(ID), title: z.string(), cwd: z.string().min(1), createdAt: timestamp, updatedAt: timestamp,
  access: z.enum(['read', 'write']), messages: z.array(messageSchema),
  agents: z.looseObject({ claude: agentStateSchema.optional(), codex: agentStateSchema.optional() }),
  origin: z.looseObject({ kind: agentKind, id: z.string().min(1), title: z.string() }).nullable().optional(),
}).refine(c => [c.agents.claude, c.agents.codex].every(a => !a || a.seenUpTo <= c.messages.length));
export type ConversationProblem = { file: string; reason: 'invalid-id' | 'invalid-json' | 'invalid-record' };

export class ConversationStore {
  private dir: string;
  private problems = new Map<string, ConversationProblem>();
  constructor(stateDir: string) { this.dir = join(stateDir, 'app', 'conversations'); mkdirSync(this.dir, { recursive: true }); }
  private file(id: string) { if (!isId(id)) throw new Error('INVALID_CONVERSATION_ID'); return join(this.dir, `${id}.json`); }

  create(input: { cwd: string; access?: 'read' | 'write'; title?: string; origin?: Conversation['origin']; messages?: Message[] }): Conversation {
    const now = Date.now();
    const c: Conversation = { id: randomUUID(), title: input.title ?? 'Neues Gespräch', cwd: input.cwd, createdAt: now, updatedAt: now,
      access: input.access ?? 'read', messages: input.messages ?? [], agents: {}, origin: input.origin ?? null };
    this.save(c); return c;
  }
  get(id: string): Conversation | null {
    if (!isId(id)) return null;
    const filename = `${id}.json`;
    let raw: string;
    try { raw = readFileSync(this.file(id), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.problems.delete(filename); return null; }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { this.problems.set(filename, { file: filename, reason: 'invalid-json' }); return null; }
    const parsed = conversationSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== id) {
      this.problems.set(filename, { file: filename, reason: 'invalid-record' }); return null;
    }
    this.problems.delete(filename);
    return parsed.data;
  }
  save(c: Conversation) {
    if (!conversationSchema.safeParse(c).success) throw new Error('INVALID_CONVERSATION_RECORD');
    const file = this.file(c.id);
    // Do not replace unreadable/corrupted data with a stale in-memory copy. Recovery is explicit.
    if (existsSync(file) && !this.get(c.id)) throw new Error('CORRUPT_CONVERSATION_FILE');
    c.updatedAt = Date.now();
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(c)); renameSync(tmp, file);
  }
  getProblems(): ConversationProblem[] { return [...this.problems.values()]; }
  list(): ConversationSummary[] {
    this.problems.clear();
    const out: ConversationSummary[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      if (!isId(f.slice(0, -5))) { this.problems.set(f, { file: f, reason: 'invalid-id' }); continue; }
      const c = this.get(f.slice(0, -5)); if (!c) continue;
      const last = [...c.messages].reverse().find(m => m.role === 'assistant');
      out.push({ id: c.id, title: c.title, cwd: c.cwd, updatedAt: c.updatedAt, access: c.access, last: last ? { agent: last.agent, model: last.model } : undefined });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  add(c: Conversation, m: Omit<Message, 'id' | 'at'>): Message {
    const msg: Message = { id: randomUUID(), at: Date.now(), ...m };
    c.messages.push(msg);
    if (c.title === 'Neues Gespräch' && m.role === 'user') c.title = m.text.replace(/\s+/g, ' ').trim().slice(0, 60) || c.title;
    this.save(c); return msg;
  }
}
