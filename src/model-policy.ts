// Deterministic model choice from published benchmarks. Jev only classifies the
// task (kind and difficulty); this policy picks the model and decides whether a
// switch is worth interrupting the user.
import { BENCHMARKS, MODEL_FACTS, modelKey, type BenchmarkId } from './model-benchmarks.js';
import { MODEL_EFFORT, MODEL_SPECTRUM, type EffortCell, type SpectrumCell } from './model-spectrum.js';

export const TASK_KINDS = {
  coding: 'Writing, changing, debugging or reviewing code in a repository.',
  agentic: 'Long multi-step work driving tools, terminals, builds, deployments or many files autonomously.',
  reasoning: 'Hard analysis, math, science, architecture or decision questions answered mainly by thinking.',
  research: 'Gathering and synthesizing information from many sources, documents or the web.',
  simple: 'Small, clearly specified, low-risk task: a rename, typo, formatting, a lookup or a short answer.',
} as const;
export const DIFFICULTIES = {
  easy: 'Routine; most capable models would succeed.',
  normal: 'Typical real work with some ambiguity or several steps.',
  hard: 'Unusually difficult, ambiguous, long or costly to get wrong.',
} as const;
export type TaskKind = keyof typeof TASK_KINDS;
export type Difficulty = keyof typeof DIFFICULTIES;

const KIND_BENCHMARK: Record<TaskKind, BenchmarkId | null> = { coding: 'frontiercode', agentic: 'terminalbench4', reasoning: 'aaIndex', research: 'aaIndex', simple: null };
/** Points a candidate may trail the best model and still count as equally good. */
export const TOLERANCE: Record<Difficulty, number> = { easy: 10, normal: 5, hard: 2 };
/**
 * Minimum benchmark gain before the user is interrupted to switch up. Published
 * scores on these benchmarks carry roughly ±2-5 points of noise and vendor
 * harness differences; below 4 points a gap is treated as noise (user-set threshold).
 */
export const MIN_SWITCH_POINTS = 4;
/** Minimum saving (relative cost) before the user is interrupted to switch down. */
export const MIN_SAVING = 0.25;

// ---------- weighted practitioner/user evidence (src/model-spectrum.ts) ----------
/** Which spectrum task a Jev task kind corresponds to. */
export const KIND_SPECTRUM_TASK: Record<TaskKind, string> = { coding: 'implementation', agentic: 'agentic_terminal', reasoning: 'architecture_planning', research: 'research_knowledge', simple: 'simple_edits' };
/** Spectrum ids: "gpt-5-6-sol", "claude-haiku-4-5"; app ids may be "gpt-5.6-sol", "claude-haiku-4-5-20251001", "fable[1m]". */
export function spectrumKey(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '').replace(/^gpt-(\d)\.(\d)/, 'gpt-$1-$2');
  return MODEL_SPECTRUM[m] || MODEL_EFFORT[m] ? m : modelKey(m);
}
export function spectrumCell(model: string | null, kind: TaskKind): SpectrumCell | null {
  const k = spectrumKey(model); return k ? MODEL_SPECTRUM[k]?.[KIND_SPECTRUM_TASK[kind]] ?? null : null;
}
/** Credible evidence that a model is bad at this kind of task vetoes recommending it. */
export const VETO = { strong: -25, medium: -40 } as const;
export function vetoed(model: string | null, kind: TaskKind): boolean {
  const c = spectrumCell(model, kind);
  return !!c && ((c.evidence === 'strong' && c.score <= VETO.strong) || (c.evidence === 'medium' && c.score <= VETO.medium));
}
/** Spectrum points (−100…+100) a better-rated model must lead by before interrupting, where no benchmark applies. */
export const SPECTRUM_MIN_GAP = 30;
/** Effort for a model: task-specific only with strong evidence, else the model's general level (medium/strong evidence). */
export function spectrumEffort(model: string | null, kind: TaskKind): (EffortCell & { scope: 'task' | 'general' }) | null {
  const k = spectrumKey(model); const cells = k ? MODEL_EFFORT[k] : undefined;
  if (!cells) return null;
  const task = cells[KIND_SPECTRUM_TASK[kind]];
  if (task && task.evidence === 'strong') return { ...task, scope: 'task' };
  const general = cells.general;
  return general && general.evidence !== 'weak' ? { ...general, scope: 'general' } : null;
}

export type PolicyResult =
  | { basis: 'benchmark'; benchmark: BenchmarkId; recommended: string; interrupt: boolean; reason: 'current-within-tolerance' | 'quality-gap' | 'saving' | 'gap-below-threshold' | 'current-vetoed';
      scores: { model: string; score: number }[]; current: string; gap: number; vetoedModels: string[] }
  | { basis: 'spectrum'; recommended: string; interrupt: boolean; reason: 'spectrum-gap' | 'spectrum-ok' | 'current-vetoed';
      scores: { model: string; score: number; evidence: string }[]; current: string; gap: number }
  | { basis: 'simple'; recommended: string; interrupt: boolean; reason: 'saving' | 'current-cheap-enough'; current: string | null }
  | { basis: 'none'; reason: 'no-comparable-data' | 'unknown-current' };

/** Relative cost of a model: list output price (Claude) or measured cost per task (Codex). */
function cost(key: string): number | null {
  const f = MODEL_FACTS[key]; return f?.price?.output ?? f?.costPerTask ?? null;
}

