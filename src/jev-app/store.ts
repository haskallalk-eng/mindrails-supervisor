// Jev app: conversations are owned by the app, not by Claude Code or Codex. Each conversation
// keeps the full history (user messages, answers, what the agents ran and changed) and, per
// agent, its own native session plus how far that session has already seen the history. A
// switch hands the unseen part over as text (src/jev-app/route.ts, handover).
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AgentKind = 'claude' | 'codex';
export type Message = {
  id: string; at: number; role: 'user' | 'assistant' | 'note';
  text: string;
  agent?: AgentKind; model?: string; effort?: string | null;
  /** What the agent did besides answering: commands, changed files, tools (short lines). */
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

export class ConversationStore {
  private dir: string;
  constructor(stateDir: string) { this.dir = join(stateDir, 'app', 'conversations'); mkdirSync(this.dir, { recursive: true }); }
  private file(id: string) { if (!isId(id)) throw new Error('INVALID_CONVERSATION_ID'); return join(this.dir, `${id}.json`); }

  create(input: { cwd: string; access?: 'read' | 'write'; title?: string; origin?: Conversation['origin']; messages?: Message[] }): Conversation {
    const now = Date.now();
    const c: Conversation = { id: randomUUID(), title: input.title ?? 'Neues Gespräch', cwd: input.cwd, createdAt: now, updatedAt: now,
      access: input.access ?? 'read', messages: input.messages ?? [], agents: {}, origin: input.origin ?? null };
    this.save(c); return c;
  }
  get(id: string): Conversation | null {
    try { return JSON.parse(readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }
  save(c: Conversation) {
    c.updatedAt = Date.now();
    const file = this.file(c.id), tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c)); renameSync(tmp, file);
  }
  list(): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
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
