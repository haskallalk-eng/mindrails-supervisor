#!/usr/bin/env node
// Aggregates collected practitioner/user claims into a weighted model spectrum.
// Usage: node scripts/build-model-spectrum.mjs <claims dir> [--out src/model-spectrum.ts] [--md <report.md>]
// Input: claims_*.jsonl (model/task/polarity) and effort_*.jsonl (model/task/effort/verdict),
// format described in the claim specs. Output: a generated TypeScript table used by Jev.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- weighting (documented in docs/model-routing.md) ----------
export const AUTHOR = { researcher: 1.3, practitioner: 1.2, user: 0.8, vendor: 0.8, press: 0.6 };
export const PLATFORM = { paper: 1.2, benchmark: 1.2, github: 1.1, hn: 1.0, blog: 1.0, vendor: 1.0, forum: 0.85, reddit: 0.85, x: 0.85, youtube: 0.8, news: 0.8 };
export const STRENGTH = { 1: 0.4, 2: 1.0, 3: 2.0 };
export const RECENCY = { '2026-09': 1.0, '2026-08': 0.9, '2026-07': 0.8, '2026-06': 0.7 };
export const VENDOR_SELF_PRAISE = 0.6, VENDOR_ON_COMPETITOR = 0.5;
export const SAME_SOURCE_EXTRA = 0.3;
export const TASK_IN_GENERAL = 0.5;     // task-specific effort evidence counts half toward a model's general effort   // additional voices in the same thread/article count 30 %
export const PRIOR = 2;                 // shrinkage: cells with little evidence move toward 0
// Claims about a model dated before its release are discarded.
export const RELEASED = { 'claude-opus-5-5': '2026-09-22', 'gpt-6-sol': '2026-09-22', 'gpt-6-luna': '2026-09-22', 'gpt-6-astra': '2026-09-03', 'claude-fable-5-1': '2026-09-01', 'claude-sonnet-5': '2026-06-30', 'gpt-5-6-sol': '2026-07-01', 'gpt-5-6-terra': '2026-07-01', 'gpt-5-6-luna': '2026-07-01' };
export const EFFORT_LADDER = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], openai: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };

