// Jev app routing: one choice per message across BOTH families (Claude Code and Codex models),
// with the same policy as the plugins (published benchmarks, weighted evidence, switch only for a
// clear gain), and the handover text a newly chosen agent receives.
import { EFFORTS, inspectChat, pickEffort, type InspectResult } from '../chat-inspect.js';
import { MODEL_FACTS, modelKey } from '../model-benchmarks.js';
import { decideModel, spectrumEffort, type Difficulty, type TaskKind } from '../model-policy.js';
import type { CodexCatalogModel } from '../codex-rollout.js';
import type { HistoryTurn } from '../routing-context.js';
import type { AgentKind, Conversation, Message } from './store.js';

export type Route = {
  agent: AgentKind; model: string; effort: string | null;
  /** jev: Jev chose; keep: same as before (no new task, or Jev unavailable); user: chosen by hand. */
  source: 'jev' | 'keep' | 'user';
  switched: boolean; line: string; task: string | null; why: string | null;
};
export type Availability = { claude: boolean; codex: boolean };

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KIND: Record<string, string> = { coding: 'Coding', agentic: 'Agent/Terminal', reasoning: 'Denken/Analyse', research: 'Recherche', simple: 'Einfach' };
const DIFF: Record<string, string> = { easy: 'leicht', normal: 'normal', hard: 'schwer' };
export const agentOf = (model: string): AgentKind => MODEL_FACTS[modelKey(model) ?? '']?.app ?? (/^claude|opus|sonnet|haiku|fable/i.test(model) ? 'claude' : 'codex');
export const labelOf = (model: string | null | undefined) => model ? (MODEL_FACTS[modelKey(model) ?? '']?.label ?? model) : '?';
export const effortLabel = (e: string | null | undefined) => e ? (EFFORTS.find(x => x.id === e)?.label ?? e) : null;
export const settingLabel = (model: string, effort: string | null | undefined) => [labelOf(model), effortLabel(effort)].filter(Boolean).join(' · ');

/** Effort levels a model offers in its app. */
export function offeredEfforts(model: string, catalog: CodexCatalogModel[]): string[] {
  if (agentOf(model) === 'claude') return /haiku/i.test(model) ? [] : CLAUDE_EFFORTS;
  return (catalog.find(m => m.slug === model)?.supported_reasoning_levels ?? []).map(l => l.effort);
}
/** The evidence's sweet spot for this model and kind of task; a hard task one level more, never into "too much". */
export function effortFor(model: string, kind: TaskKind, difficulty: Difficulty, jev: { probabilities: Record<string, number> } | null, catalog: CodexCatalogModel[]): string | null {
  const offered = offeredEfforts(model, catalog);
  if (!offered.length) return null;
  const s = spectrumEffort(model, kind);
  if (!s || !offered.includes(s.effort)) return pickEffort(jev as any, offered);
  let effort = s.effort;
  if (difficulty === 'hard') {
    const ladder = [...offered].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    const next = ladder[ladder.indexOf(effort) + 1];
    if (next && (!s.avoidFrom || EFFORT_ORDER.indexOf(next) < EFFORT_ORDER.indexOf(s.avoidFrom))) effort = next;
  }
  return effort;
}

/** The candidates Jev may pick from: every known model of every app that is ready on this computer. */
export function candidates(av: Availability, catalog: CodexCatalogModel[]): string[] {
  const codexSlugs = new Set(catalog.map(m => m.slug));
  return Object.entries(MODEL_FACTS).filter(([id, f]) => (f.app === 'claude' && av.claude) || (f.app === 'codex' && av.codex && (!codexSlugs.size || codexSlugs.has(id)))).map(([id]) => id);
}

/** The conversation as history turns for Jev (one turn per user message). */
export function toTurns(messages: Message[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const m of messages) {
    if (m.role === 'note') continue;
    if (m.role === 'user' || !turns.length) turns.push({ id: `t${turns.length}`, status: 'completed', items: [] });
    turns.at(-1)!.items.push(m.role === 'user' ? { type: 'userMessage', text: m.text } : { type: 'agentMessage', text: m.text });
  }
  return turns;
}

