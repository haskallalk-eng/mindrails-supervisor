// Published benchmark scores used for model selection. Only numbers that were
// checked against the cited pages on 2026-09-26 are included; a missing score
// means "no comparable number found", never zero. Vendor-reported numbers come
// from each vendor's own harness, so cross-vendor gaps of a few points are not
// meaningful. Update this table (and `asOf`) when new results are published.
export type BenchmarkId = 'frontiercode' | 'terminalbench4' | 'aaIndex';
export type BenchmarkInfo = { name: string; measures: string; kind: 'vendor' | 'independent'; sources: string[] };
export type ModelFacts = { label: string; app: 'claude' | 'codex'; family: string;
  price?: { input: number; output: number }; costPerTask?: number; scores: Partial<Record<BenchmarkId, number>> };

export const BENCHMARKS_AS_OF = '2026-09-26';
export const BENCHMARKS: Record<BenchmarkId, BenchmarkInfo> = {
  frontiercode: { name: 'FrontierCode v1.1 Main', measures: 'coding', kind: 'vendor',
    sources: ['https://kingy.ai/blog/claude-opus-5-5-vs-gpt-6-astra-vs-gpt-5-6-sol/', 'https://www.orcarouter.ai/blog/claude-opus-5-5-benchmark'] },
  terminalbench4: { name: 'Terminal-Bench 4.0', measures: 'agentic terminal work', kind: 'vendor',
    sources: ['https://www.orcarouter.ai/blog/claude-opus-5-5-benchmark', 'https://kingy.ai/blog/claude-opus-5-5-vs-gpt-6-astra-vs-gpt-5-6-sol/'] },
  aaIndex: { name: 'Artificial Analysis Intelligence Index (rev. 2026-09-22/24)', measures: 'general reasoning and knowledge work', kind: 'independent',
    sources: ['https://kingy.ai/blog/claude-opus-5-5-vs-gpt-6-astra-vs-gpt-5-6-sol/', 'https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra'] },
};

export const MODEL_FACTS: Record<string, ModelFacts> = {
  'claude-opus-5-5': { label: 'Opus 5.5', app: 'claude', family: 'opus', price: { input: 4, output: 20 }, costPerTask: 5.98, scores: { frontiercode: 54.4, terminalbench4: 66.4, aaIndex: 58 } },
  'claude-fable-5-1': { label: 'Fable 5.1', app: 'claude', family: 'fable', price: { input: 10, output: 50 }, scores: { frontiercode: 50.3, terminalbench4: 55.8, aaIndex: 53 } },
  'claude-opus-5': { label: 'Opus 5', app: 'claude', family: 'opus', price: { input: 5, output: 25 }, scores: { frontiercode: 48.0, terminalbench4: 52.3 } },
  'claude-sonnet-5': { label: 'Sonnet 5', app: 'claude', family: 'sonnet', price: { input: 2, output: 10 }, scores: {} },
  'claude-haiku-4-5': { label: 'Haiku 4.5', app: 'claude', family: 'haiku', price: { input: 1, output: 5 }, scores: {} },
  'gpt-6-astra': { label: 'GPT-6-Astra', app: 'codex', family: 'astra', costPerTask: 4.59, scores: { frontiercode: 53.3, terminalbench4: 57.9, aaIndex: 53 } },
  'gpt-6-sol': { label: 'GPT-6-Sol', app: 'codex', family: 'sol', costPerTask: 2.14, scores: { frontiercode: 49.3, aaIndex: 48 } },
  'gpt-6-luna': { label: 'GPT-6-Luna', app: 'codex', family: 'luna', costPerTask: 0.11, scores: { frontiercode: 42.4, aaIndex: 37 } },
  'gpt-5.6-sol': { label: 'GPT-5.6-Sol', app: 'codex', family: 'sol', scores: { frontiercode: 47.5, terminalbench4: 37.3, aaIndex: 47 } },
};

/** Normalizes app model ids ("claude-haiku-4-5-20251001", "fable[1m]") to table keys. */
export function modelKey(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  if (MODEL_FACTS[m]) return m;
  const alias: Record<string, string> = { opus: 'claude-opus-5-5', fable: 'claude-fable-5-1', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };
  return alias[m] ?? null;
}