export function decideModel(input: { kind: TaskKind; difficulty: Difficulty; current: string | null; candidates: string[] }): PolicyResult {
  const current = modelKey(input.current);
  const candidates = [...new Set(input.candidates.map(modelKey).filter((k): k is string => Boolean(k)))];
  if (!current) return { basis: 'none', reason: 'unknown-current' };

  if (input.kind === 'simple') {
    const priced = candidates.filter(k => cost(k) !== null && !vetoed(k, 'simple')).sort((a, b) => cost(a)! - cost(b)!);
    const cheapest = priced[0];
    if (!cheapest || cost(current) === null) return { basis: 'none', reason: 'no-comparable-data' };
    const saving = 1 - cost(cheapest)! / cost(current)!;
    return saving >= MIN_SAVING && cheapest !== current
      ? { basis: 'simple', recommended: cheapest, interrupt: true, reason: 'saving', current }
      : { basis: 'simple', recommended: current, interrupt: false, reason: 'current-cheap-enough', current };
  }

  const bench = KIND_BENCHMARK[input.kind]!;
  const scored = candidates.map(k => ({ model: k, score: MODEL_FACTS[k]?.scores[bench] })).filter((x): x is { model: string; score: number } => typeof x.score === 'number').sort((a, b) => b.score - a.score);
  const currentScore = MODEL_FACTS[current]?.scores[bench];
  if (!scored.length || typeof currentScore !== 'number') return spectrumDecision(input);
  const vetoedModels = scored.filter(s => vetoed(s.model, input.kind)).map(s => s.model);
  const usable = scored.filter(s => !vetoedModels.includes(s.model));
  if (!usable.length) return spectrumDecision(input);
  const best = usable[0]!.score;
  const eligible = usable.filter(s => s.score >= best - TOLERANCE[input.difficulty]);
  // Cheapest model that is still within tolerance of the best; unknown cost ranks last.
  const recommended = [...eligible].sort((a, b) => (cost(a.model) ?? Infinity) - (cost(b.model) ?? Infinity) || b.score - a.score)[0]!.model;
  const recScore = MODEL_FACTS[recommended]!.scores[bench]!;
  const gap = +(recScore - currentScore).toFixed(1);
  const base = { basis: 'benchmark' as const, benchmark: bench, recommended, scores: scored, current, gap, vetoedModels };
  if (recommended === current) return { ...base, interrupt: false, reason: 'current-within-tolerance' };
  // Many credible voices say the current model is bad at exactly this kind of task.
  if (vetoedModels.includes(current)) return { ...base, interrupt: true, reason: 'current-vetoed' };
  if (eligible.some(e => e.model === current)) {
    // Current model is already good enough; only a large saving justifies an interruption.
    const cr = cost(recommended), cc = cost(current);
    const saving = cr !== null && cc !== null ? 1 - cr / cc : 0;
    return saving >= MIN_SAVING ? { ...base, interrupt: true, reason: 'saving' } : { ...base, interrupt: false, reason: 'current-within-tolerance' };
  }
  return gap >= MIN_SWITCH_POINTS ? { ...base, interrupt: true, reason: 'quality-gap' } : { ...base, interrupt: false, reason: 'gap-below-threshold' };
}

/** Where no comparable benchmark exists, decide from the weighted practitioner/user spectrum. */
export function spectrumDecision(input: { kind: TaskKind; current: string | null; candidates: string[] }): PolicyResult {
  const currentKey = spectrumKey(input.current);
  const cur = spectrumCell(input.current, input.kind);
  if (!currentKey || !cur || cur.evidence === 'weak') return { basis: 'none', reason: currentKey ? 'no-comparable-data' : 'unknown-current' };
  const byKey = new Map<string, string>();
  for (const c of input.candidates) { const k = spectrumKey(c); if (k && !byKey.has(k)) byKey.set(k, c); }
  const scores = [...byKey.keys()].map(k => ({ key: k, cell: MODEL_SPECTRUM[k]?.[KIND_SPECTRUM_TASK[input.kind]] }))
    .filter((x): x is { key: string; cell: SpectrumCell } => !!x.cell && x.cell.evidence !== 'weak' && !vetoed(x.key, input.kind))
    .sort((a, b) => b.cell.score - a.cell.score);
  if (!scores.length) return { basis: 'none', reason: 'no-comparable-data' };
  const top = scores[0]!;
  const recommended = byKey.get(top.key) ?? top.key;
  const gap = top.cell.score - cur.score;
  const base = { basis: 'spectrum' as const, recommended, scores: scores.map(s => ({ model: byKey.get(s.key) ?? s.key, score: s.cell.score, evidence: s.cell.evidence })), current: input.current!, gap };
  if (top.key === currentKey) return { ...base, interrupt: false, reason: 'spectrum-ok' };
  if (vetoed(input.current, input.kind)) return { ...base, interrupt: true, reason: 'current-vetoed' };
  return gap >= SPECTRUM_MIN_GAP ? { ...base, interrupt: true, reason: 'spectrum-gap' } : { ...base, recommended: input.current!, interrupt: false, reason: 'spectrum-ok' };
}

export const benchmarkName = (id: BenchmarkId) => BENCHMARKS[id].name;
export const factsLabel = (key: string) => MODEL_FACTS[key]?.label ?? key;
