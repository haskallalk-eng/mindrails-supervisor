// Builds the conversation context Jev sees before routing. Long histories are
// reduced deterministically to fit a byte budget, and the result always states
// honestly whether it is the complete visible history or a labeled selection.

export type HistoryItem =
  | { type: 'userMessage'; text: string }
  | { type: 'agentMessage'; text: string }
  | { type: 'command'; command: string; exitCode: number | null; status: string }
  | { type: 'fileChange'; paths: string[]; status: string }
  | { type: 'tool'; name: string; status: string };
export type HistoryTurn = { id: string; status: string; items: HistoryItem[]; error?: string | null };

export type ContextStats = {
  mode: 'none' | 'complete' | 'selection';
  totalTurns: number; olderUnread: boolean; readTurns: number; recentTurns: number; digestedTurns: number; omittedTurns: number;
  notes: number; sourceBytes: number; sentBytes: number;
};
export type RoutingContext = { context: unknown; stats: ContextStats };

export const DEFAULT_CONTEXT_BUDGET = 24_000;
const RECENT_TURNS = 3;

// Sentences that usually carry constraints, decisions or open problems.
const NOTE_PATTERN = /\b(muss|müssen|darf nicht|dürfen nicht|nicht mehr|niemals|nie |immer|keine?n? |ohne |wichtig|bitte nicht|entschieden|entscheidung|beschlossen|festgelegt|einschränkung|grenze|verboten|offen|ungelöst|fehler|fehlgeschlagen|schlägt fehl|problem|blocker|blockiert|todo|noch nicht|must|never|always|do not|don't|decided|decision|constraint|failing|failed|error|bug|blocked|open issue|unresolved)\b/i;

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)} … [gekürzt, ${text.length - max} Zeichen ausgelassen]`;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function turnText(turn: HistoryTurn, type: 'userMessage' | 'agentMessage', pick: 'first' | 'last'): string {
  const texts = turn.items.filter(i => i.type === type).map(i => (i as { text: string }).text.trim()).filter(Boolean);
  return (pick === 'first' ? texts[0] : texts.at(-1)) ?? '';
}

function recentView(turn: HistoryTurn, index: number, cap: number) {
  const user = turn.items.filter(i => i.type === 'userMessage').map(i => (i as { text: string }).text).join('\n\n');
  const agent = turn.items.filter(i => i.type === 'agentMessage').map(i => (i as { text: string }).text).join('\n\n');
  const commands = turn.items.filter(i => i.type === 'command').map(i => i as Extract<HistoryItem, { type: 'command' }>);
  const failed = commands.filter(c => c.status === 'failed' || (c.exitCode ?? 0) !== 0);
  const files = [...new Set(turn.items.flatMap(i => i.type === 'fileChange' ? i.paths : []))];
  return {
    turn: index + 1, status: turn.status, ...(turn.error ? { error: clip(turn.error, 400) } : {}),
    user: clip(user, cap), assistant: clip(agent, cap),
    ...(commands.length ? { commands: commands.length, failedCommands: failed.slice(-5).map(c => ({ command: clip(c.command, 160), exitCode: c.exitCode })) } : {}),
    ...(files.length ? { changedFiles: files.slice(0, 20) } : {}),
  };
}

function extractNotes(turn: HistoryTurn, index: number): { turn: number; from: 'user' | 'assistant'; text: string }[] {
  const out: { turn: number; from: 'user' | 'assistant'; text: string }[] = [];
  for (const item of turn.items) {
    if (item.type !== 'userMessage' && item.type !== 'agentMessage') continue;
    for (const sentence of item.text.split(/(?<=[.!?])\s+|\n+/)) {
      const s = sentence.trim();
      if (s.length >= 12 && NOTE_PATTERN.test(s)) out.push({ turn: index + 1, from: item.type === 'userMessage' ? 'user' : 'assistant', text: clip(s, 240) });
    }
  }
  return out;
}

/**
 * turns: chronological (oldest first) turns that were actually read.
 * olderUnread: true when the reader stopped before the oldest turn; turn
 * numbers are then relative to the read window and this is disclosed.
 */
export function buildRoutingContext(turns: HistoryTurn[], options: { olderUnread?: boolean; budget?: number } = {}): RoutingContext {
  const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET;
  const unread = options.olderUnread ?? false;
  const totalTurns = turns.length;
  const offset = 0;
  const base = { totalTurns, olderUnread: unread, readTurns: turns.length, notes: 0 };
  if (!totalTurns) return { context: null, stats: { ...base, mode: 'none', recentTurns: 0, digestedTurns: 0, omittedTurns: 0, sourceBytes: 0, sentBytes: 0 } };

  const sourceBytes = bytes(turns);
  const complete = { visibleHistory: 'complete', turns: turns.map((t, i) => recentView(t, offset + i, 20_000)) };
  const completeFits = !unread && bytes(complete) <= budget && JSON.stringify(complete).indexOf('[gekürzt') < 0;
  if (completeFits) return { context: complete, stats: { ...base, mode: 'complete', recentTurns: turns.length, digestedTurns: 0, omittedTurns: 0, sourceBytes, sentBytes: bytes(complete) } };

  // Selection: most recent turns in detail, then constraints/decisions/problems,
  // then short digests of older turns, newest first, until the budget is used.
  const recentCount = Math.min(RECENT_TURNS, turns.length);
  const olderEnd = turns.length - recentCount;
  let recentCap = 4_000;
  let recent = turns.slice(olderEnd).map((t, i) => recentView(t, offset + olderEnd + i, recentCap));
  while (bytes(recent) > budget * 0.5 && recentCap > 300) { recentCap = Math.floor(recentCap / 2); recent = turns.slice(olderEnd).map((t, i) => recentView(t, offset + olderEnd + i, recentCap)); }

  const firstUser = turns[0] && !unread ? clip(turnText(turns[0], 'userMessage', 'first'), 1_200) : null;
  const context: {
    visibleHistory: 'selection'; disclosure: string; totalTurns: number; firstRequest: string | null;
    notes: { turn: number; from: string; text: string }[]; olderTurnDigests: { turn: number; status: string; user: string; outcome: string }[];
    recentTurns: typeof recent;
  } = {
    visibleHistory: 'selection',
    disclosure: `Automatic selection, NOT the complete history: ${totalTurns} turns read${unread ? ' (even older turns were not read)' : ''}. The last ${recentCount} turns are included in detail (long texts clipped); older turns only as extracted constraint/decision/problem sentences and short digests where they fit.`,
    totalTurns, firstRequest: firstUser, notes: [], olderTurnDigests: [], recentTurns: recent,
  };

  const seen = new Set<string>();
  const notes = turns.slice(0, olderEnd).flatMap((t, i) => extractNotes(t, offset + i)).reverse()
    .filter(n => { const k = n.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const noteBudget = budget * 0.65; // leave room for older-turn digests
  for (const note of notes) { context.notes.push(note); if (bytes(context) > noteBudget) { context.notes.pop(); break; } }
  context.notes.sort((a, b) => a.turn - b.turn);

  const digested = new Set<number>();
  for (let i = olderEnd - 1; i >= 0; i--) {
    const t = turns[i]!;
    context.olderTurnDigests.unshift({ turn: offset + i + 1, status: t.status, user: clip(turnText(t, 'userMessage', 'first'), 280), outcome: clip(turnText(t, 'agentMessage', 'last'), 280) });
    if (bytes(context) > budget) { context.olderTurnDigests.shift(); break; }
    digested.add(i);
  }
  if (bytes(context) > budget) context.firstRequest = firstUser ? clip(firstUser, 200) : null;

  const stats: ContextStats = {
    ...base, mode: 'selection', recentTurns: recentCount, digestedTurns: digested.size,
    omittedTurns: totalTurns - recentCount - digested.size, notes: context.notes.length, sourceBytes, sentBytes: bytes(context),
  };
  return { context, stats };
}

/** Maps app-server ThreadItems to the minimal visible history. Reasoning is never included. */
export function toHistoryTurn(turn: any): HistoryTurn {
  const items: HistoryItem[] = [];
  for (const item of turn?.items ?? []) {
    if (item.type === 'userMessage') {
      const text = (item.content ?? []).map((c: any) => c.type === 'text' ? c.text : c.type === 'mention' || c.type === 'skill' ? `@${c.name}` : `[${c.type}]`).join(' ');
      items.push({ type: 'userMessage', text });
    } else if (item.type === 'agentMessage' && typeof item.text === 'string') items.push({ type: 'agentMessage', text: item.text });
    else if (item.type === 'commandExecution') items.push({ type: 'command', command: String(item.command ?? ''), exitCode: item.exitCode ?? null, status: String(item.status ?? '') });
    else if (item.type === 'fileChange') items.push({ type: 'fileChange', paths: (item.changes ?? []).map((c: any) => String(c.path)), status: String(item.status ?? '') });
    else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') items.push({ type: 'tool', name: String(item.tool ?? item.name ?? 'tool'), status: String(item.status ?? '') });
  }
  return { id: String(turn?.id ?? ''), status: String(turn?.status ?? ''), items, error: turn?.error?.message ?? null };
}

export function describeContext(stats: ContextStats): string {
  if (stats.mode === 'none') return 'Neues Gespräch – kein Verlauf.';
  if (stats.mode === 'complete') return `Vollständiger sichtbarer Verlauf (${stats.totalTurns} Turns, ${(stats.sentBytes / 1024).toFixed(1)} KB).`;
  if (!stats.digestedTurns && !stats.omittedTurns && !stats.olderUnread) return `Alle ${stats.totalTurns} Turns, aber lange Texte gekürzt (${(stats.sentBytes / 1024).toFixed(1)} KB aus ${(stats.sourceBytes / 1024).toFixed(0)} KB) – nicht der vollständige Wortlaut.`;
  return `Auswahl, nicht der vollständige Verlauf: ${stats.recentTurns} letzte Turns ausführlich, ${stats.digestedTurns} ältere als Kurzfassung, ${stats.notes} Einschränkungs-/Entscheidungs-/Problemsätze, ${stats.omittedTurns} Turns nicht einzeln enthalten (${(stats.sentBytes / 1024).toFixed(1)} KB aus ${(stats.sourceBytes / 1024).toFixed(0)} KB gelesenem Verlauf${stats.olderUnread ? ', noch ältere Turns nicht gelesen' : ''}).`;
}