const vendorOfModel = m => m.startsWith('claude') ? 'anthropic' : 'openai';
const vendorOfUrl = u => /anthropic\.com|claude\.com|claude\.ai/.test(u) ? 'anthropic' : /openai\.com|chatgpt\.com/.test(u) ? 'openai' : null;
// Month-only dates ("2026-09") are compared with the END of that month, so a statement from the
// release month is not wrongly treated as predating the release.
const normDate = d => { const s = String(d ?? ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : /^\d{4}-\d{2}$/.test(s) ? `${s}-31` : ''; };

export function claimWeight(c) {
  let w = (AUTHOR[c.author_kind] ?? 0.8) * (PLATFORM[c.platform] ?? 0.85) * (STRENGTH[c.strength] ?? 1) * (RECENCY[String(c.date).slice(0, 7)] ?? 0.7);
  if (c.author_kind === 'vendor') {
    const v = vendorOfUrl(String(c.url ?? ''));
    if (v && v === vendorOfModel(c.model)) { if ((c.polarity ?? 1) > 0 || ['best', 'enough'].includes(c.verdict)) w *= VENDOR_SELF_PRAISE; }
    else if (v) w *= VENDOR_ON_COMPETITOR;
  }
  return w;
}
function valid(c) {
  const d = normDate(c.date);
  if (!d || d < '2026-06-01') return false;
  const rel = RELEASED[c.model];
  return !(rel && d < rel);
}
/** Same source (url) repeating the same point: full weight for the strongest, 30 % for the rest. */
function combine(weights) {
  const s = [...weights].sort((a, b) => b - a);
  return s.length ? s[0] + SAME_SOURCE_EXTRA * s.slice(1).reduce((a, b) => a + b, 0) : 0;
}

export function aggregateClaims(claims) {
  const groups = new Map();
  let dropped = 0;
  for (const c of claims) {
    if (!valid(c)) { dropped++; continue; }
    const key = [c.model, c.task, c.polarity > 0 ? 1 : -1, String(c.url ?? '').replace(/[#?].*$/, '')].join('|');
    (groups.get(key) ?? groups.set(key, []).get(key)).push(claimWeight(c));
  }
  const cells = {};
  for (const [key, ws] of groups) {
    const [model, task, pol, url] = key.split('|');
    const cell = (cells[model] ??= {})[task] ??= { pos: 0, neg: 0, sources: new Set(), n: 0 };
    const w = combine(ws);
    if (Number(pol) > 0) cell.pos += w; else cell.neg += w;
    cell.sources.add(url); cell.n += ws.length;
  }
  const out = {};
  for (const [model, tasks] of Object.entries(cells)) for (const [task, c] of Object.entries(tasks)) {
    const mass = c.pos + c.neg, sources = c.sources.size;
    (out[model] ??= {})[task] = {
      score: Math.round(100 * (c.pos - c.neg) / (mass + PRIOR)),
      evidence: mass >= 8 && sources >= 5 ? 'strong' : mass >= 3 && sources >= 2 ? 'medium' : 'weak',
      mass: +mass.toFixed(2), sources, statements: c.n,
    };
  }
  return { cells: out, dropped };
}

export function aggregateEffort(claims) {
  // Each verdict votes for the level that should be used (per model and task, plus "general").
  const votes = {};
  let dropped = 0;
  const seen = new Map();
  for (const c of claims) {
    if (!valid(c) || !c.effort) { dropped++; continue; }
    const ladder = EFFORT_LADDER[vendorOfModel(c.model) === 'anthropic' ? 'claude' : 'openai'];
    const i = ladder.indexOf(c.effort); if (i < 0) { dropped++; continue; }
    const key = [c.model, c.task, c.effort, c.verdict, String(c.url ?? '').replace(/[#?].*$/, '')].join('|');
    const n = seen.get(key) ?? 0; seen.set(key, n + 1);
    const w = claimWeight(c) * (n === 0 ? 1 : SAME_SOURCE_EXTRA);
    for (const scope of new Set([c.task || 'general', 'general'])) {
      const v = ((votes[c.model] ??= {})[scope] ??= { levels: Object.fromEntries(ladder.map(l => [l, 0])), mass: 0, sources: new Set() });
      const sw = scope === 'general' && c.task && c.task !== 'general' ? TASK_IN_GENERAL : 1;
      const add = (idx, x) => { if (idx >= 0 && idx < ladder.length) v.levels[ladder[idx]] += x * sw; };
      const lower = c.compared_to && ladder.includes(c.compared_to) ? ladder.indexOf(c.compared_to) : i - 1;
      if (c.verdict === 'best') add(i, 2 * w);
      else if (c.verdict === 'enough') { add(i, w); for (let j = i + 1; j < ladder.length; j++) add(j, -0.3 * w); }
      else if (c.verdict === 'too_little') { add(i, -w); add(i + 1, w); }
      else if (c.verdict === 'too_much') { add(i, -w); add(i - 1, 0.7 * w); }
      else if (c.verdict === 'worse_than_lower') { add(i, -1.5 * w); add(lower, w); }
      v.mass += w * sw; v.sources.add(String(c.url ?? ''));
    }
  }
  const out = {};
  for (const [model, scopes] of Object.entries(votes)) for (const [scope, v] of Object.entries(scopes)) {
    const ranked = Object.entries(v.levels).sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] <= 0) continue;
    const ladder = Object.keys(v.levels);
    const best = ranked[0][0];
    // "Nicht höher als": the lowest level above the recommendation with a clearly negative balance.
    const cap = ladder.slice(ladder.indexOf(best) + 1).find(l => v.levels[l] < -0.5) ?? null;
    (out[model] ??= {})[scope] = { effort: best, avoidFrom: cap, evidence: v.mass >= 5 && v.sources.size >= 3 ? 'strong' : v.mass >= 2 && v.sources.size >= 2 ? 'medium' : 'weak', mass: +v.mass.toFixed(2), sources: v.sources.size };
  }
  return { effort: out, dropped };
}

const LABEL = { 'claude-fable-5-1': 'Fable 5.1', 'claude-fable-5': 'Fable 5', 'claude-opus-5-5': 'Opus 5.5', 'claude-opus-5': 'Opus 5', 'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5', 'claude-sonnet-4-6': 'Sonnet 4.6', 'claude-haiku-4-5': 'Haiku 4.5', 'gpt-6-astra': 'GPT-6 Astra', 'gpt-6-sol': 'GPT-6 Sol',
  'gpt-6-luna': 'GPT-6 Luna', 'gpt-5-6-sol': 'GPT-5.6 Sol', 'gpt-5-6-terra': 'GPT-5.6 Terra', 'gpt-5-6-luna': 'GPT-5.6 Luna', 'gpt-5-5': 'GPT-5.5' };
const TASK_DE = { implementation: 'Programmieren (Features im Repo)', agentic_terminal: 'Agent/Terminal (lange autonome Arbeit)', debugging: 'Debugging',
  architecture_planning: 'Architektur/Planung', code_review: 'Code-Review', refactoring_migration: 'Refactoring/Migration', frontend_ui: 'Frontend/UI',
  research_knowledge: 'Recherche/Wissensarbeit', simple_edits: 'Einfache Änderungen', writing_docs: 'Texte/Doku', cost_speed: 'Preis/Tempo (Preis-Leistung)' };
const EV_DE = { strong: 'stark', medium: 'mittel', weak: 'schwach' };
const EFF_DE = { low: 'Niedrig', medium: 'Mittel', high: 'Hoch', xhigh: 'Extra hoch', max: 'Max', ultra: 'Ultra' };
function renderMarkdown(cells, effort, meta) {
  const lines = [`# Jev-Modellspektrum (Stand ${meta.builtAt})`, '',
    `Grundlage: ${meta.statements} Aussagen zu Modell und Aufgabe sowie ${meta.effortStatements} zum Effort, gewichtet nach Glaubwürdigkeit, Qualität und Aktualität. Punktzahl von −100 bis +100: positiv = gut dafür, negativ = schlecht dafür; bei wenig Evidenz zur Mitte gezogen. Evidenz: stark / mittel / schwach.`, ''];
  for (const task of Object.keys(TASK_DE)) {
    lines.push(`## ${TASK_DE[task]}`, '', '| Claude | Punkte | Evidenz | | Codex | Punkte | Evidenz |', '|---|---:|---|---|---|---:|---|');
    const rank = pre => Object.entries(cells).filter(([m, t]) => m.startsWith(pre) && t[task]).map(([m, t]) => [m, t[task]]).sort((x, y) => y[1].score - x[1].score);
    const c = rank('claude'), o = rank('gpt');
    for (let i = 0; i < Math.max(c.length, o.length); i++) {
      const L = c[i], R = o[i];
      lines.push(`| ${L ? LABEL[L[0]] ?? L[0] : ''} | ${L ? (L[1].score > 0 ? '+' : '') + L[1].score : ''} | ${L ? EV_DE[L[1].evidence] : ''} | | ${R ? LABEL[R[0]] ?? R[0] : ''} | ${R ? (R[1].score > 0 ? '+' : '') + R[1].score : ''} | ${R ? EV_DE[R[1].evidence] : ''} |`);
    }
    lines.push('');
  }
  lines.push('## Effort pro Modell', '', '| Modell | Allgemein | Nicht höher als | Aufgabenspezifisch (Evidenz) |', '|---|---|---|---|');
  for (const [m, scopes] of Object.entries(effort).sort()) {
    const g = scopes.general;
    const spec = Object.entries(scopes).filter(([s]) => s !== 'general').map(([s, v]) => `${TASK_DE[s]?.split(' (')[0] ?? s}: ${EFF_DE[v.effort]} (${EV_DE[v.evidence]})`).join('; ');
    lines.push(`| ${LABEL[m] ?? m} | ${g ? `${EFF_DE[g.effort]} (${EV_DE[g.evidence]})` : '–'} | ${g?.avoidFrom ? EFF_DE[g.avoidFrom] : '–'} | ${spec || '–'} |`);
  }
  return lines.join('\n') + '\n';
}

function readJsonl(dir, prefix) {
  return readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: build-model-spectrum.mjs <claims dir> [--out file.ts] [--md file.md]'); process.exit(1); }
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const claims = readJsonl(dir, 'claims_'), efforts = readJsonl(dir, 'effort_');
  const a = aggregateClaims(claims), e = aggregateEffort(efforts);
  const meta = { builtAt: new Date().toISOString().slice(0, 10), statements: claims.length, effortStatements: efforts.length, droppedStatements: a.dropped, droppedEffort: e.dropped };
  const ts = `// GENERATED by scripts/build-model-spectrum.mjs – do not edit by hand.
// Weighted practitioner/user evidence: score -100…+100 per model and task (credibility x quality x recency, same-source repeats damped,
// shrunk toward 0 when evidence is thin); effort = level the weighted verdicts point to for that model.
export type SpectrumCell = { score: number; evidence: 'strong' | 'medium' | 'weak'; mass: number; sources: number; statements: number };
export type EffortCell = { effort: string; avoidFrom: string | null; evidence: 'strong' | 'medium' | 'weak'; mass: number; sources: number };
export const SPECTRUM_META = ${JSON.stringify(meta)} as const;
export const MODEL_SPECTRUM: Record<string, Record<string, SpectrumCell>> = ${JSON.stringify(a.cells, null, 1)};
export const MODEL_EFFORT: Record<string, Record<string, EffortCell>> = ${JSON.stringify(e.effort, null, 1)};
`;
  if (arg('--out')) writeFileSync(arg('--out'), ts);
  if (arg('--md')) writeFileSync(arg('--md'), renderMarkdown(a.cells, e.effort, meta));
  console.log(JSON.stringify(meta));
}
