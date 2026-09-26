// Reads a Codex rollout (~/.codex/sessions/.../rollout-*.jsonl) without the app
// server, so a prompt hook stays fast. Only completed visible items are used;
// reasoning is never included.
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { HistoryItem, HistoryTurn } from './routing-context.js';

export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');

export function readCodexRollout(path: string): HistoryTurn[] {
  const turns: HistoryTurn[] = []; let current: HistoryTurn | null = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('"item_completed"')) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const item = o?.payload?.type === 'item_completed' ? o.payload.item : null;
    if (!item) continue;
    const text = (content: any) => (Array.isArray(content) ? content : []).map((c: any) => typeof c?.text === 'string' ? c.text : '').join('\n').trim();
    if (item.type === 'UserMessage') { const t = text(item.content); if (t) { current = { id: String(item.id ?? turns.length), status: 'completed', items: [{ type: 'userMessage', text: t }] }; turns.push(current); } continue; }
    if (!current) continue;
    let h: HistoryItem | null = null;
    if (item.type === 'AgentMessage') { const t = text(item.content); if (t) h = { type: 'agentMessage', text: t }; }
    else if (item.type === 'CommandExecution') {
      const cmd = Array.isArray(item.command) ? String(item.command.at(-1) ?? '') : String(item.command ?? '');
      const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
      h = { type: 'command', command: cmd, exitCode: exit, status: String(item.status ?? (exit === null ? '' : exit === 0 ? 'completed' : 'failed')) };
    } else if (item.type === 'FileChange') h = { type: 'fileChange', paths: Object.keys(item.changes ?? {}), status: String(item.status ?? 'completed') };
    else if (item.type === 'McpToolCall') h = { type: 'tool', name: String(item.tool ?? 'tool'), status: String(item.status ?? '') };
    if (h) current.items.push(h);
  }
  return turns;
}

/** Model and reasoning effort of the latest turn in the rollout. */
export function codexTurnSettings(path: string): { model: string | null; effort: string | null } {
  try {
    const size = statSync(path).size, len = Math.min(size, 2_097_152);
    const fd = openSync(path, 'r'); const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    const lines = buf.toString('utf8').split('\n').filter(l => l.includes('"type":"turn_context"'));
    for (const l of lines.reverse()) { try { const p = JSON.parse(l).payload; if (p?.model) return { model: p.model, effort: p.effort ?? null }; } catch {} }
  } catch {}
  return { model: null, effort: null };
}

/** Finds the rollout file of a Codex conversation by id (newest date folders first). */
export function findCodexRollout(threadId: string, root = join(codexHome(), 'sessions')): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(threadId) || !existsSync(root)) return null;
  const desc = (dir: string) => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };
  for (const y of desc(root)) for (const m of desc(join(root, y))) for (const d of desc(join(root, y, m))) {
    const hit = desc(join(root, y, m, d)).find(f => f.endsWith(`${threadId}.jsonl`));
    if (hit) return join(root, y, m, d, hit);
  }
  return null;
}

export type CodexCatalogModel = { slug: string; display_name?: string; description?: string; supported_reasoning_levels?: { effort: string; description?: string }[] };
/** The model catalog Codex caches locally (the same list its model menu shows). */
export function readCodexCatalog(): CodexCatalogModel[] {
  try { const j = JSON.parse(readFileSync(join(codexHome(), 'models_cache.json'), 'utf8')); return Array.isArray(j.models) ? j.models : []; } catch { return []; }
}
