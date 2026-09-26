// Deterministic model choice from published benchmarks. Jev only classifies the
// task (kind and difficulty); this policy picks the model and decides whether a
// switch is worth interrupting the user.
import { BENCHMARKS, MODEL_FACTS, modelKey, type BenchmarkId } from './model-benchmarks.js';

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

export type PolicyResult =
  | { basis: 'benchmark'; benchmark: BenchmarkId; recommended: string; interrupt: boolean; reason: 'current-within-tolerance' | 'quality-gap' | 'saving' | 'gap-below-threshold';
      scores: { model: string; score: number }[]; current: string; gap: number }
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
    const priced = candidates.filter(k => cost(k) !== null).sort((a, b) => cost(a)! - cost(b)!);
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
  if (!scored.length || typeof currentScore !== 'number') return { basis: 'none', reason: 'no-comparable-data' };
  const best = scored[0]!.score;
  const eligible = scored.filter(s => s.score >= best - TOLERANCE[input.difficulty]);
  // Cheapest model that is still within tolerance of the best; unknown cost ranks last.
  const recommended = [...eligible].sort((a, b) => (cost(a.model) ?? Infinity) - (cost(b.model) ?? Infinity) || b.score - a.score)[0]!.model;
  const recScore = MODEL_FACTS[recommended]!.scores[bench]!;
  const gap = +(recScore - currentScore).toFixed(1);
  const base = { basis: 'benchmark' as const, benchmark: bench, recommended, scores: scored, current, gap };
  if (recommended === current) return { ...base, interrupt: false, reason: 'current-within-tolerance' };
  if (eligible.some(e => e.model === current)) {
    // Current model is already good enough; only a large saving justifies an interruption.
    const cr = cost(recommended), cc = cost(current);
    const saving = cr !== null && cc !== null ? 1 - cr / cc : 0;
    return saving >= MIN_SAVING ? { ...base, interrupt: true, reason: 'saving' } : { ...base, interrupt: false, reason: 'current-within-tolerance' };
  }
  return gap >= MIN_SWITCH_POINTS ? { ...base, interrupt: true, reason: 'quality-gap' } : { ...base, interrupt: false, reason: 'gap-below-threshold' };
}

export const benchmarkName = (id: BenchmarkId) => BENCHMARKS[id].name;
export const factsLabel = (key: string) => MODEL_FACTS[key]?.label ?? key;