export async function chooseRoute(o: {
  conversation: Conversation; text: string; available: Availability; catalog: CodexCatalogModel[]; key: string | undefined;
  override?: { model?: string | null; effort?: string | null } | null; inspect?: typeof inspectChat;
}): Promise<Route> {
  const last = [...o.conversation.messages].reverse().find(m => m.role === 'assistant' && m.model);
  const usable = (m: string) => (agentOf(m) === 'claude' ? o.available.claude : o.available.codex);
  const start = last?.model && usable(last.model) ? last.model : o.available.claude ? 'claude-opus-5-5' : 'gpt-6-astra';
  const prev = { model: start, effort: last?.model === start ? last.effort ?? null : null };
  const route = (model: string, effort: string | null, source: Route['source'], task: string | null, why: string | null): Route => {
    const switched = !!last?.model && agentOf(last.model) !== agentOf(model);
    const head = source === 'user' ? 'Von dir gewählt' : source === 'keep' ? 'Weiter mit' : 'Jev';
    return { agent: agentOf(model), model, effort, source, switched, task, why,
      line: `${head}: ${settingLabel(model, effort)}${task ? ` (${task})` : ''}${switched ? ` – Wechsel von ${labelOf(last!.model)}, der Verlauf geht mit` : ''}` };
  };
  if (o.override?.model) {
    if (!usable(o.override.model)) throw new Error(`AGENT_NOT_READY ${agentOf(o.override.model)}`);
    const offered = offeredEfforts(o.override.model, o.catalog);
    const effort = o.override.effort && offered.includes(o.override.effort) ? o.override.effort : offered.includes('medium') ? 'medium' : offered[0] ?? null;
    return route(o.override.model, effort, 'user', null, null);
  }
  const history = toTurns(o.conversation.messages);
  const turns = history.length ? history : [{ id: 't0', status: 'completed', items: [{ type: 'userMessage' as const, text: o.text }] }];
  let r: InspectResult;
  try { r = await (o.inspect ?? inspectChat)({ turns, task: o.text, gate: !!last, efforts: EFFORTS, key: o.key, source: 'Jev app conversation' }); }
  catch { r = { ok: false, reason: 'JEV_UNAVAILABLE', stats: null }; }
  const fallbackEffort = prev.effort ?? (offeredEfforts(prev.model, o.catalog).includes('medium') ? 'medium' : null);
  if (!r.ok) return { ...route(prev.model, fallbackEffort, 'keep', null, null), why: `Jev nicht erreichbar (${r.reason})` };
  if (r.newTask && r.newTask.yes < 0.5) return route(prev.model, fallbackEffort, 'keep', null, null);
  const kind = (r.taskKind?.choice ?? 'coding') as TaskKind, difficulty = (r.difficulty?.choice ?? 'normal') as Difficulty;
  const policy = decideModel({ kind, difficulty, current: prev.model, candidates: candidates(o.available, o.catalog) });
  const model = 'recommended' in policy && policy.interrupt && usable(policy.recommended) ? policy.recommended : prev.model;
  const why = 'reason' in policy ? policy.reason : null;
  return route(model, effortFor(model, kind, difficulty, r.effort, o.catalog), 'jev', `${KIND[kind] ?? kind}, ${DIFF[difficulty] ?? difficulty}`, why);
}

// ---------- handover ----------
const who = (m: Message) => m.role === 'user' ? 'Nutzer' : m.role === 'note' ? 'Hinweis' : `${m.agent === 'codex' ? 'Codex' : 'Claude Code'} · ${settingLabel(m.model ?? '?', m.effort)}`;
const render = (m: Message, max?: number) => {
  const text = max && m.text.length > max ? `${m.text.slice(0, max)} … (gekürzt)` : m.text;
  return `${who(m)}:\n${text}${m.activity?.length ? `\n(${m.activity.slice(0, 20).join('; ')})` : ''}`;
};
/**
 * What the chosen agent receives for the new message. An agent that has not seen parts of the
 * conversation (new session, or the other agent worked in between) gets them first, as history.
 * Too long: the latest messages stay complete, older ones are shortened, the oldest dropped.
 */
export function handover(c: Conversation, agent: AgentKind, text: string, budget = 300_000): { prompt: string; carried: number } {
  const seen = c.agents[agent]?.seenUpTo ?? 0;
  const unseen = c.messages.slice(seen).filter(m => !(m.role === 'assistant' && m.agent === agent));
  if (!unseen.length) return { prompt: text, carried: 0 };
  const fresh = !c.agents[agent];
  let parts = unseen.map(m => render(m));
  if (parts.join('\n\n').length > budget) {
    parts = unseen.map((m, i) => render(m, i < unseen.length - 12 ? 400 : undefined));
    let dropped = 0;
    while (parts.length > 1 && parts.join('\n\n').length > budget) { parts.shift(); dropped++; }
    if (dropped) parts.unshift(`(${dropped} ältere Nachrichten ausgelassen)`);
  }
  const intro = fresh
    ? 'Jev-App, Übergabe: Du übernimmst ein laufendes Gespräch. Bisher haben andere KI-Agenten im selben Projektordner daran gearbeitet; ihre Änderungen liegen schon in den Dateien. Das ist der bisherige Verlauf:'
    : 'Jev-App, Übergabe: Seit deiner letzten Antwort hat ein anderer KI-Agent im selben Projektordner weitergearbeitet; seine Änderungen liegen schon in den Dateien. Das ist inzwischen passiert:';
  return { prompt: `${intro}\n\n<verlauf>\n${parts.join('\n\n')}\n</verlauf>\n\nNeue Nachricht des Nutzers:\n${text}`, carried: unseen.length };
}
