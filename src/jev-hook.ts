#!/usr/bin/env node
// UserPromptSubmit hook for Claude Code (`--app claude`, default) and Codex (`--app codex`).
// - Records which chat the user last typed in (for the Jev side panel).
// - `#jev …` commands: pure commands are answered in the chat and never reach the
//   model; any command followed by text lets that text through.
// - Guard mode (`#jev an`, per chat): Jev itself first answers whether the message is a
//   new task at all. Only then does the policy check model (published benchmarks,
//   src/model-policy.ts) and effort (weighted per-model evidence, src/model-spectrum.ts).
//   Fits: a ✓ line. One step off: a card in the chat and the Jev figure at the app's
//   bottom right; the message runs on. Two or more steps off: the message is held once,
//   and sending it again lets it through (user rule).
// - Neither app lets a plugin change model or effort. Verified live in the Claude desktop
//   app 2.1.281: skill frontmatter `model`/`effort` changed Claude Code's internal state,
//   but every request of that message still went out with the menu's model and effort.
//   Codex hooks and skills have no override at all. So Jev recommends; the user switches.
import { mkdirSync, writeFileSync, renameSync, readFileSync, openSync, readSync, closeSync, statSync, realpathSync, appendFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLAUDE_TIERS, EFFORTS, codexTiers, guardDecision, inspectChat, inspectLabels, modelDisplay, pickEffort, readClaudeSession, tierOf, type InspectResult, type ModelTier } from './chat-inspect.js';
import { codexTurnSettings, findCodexRollout, readCodexCatalog, readCodexRollout } from './codex-rollout.js';
import { BENCHMARKS, BENCHMARKS_AS_OF, MODEL_FACTS, modelKey } from './model-benchmarks.js';
import { DIFFICULTIES, MIN_SAVING, MIN_SWITCH_POINTS, SPECTRUM_MIN_GAP, TASK_KINDS, TOLERANCE, decideModel, spectrumEffort, type PolicyResult } from './model-policy.js';
import { describeContext, type HistoryTurn } from './routing-context.js';
import { gatewayKey } from './gateway-key.js';
import { stateDirectory } from './state-dir.js';

export type Focus = { kind: 'claude' | 'codex'; id: string; at: number; cwd?: string | null };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Jev's probability that a message is a new task must reach this before model and effort are checked. */
export const NEW_TASK_MIN = 0.5;

function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, file);
}
function readJson(file: string): any { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function readTail(path: string, maxBytes: number): string[] {
  const size = statSync(path).size, len = Math.min(size, maxBytes);
  const fd = openSync(path, 'r'); const buf = Buffer.alloc(len);
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  return len < size ? lines.slice(1) : lines; // the first line of a partial read is cut off
}

export function focusFile(stateDir: string) { return join(stateDir, 'focus.json'); }
export function writeFocus(stateDir: string, focus: Focus) { writeJson(focusFile(stateDir), focus); }
export function readFocus(stateDir: string): Focus | null {
  const f = readJson(focusFile(stateDir));
  return f && (f.kind === 'claude' || f.kind === 'codex') && SESSION_ID.test(f.id) && Number.isFinite(f.at) ? f : null;
}
// Guard mode is switched on per chat and stays on until switched off.
export const guardEnabled = (stateDir: string, session: string) => readJson(join(stateDir, 'guard.json'))?.sessions?.[session] === true;
export function setGuard(stateDir: string, session: string, enabled: boolean) {
  const file = join(stateDir, 'guard.json'); const state = readJson(file) ?? {};
  const sessions = { ...(state.sessions ?? {}) };
  if (enabled) sessions[session] = true; else delete sessions[session];
  writeJson(file, { sessions });
}
/** True when the recommended tier is the tier the chat already uses. */
export function sameModel(current: string | null, recommended: string, tiers: ModelTier[] = CLAUDE_TIERS): boolean {
  const t = tierOf(current, tiers); return Boolean(t) && (t!.id === recommended || t!.id === tierOf(recommended, tiers)?.id);
}
/** Same model version (not just the same tier): "claude-haiku-4-5-20251001" equals "claude-haiku-4-5". */
export const sameKey = (a?: string | null, b?: string | null) => !!a && !!b && (modelKey(a) ?? a.toLowerCase()) === (modelKey(b) ?? b.toLowerCase());

export type JevCommand =
  | { kind: 'analyze' }                                // "#jev": analyze this chat, nothing is sent
  | { kind: 'once'; task: string }                     // "#jev <Text>": the text is sent, Jev looks at it once
  | { kind: 'question'; question?: string }            // "#jev? <Frage>": yes/no question to Jev, nothing is sent
  | { kind: 'guard'; enabled: boolean; rest?: string } // "#jev an [Text]" / "#jev aus [Text]": the text is sent
  | { kind: 'help' } | { kind: 'status' }
  | { kind: 'badge'; action: 'an' | 'aus' | 'test' };     // "#jev figur an|aus|test"
export function parseJevCommand(prompt: string): JevCommand | null {
  const m = /^\s*#jev(\?)?(?:\s+([\s\S]*))?$/i.exec(prompt);
  if (!m) return null;
  const rest = m[2]?.trim() || undefined;
  if (m[1]) return { kind: 'question', question: rest };
  if (!rest) return { kind: 'analyze' };
  const onOff = /^(an|ein|on|aus|off)(?![\p{L}\p{N}])[\s:,.!–-]*([\s\S]*)$/iu.exec(rest);
  if (onOff) { const text = onOff[2]!.trim(); return { kind: 'guard', enabled: !/^(aus|off)$/i.test(onOff[1]!), ...(text ? { rest: text } : {}) }; }
  if (/^(hilfe|help|\?)$/i.test(rest)) return { kind: 'help' };
  if (/^status$/i.test(rest)) return { kind: 'status' };
  const figure = /^figur\s+(an|ein|on|aus|off|test)$/i.exec(rest);
  if (figure) { const w = figure[1]!.toLowerCase(); return { kind: 'badge', action: w === 'test' ? 'test' : /^(aus|off)$/.test(w) ? 'aus' : 'an' }; }
  return { kind: 'once', task: rest };
}

/** The model of the latest assistant message in a Claude transcript, if any. */
export function currentModel(transcriptPath: string): string | null {
  try {
    const text = readTail(transcriptPath, 524_288).join('\n');
    const models = [...text.matchAll(/"role":"assistant"[^\n]*?"model":"([a-z0-9.\-\[\]]+)"|"model":"(claude-[a-z0-9.\-\[\]]+)"[^\n]*?"role":"assistant"/g)];
    const last = models.at(-1); return last ? (last[1] ?? last[2] ?? null) : null;
  } catch { return null; }
}
const settingsModel = (settingsPath = join(homedir(), '.claude', 'settings.json')): string | null => {
  const model = readJson(settingsPath)?.model; return typeof model === 'string' && model ? model : null;
};
/** Current Claude model from the transcript, else the model configured in Claude Code settings. */
export function effectiveModel(transcriptPath: string, settingsPath = join(homedir(), '.claude', 'settings.json')): string | null {
  return currentModel(transcriptPath) ?? settingsModel(settingsPath);
}
export type Setting = { model: string | null; effort: string | null };
/** Model and effort the latest reply of a Claude Code transcript really ran on (`message.model`, `perTurnEffort`). */
export function claudeSetting(transcriptPath: string, maxBytes = 4 * 1024 * 1024): Setting {
  try {
    const lines = readTail(transcriptPath, maxBytes);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"assistant"')) continue;
      let o: any; try { o = JSON.parse(lines[i]!); } catch { continue; }
      const model = o.message?.model;
      if (o.type !== 'assistant' || o.isSidechain || typeof model !== 'string' || model === '<synthetic>') continue;
      return { model, effort: typeof o.perTurnEffort === 'string' ? o.perTurnEffort : typeof o.effort === 'string' ? o.effort : null };
    }
  } catch {}
  return { model: null, effort: null };
}
/** Where the Claude desktop app keeps each chat's menu setting (`model`, `effort`, `cliSessionId`). */
export const claudeDesktopSessions = () => process.env.JEV_CLAUDE_DESKTOP_SESSIONS ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
/** The live menu setting of a Claude desktop chat, or null outside the desktop app. Read-only. */
export function claudeMenu(cliSessionId: string, root = claudeDesktopSessions()): Setting | null {
  if (!SESSION_ID.test(cliSessionId)) return null;
  try {
    for (const account of readdirSync(root, { withFileTypes: true })) {
      if (!account.isDirectory()) continue;
      for (const org of readdirSync(join(root, account.name), { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        const dir = join(root, account.name, org.name);
        for (const file of readdirSync(dir)) {
          if (!/^local_[\w-]+\.json$/.test(file)) continue;
          const text = readFileSync(join(dir, file), 'utf8');
          if (!text.includes(`"${cliSessionId}"`)) continue;
          const o = JSON.parse(text);
          if (o.cliSessionId !== cliSessionId) continue;
          return { model: typeof o.model === 'string' ? o.model : null, effort: typeof o.effort === 'string' ? o.effort : null };
        }
      }
    }
  } catch {}
  return null;
}

// ---------- app profiles ----------
export type AppProfile = {
  kind: 'claude' | 'codex'; name: string; tiers: ModelTier[]; candidates: string[];
  readTurns: () => HistoryTurn[]; current: () => Setting;
  efforts: (model: string) => string[]; display: (model: string | null) => string;
};
const CLAUDE_EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function claudeProfile(event: any): AppProfile {
  const path = String(event.transcript_path ?? '');
  let current: Setting | null = null;
  return { kind: 'claude', name: 'Claude', tiers: CLAUDE_TIERS,
    candidates: Object.keys(MODEL_FACTS).filter(k => MODEL_FACTS[k]!.app === 'claude'),
    readTurns: () => readClaudeSession(path),
    // The desktop app's live menu first (it changes before any reply shows it), else the latest reply, else settings.
    current: () => current ??= (() => {
      const menu = claudeMenu(String(event.session_id ?? ''));
      const s = path ? claudeSetting(path) : { model: null, effort: null };
      return { model: menu?.model ?? s.model ?? settingsModel(), effort: menu?.model ? menu.effort : s.effort };
    })(),
    // Haiku 4.5 has no effort setting; the Claude 5 family offers low…max.
    efforts: model => /haiku/i.test(model) ? [] : CLAUDE_EFFORT_IDS,
    display: model => model ? (MODEL_FACTS[modelKey(model) ?? '']?.label ?? modelDisplay(model)) : 'unbekannt' };
}
export function codexProfile(event: any): AppProfile {
  const catalog = readCodexCatalog();
  const path = String(event.transcript_path ?? '') || findCodexRollout(String(event.session_id ?? '')) || '';
  const settings = path ? codexTurnSettings(path) : { model: null, effort: null };
  return { kind: 'codex', name: 'Codex', tiers: codexTiers(catalog),
    candidates: catalog.map(m => m.slug).filter(s => !/auto-review/i.test(s)),
    readTurns: () => path ? readCodexRollout(path) : [],
    current: () => ({ model: typeof event.model === 'string' && event.model ? event.model : settings.model, effort: settings.effort }),
    efforts: model => (catalog.find(m => m.slug === model)?.supported_reasoning_levels ?? []).map(l => l.effort),
    display: model => model ? (catalog.find(m => m.slug === model)?.display_name ?? MODEL_FACTS[model]?.label ?? model) : 'unbekannt' };
}

// ---------- recommendation ----------
export type Recommendation = {
  model: string | null; interrupt: boolean; why: string; basis: 'benchmark' | 'simple' | 'spectrum' | 'tier';
  effort: string | null; effortSource: 'erfahrung' | 'jev' | null; effortAvoidFrom: string | null;
  currentEffort: string | null; current: string | null; policy: PolicyResult | null;
};
const pct = (p: number | undefined) => `${Math.round((p ?? 0) * 100)} %`;
const num = (n: number) => n.toFixed(1).replace('.', ',');
const KIND_LABEL: Record<string, string> = { coding: 'Coding', agentic: 'Agent/Terminal', reasoning: 'Denken/Analyse', research: 'Recherche', simple: 'Einfach' };
const DIFF_LABEL: Record<string, string> = { easy: 'leicht', normal: 'normal', hard: 'schwer' };
type JevAnswer = Extract<InspectResult, { ok: true }>;

export type EffortPick = { effort: string | null; source: 'erfahrung' | 'jev' | null; avoidFrom: string | null };
/** Effort differs per model: the level the weighted evidence points to for THIS model if the app offers it, else Jev's estimate. */
export function effortFor(model: string | null, r: JevAnswer, app: AppProfile): EffortPick {
  const offered = model ? app.efforts(model) : app.kind === 'claude' ? CLAUDE_EFFORT_IDS : [];
  const kind = (r.taskKind?.choice ?? 'coding') as keyof typeof TASK_KINDS;
  const fromSpectrum = model ? spectrumEffort(model, kind) : null;
  const useSpectrum = !!fromSpectrum && offered.includes(fromSpectrum.effort);
  let effort = useSpectrum ? fromSpectrum!.effort : pickEffort(r.effort, offered);
  // The evidence names a model's usual sweet spot; a hard task gets one level more, never into the range rated "too much".
  if (useSpectrum && r.difficulty?.choice === 'hard') {
    const ladder = [...offered].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    const next = ladder[ladder.indexOf(effort!) + 1], avoid = fromSpectrum!.avoidFrom;
    if (next && (!avoid || EFFORT_ORDER.indexOf(next) < EFFORT_ORDER.indexOf(avoid))) effort = next;
  }
  return { effort, source: effort ? (useSpectrum ? 'erfahrung' : 'jev') : null,
    avoidFrom: useSpectrum && fromSpectrum!.avoidFrom && offered.includes(fromSpectrum!.avoidFrom) ? fromSpectrum!.avoidFrom : null };
}

export function recommend(r: JevAnswer, app: AppProfile): Recommendation {
  const cur = app.current();
  const policy = r.taskKind && r.difficulty
    ? decideModel({ kind: r.taskKind.choice as keyof typeof TASK_KINDS, difficulty: r.difficulty.choice as keyof typeof DIFFICULTIES, current: cur.model, candidates: app.candidates })
    : null;
  let model: string | null = null, interrupt = false, why = '', basis: Recommendation['basis'] = 'tier';
  if (policy && policy.basis === 'benchmark') {
    basis = 'benchmark'; model = policy.recommended; interrupt = policy.interrupt;
    const b = BENCHMARKS[policy.benchmark];
    const list = policy.scores.slice(0, 4).map(s => `${app.display(s.model)} ${num(s.score)}`).join(' · ');
    const tol = TOLERANCE[r.difficulty!.choice as keyof typeof TOLERANCE];
    const vetoNote = policy.vetoedModels.length ? ` Ausgeschlossen nach Erfahrungswerten: ${policy.vetoedModels.map(m => app.display(m)).join(', ')}.` : '';
    why = `${b.name} (${b.kind === 'vendor' ? 'Herstellerangaben' : 'unabhängig'}): ${list}.${vetoNote} `
      + (policy.reason === 'current-vetoed' ? `Viele glaubwürdige Stimmen halten ${app.display(cur.model)} für diese Aufgabe für schwach – ${app.display(model)} empfohlen.`
        : policy.reason === 'quality-gap' ? `${app.display(model)} liegt ${num(policy.gap)} Punkte vor ${app.display(cur.model)} (Schwelle ${MIN_SWITCH_POINTS}).`
        : policy.reason === 'gap-below-threshold' ? `Unterschied nur ${num(policy.gap)} Punkte – unter der Schwelle von ${MIN_SWITCH_POINTS}, kein Wechsel nötig.`
        : policy.reason === 'saving' ? `${app.display(cur.model)} ist nicht besser als ${tol} Punkte (Toleranz „${DIFF_LABEL[r.difficulty!.choice]}“), ${app.display(model)} kostet mindestens ${Math.round(MIN_SAVING * 100)} % weniger.`
        : `${app.display(cur.model)} liegt innerhalb von ${tol} Punkten zum Besten (Toleranz „${DIFF_LABEL[r.difficulty!.choice]}“) – passt.`);
  } else if (policy && policy.basis === 'spectrum') {
    basis = 'spectrum'; model = policy.recommended; interrupt = policy.interrupt;
    const list = policy.scores.slice(0, 4).map(s => `${app.display(s.model)} ${s.score > 0 ? '+' : ''}${s.score}`).join(' · ');
    why = `Erfahrungswerte (gewichtet, −100…+100): ${list}. `
      + (policy.reason === 'current-vetoed' ? `${app.display(cur.model)} gilt für diese Aufgabe als schwach.`
        : policy.reason === 'spectrum-gap' ? `${app.display(model)} liegt ${policy.gap} Punkte vorn (Schwelle ${SPECTRUM_MIN_GAP}).`
        : `${app.display(cur.model)} passt.`);
  } else if (policy && policy.basis === 'simple') {
    basis = 'simple'; model = policy.recommended; interrupt = policy.interrupt;
    why = policy.reason === 'saving' ? `Einfache Aufgabe: ${app.display(model)} reicht und kostet mindestens ${Math.round(MIN_SAVING * 100)} % weniger als ${app.display(cur.model)}.` : `Einfache Aufgabe: ${app.display(cur.model)} ist bereits günstig genug.`;
  } else if (r.nextModel) {
    // No comparable published scores for the current model: fall back to Jev's tier judgment.
    const d = guardDecision(cur.model, r.nextModel, app.tiers);
    model = d.recommended.defaultModel; interrupt = d.interrupt;
    why = `Keine vergleichbaren Benchmarkwerte für ${app.display(cur.model)} – Jevs Stufen-Einschätzung: ${d.recommended.label} (${pct(r.nextModel.probabilities[d.recommended.id])})`
      + (d.reason === 'same-tier' ? ', gleiche Stufe – passt.' : d.reason === 'unclear' ? ', nicht deutlich genug für einen Wechsel.' : d.reason === 'unknown-current' ? ', aktuelles Modell unbekannt.' : '.');
    if (d.reason === 'same-tier' || d.reason === 'unclear' || d.reason === 'unknown-current') model = cur.model ?? model;
  }
  const e = effortFor(model ?? cur.model, r, app);
  return { model, interrupt, why, basis, effort: e.effort, effortSource: e.source, effortAvoidFrom: e.avoidFrom,
    currentEffort: cur.effort, current: cur.model, policy };
}

function shortWhy(rec: Recommendation, app: AppProfile, target: string | null, running: string | null): string {
  const p = rec.policy, d = app.display;
  if (p?.basis === 'benchmark' || p?.basis === 'spectrum') {
    const score = (m: string | null) => p.scores.find(x => sameKey(x.model, m))?.score;
    const fmt = (n: number | undefined) => n === undefined ? '?' : p.basis === 'benchmark' ? num(n) : `${n > 0 ? '+' : ''}${n}`;
    const head = p.basis === 'benchmark' ? BENCHMARKS[p.benchmark].name : 'Erfahrungswerte';
    return `${head}: ${d(target)} ${fmt(score(target))} · ${d(running)} ${fmt(score(running))}`
      + (p.reason === 'saving' ? ` – gleich gut, mind. ${Math.round(MIN_SAVING * 100)} % günstiger` : p.reason === 'current-vetoed' ? ` – ${d(running)} gilt hier als schwach` : '');
  }
  if (p?.basis === 'simple') return `einfache Aufgabe, reicht und kostet mind. ${Math.round(MIN_SAVING * 100)} % weniger`;
  return 'Jev-Einschätzung der Aufgabe';
}
const effortName = (e: string | null | undefined) => e ? (EFFORTS.find(x => x.id === e)?.label ?? e) : null;
const showSetting = (display: (m: string | null) => string, s: Setting) =>
  [display(s.model), /haiku/i.test(s.model ?? '') ? null : effortName(s.effort)].filter(Boolean).join(' · ');

/** Effort levels of both apps, low → high (Codex adds `ultra`). */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** A setting this many steps away from Jev's recommendation holds the message once; one step only adds a note (user rule). */
export const STOP_STEPS = 2;
export type Assessment = {
  level: 'fits' | 'note' | 'stop';
  kind: 'model' | 'effort' | null;  // a model switch outranks an effort change
  task: string;                     // e.g. "Coding, normal"
  cur: Setting; target: string | null; effort: string | null;
  modelSteps: number;               // capability tiers between the current and the recommended model
  effortSteps: number;              // effort levels between the current and the recommended effort
  ladder: string[];                 // effort levels the current model offers, low → high
  why: string;
};
/** How far the current setting is from what fits this task, in steps. */
export function assess(r: JevAnswer, app: AppProfile, rec = recommend(r, app)): Assessment {
  const cur = app.current();
  const task = r.taskKind && r.difficulty ? `${KIND_LABEL[r.taskKind.choice] ?? r.taskKind.choice}, ${DIFF_LABEL[r.difficulty.choice] ?? r.difficulty.choice}` : '';
  const switchModel = Boolean(rec.interrupt && rec.model && cur.model && !sameKey(rec.model, cur.model));
  const target = switchModel ? rec.model : cur.model ?? rec.model;
  const effort = effortFor(target, r, app).effort;
  const rank = (m: string | null) => tierOf(m, app.tiers)?.rank ?? null;
  const [rt, rc] = [rank(target), rank(cur.model)];
  const modelSteps = switchModel ? Math.max(1, rt !== null && rc !== null ? Math.abs(rt - rc) : 1) : 0;
  const ladder = cur.model ? [...app.efforts(cur.model)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)) : [];
  const effortSteps = !switchModel && effort && cur.effort && ladder.includes(effort) && ladder.includes(cur.effort) ? Math.abs(ladder.indexOf(effort) - ladder.indexOf(cur.effort)) : 0;
  const steps = Math.max(modelSteps, effortSteps);
  return { level: steps >= STOP_STEPS ? 'stop' : steps >= 1 ? 'note' : 'fits', kind: switchModel ? 'model' : effortSteps ? 'effort' : null,
    task, cur, target, effort, modelSteps, effortSteps, ladder, why: switchModel ? shortWhy(rec, app, target, cur.model) : '' };
}

export type Card = { text: string; badge: { title: string; body: string } | null };
/** The visible result: one ✓ line when everything fits, else a card (and a badge for the Jev figure). */
export function jevCard(a: Assessment, app: AppProfile): Card {
  const d = app.display, codex = app.kind === 'codex', stop = a.level === 'stop';
  const effortWord = codex ? 'Denkaufwand' : 'Effort', task = a.task ? ` (${a.task})` : '';
  const menu = codex ? 'Im Modellmenü' : 'Unten rechts';
  const onlyTip = 'Nur eine Empfehlung – noch nicht umgestellt. Die aktuelle Nachricht läuft weiter.';
  const asIs = 'Ohne Umstellen erneut senden = sie läuft so, wie es gerade eingestellt ist.';
  const badgeBody = stop ? 'Nachricht angehalten – umstellen, dann erneut senden' : `${menu} umstellen · die Nachricht läuft weiter`;
  if (!a.cur.model) return { text: `Jev${task}: empfohlen ${showSetting(d, { model: a.target, effort: a.effort })} – die aktuelle Einstellung ist noch unbekannt.`, badge: null };
  if (a.kind === 'model') {
    const [from, to] = [tierOf(a.cur.model, app.tiers)?.label, tierOf(a.target, app.tiers)?.label];
    const set = `das Modell auf „${d(a.target)}“${a.effort ? ` und den ${effortWord} auf „${effortName(a.effort)}“` : ''} stellen`;
    return { text: [stop ? `⛔ JEV · ANGEHALTEN – MODELL ${a.modelSteps} STUFEN DANEBEN` : '⚙ JEV · MODELL: BESSERE WAHL',
      `${showSetting(d, a.cur)} → ${showSetting(d, { model: a.target, effort: a.effort })}${from && to && from !== to ? `   (${from} → ${to})` : ''}`,
      `Grund: ${a.why}.`,
      ...(stop ? [`So geht's weiter: ${menu.toLowerCase()} ${set} und die Nachricht erneut senden.`, asIs] : [`${menu} ${set}. ${onlyTip}`])].join('\n'),
      badge: { title: `Modell → ${d(a.target)}`, body: badgeBody } };
  }
  if (a.kind === 'effort') {
    const up = a.ladder.indexOf(a.effort!) > a.ladder.indexOf(a.cur.effort!);
    const steps = `${a.effortSteps} ${a.effortSteps === 1 ? 'STUFE' : 'STUFEN'} ${up ? 'ZU NIEDRIG' : 'ZU HOCH'}`;
    const scale = a.ladder.map(e => `${e === a.effort ? '◆' : e === a.cur.effort ? '●' : '○'} ${effortName(e)}`).join('   ');
    const how = `${menu} den ${effortWord} auf „${effortName(a.effort)}“ stellen`;
    return { text: [stop ? `⛔ JEV · ANGEHALTEN – ${effortWord.toUpperCase()} ${steps}` : `⚙ JEV · ${effortWord.toUpperCase()} ÄNDERN – ${steps}`,
      `${effortName(a.cur.effort)} → ${effortName(a.effort)} (${a.effort})`,
      `${scale}      ◆ empfohlen  ● eingestellt`,
      `${d(a.cur.model)} passt${task}.`,
      ...(stop ? [`So geht's weiter: ${how.charAt(0).toLowerCase()}${how.slice(1)} und die Nachricht erneut senden.`, asIs] : [`${how}. ${onlyTip}`])].join('\n'),
      badge: { title: `${effortWord} → ${effortName(a.effort)}`, body: badgeBody } };
  }
  const tip = !a.cur.effort && a.effort && a.ladder.length ? ` Empfohlener ${effortWord}: ${effortName(a.effort)}.` : '';
  return { text: `✓ Jev${task}: ${showSetting(d, a.cur)} passt.${tip}`, badge: null };
}
/** The card text for a Jev answer (kept for callers of the one-line version). */
export const recommendationLine = (r: JevAnswer, app: AppProfile, rec = recommend(r, app)) => jevCard(assess(r, app, rec), app).text;

export const HELP = (app = 'Claude') => [
  `Jev-Befehle (Befehle ohne Text werden nicht an ${app} gesendet):`,
  '  #jev an [Text]      – Jev für DIESEN Chat einschalten; ein Text dahinter wird ganz normal gesendet',
  '  #jev aus [Text]     – Jev ausschalten',
  '  #jev <Text>         – Text senden, Jev schaut einmal drauf',
  '  #jev                – diesen Chat analysieren',
  '  #jev? <Frage>       – Ja/Nein-Frage zum Chat an Jev, Antwort in %',
  '  #jev status         – aktuelle Einstellung und Jevs letzte Einschätzung',
  '  #jev figur an|aus   – die Jev-Figur unten rechts am Fenster ein- oder ausschalten (#jev figur test zeigt sie)',
].join('\n');
const GUARD_ON = (app: string) => [
  'Jev ist für DIESEN Chat AN – ab jetzt ohne #jev.',
  '• Jev prüft jede Nachricht zuerst selbst: Ist das eine neue Aufgabe? Wenn nicht (Antwort, „weiter“, Rückfrage), passiert nichts.',
  '• Passen Modell und Effort, steht nur ein ✓ im Chat.',
  '• 1 Stufe daneben: ein Hinweis im Chat und die Jev-Figur unten rechts – die Nachricht läuft weiter.',
  `• ${STOP_STEPS} oder mehr Stufen daneben: Die Nachricht wird angehalten. Umstellen und erneut senden – oder einfach erneut senden, dann läuft sie so.`,
  `• Umstellen musst du selbst: ${app} lässt Modell und Effort nicht von Plugins ändern.`,
  'Status: #jev status · Figur aus: #jev figur aus · Ausschalten: #jev aus',
].join('\n');

export function formatResult(r: InspectResult, description: string | null, app: AppProfile): string {
  if (!r.ok) return `Jev konnte nicht antworten (${r.reason}). Keine Werte erfunden, kein Neuversuch.`;
  const L = inspectLabels as Record<string, Record<string, string>>;
  const lines = ['Jev – Stand dieses Chats',
    `  Chat:    ${L.progress![r.progress.choice] ?? r.progress.choice} · Hindernis: ${L.blocker![r.blocker.choice] ?? r.blocker.choice} · nächster Schritt: ${L.next_step![r.next_step.choice] ?? r.next_step.choice}`];
  if (r.question) lines.push(`  Frage:   „${r.question.text}“ → ${pct(r.question.yes)} ja`);
  lines.push(`Gelesen: ${description ?? '–'} · ${r.usage.input_tokens} Tokens. Benchmarks Stand ${BENCHMARKS_AS_OF}; Jev ordnet nur ein – keine Garantie.`);
  return lines.join('\n');
}

/** Local decision log (no prompt text) so recommendations can later be checked against what actually happened. */
export function logDecision(stateDir: string, entry: Record<string, unknown>) {
  try { mkdirSync(stateDir, { recursive: true }); appendFileSync(join(stateDir, 'guard-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}
function lastDecision(stateDir: string, session: string): Record<string, any> | null {
  try {
    const lines = readTail(join(stateDir, 'guard-log.jsonl'), 262_144);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o: any; try { o = JSON.parse(lines[i]!); } catch { continue; }
      if (o.session === session && ['checked', 'no-new-task', 'failed'].includes(o.event)) return o;
    }
  } catch {}
  return null;
}
const block = (reason: string): void => { process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n'); };

async function runJev(app: AppProfile, opts: { task?: string; question?: string; gate?: boolean }) {
  return inspectChat({ turns: app.readTurns(), question: opts.question, task: opts.task, gate: opts.gate,
    models: opts.task ? app.tiers : undefined, efforts: opts.task ? EFFORTS : undefined, key: gatewayKey(),
    source: app.kind === 'claude' ? 'Claude Code session' : 'Codex conversation' });
}

// ---------- held messages ----------
/** After a hold, the next message in that chat within this window passes unchecked: set up, or deliberately as is. */
export const PASS_WINDOW_MS = 15 * 60_000;
const passFile = (stateDir: string, session: string) => join(stateDir, 'held', `${session.replace(/[^0-9a-z-]/gi, '')}.json`);
export function markHeld(stateDir: string, session: string, at = Date.now()) { writeJson(passFile(stateDir, session), { at }); }
/** True (and consumed) when the previous message of this chat was held a moment ago. */
export function takePass(stateDir: string, session: string, now = Date.now()): boolean {
  const held = readJson(passFile(stateDir, session));
  if (!held) return false;
  try { rmSync(passFile(stateDir, session)); } catch {}
  return Number.isFinite(held.at) && now - held.at < PASS_WINDOW_MS;
}

// ---------- the Jev figure (Windows) ----------
const settingsFile = (stateDir: string) => join(stateDir, 'settings.json');
export const badgeEnabled = (stateDir: string) => readJson(settingsFile(stateDir))?.badge !== false;
export function setBadge(stateDir: string, enabled: boolean) { writeJson(settingsFile(stateDir), { ...(readJson(settingsFile(stateDir)) ?? {}), badge: enabled }); }
/**
 * Shows the Jev figure next to the app's bottom-right corner, where the model and effort menus
 * are: a small always-on-top note that never takes the focus and closes itself (src/jev-badge.ps1).
 * The texts go through a UTF-8 file, never the command line; a newer figure rewrites it and the
 * older one closes. Started via `cmd /c start`: PowerShell 5.1 spawned directly as a detached
 * Node child exits at once without running the script (tested). Windows only.
 */
export function showBadge(stateDir: string, appKind: 'claude' | 'codex', level: 'note' | 'stop', badge: { title: string; body: string }): boolean {
  if (process.platform !== 'win32' || !badgeEnabled(stateDir)) return false;
  let script: string;
  try { script = join(dirname(fileURLToPath(import.meta.url)), 'jev-badge.ps1'); } catch { return false; }
  if (!existsSync(script)) return false;
  const spec = join(stateDir, 'badge.json');
  try { writeJson(spec, { id: randomUUID(), app: appKind, level, title: badge.title, body: badge.body, seconds: level === 'stop' ? 45 : 15 }); } catch { return false; }
  try {
    spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', '/b', 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Spec', spec],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch { return false; }
}

/**
 * Looks at one message. `gate`: Jev first decides whether it is a new task at all.
 * Fits: one ✓ line. One step off: a card and the Jev figure, the message runs on.
 * Two or more steps off: the message is held once with the card; sending again passes.
 * `command`: the "#jev …" prefix the model should ignore. `lead`: text before Jev's card.
 */
export async function checkMessage(event: any, appKind: 'claude' | 'codex', app: AppProfile, session: string, prompt: string, stateDir: string,
  opts: { gate: boolean; command?: string; lead?: string }): Promise<void> {
  const emit = (line: string | null) => {
    const out: Record<string, unknown> = {};
    const text = [opts.lead, line].filter(Boolean).join(line?.includes('\n') ? '\n' : ' ');
    if (text) out.systemMessage = text;
    if (opts.command) out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: `Hinweis: Das vorangestellte „${opts.command}“ ist ein Befehl an das Jev-Plugin und gehört nicht zur Nachricht.` };
    if (Object.keys(out).length) process.stdout.write(JSON.stringify(out) + '\n');
  };
  if (takePass(stateDir, session)) {
    logDecision(stateDir, { event: 'passed-after-hold', app: appKind, session, current: app.current() });
    return emit('Jev: Die angehaltene Nachricht geht jetzt durch.');
  }
  let r: InspectResult;
  try { r = await runJev(app, { task: prompt, gate: opts.gate }); }
  catch (e) { return emit(`Jev: keine Einschätzung (${e instanceof Error ? e.message : 'Fehler'}) – die Nachricht läuft normal.`); }
  if (!r.ok) { logDecision(stateDir, { event: 'failed', app: appKind, session, reason: r.reason }); return emit(`Jev: keine Einschätzung (${r.reason}) – die Nachricht läuft normal.`); }
  if (opts.gate && r.newTask && r.newTask.yes < NEW_TASK_MIN) {
    logDecision(stateDir, { event: 'no-new-task', app: appKind, session, newTask: r.newTask.yes });
    return emit(null);
  }
  const rec = recommend(r, app), a = assess(r, app, rec), card = jevCard(a, app);
  logDecision(stateDir, { event: 'checked', app: appKind, session, newTask: r.newTask?.yes ?? null, current: a.cur, recommended: a.target, effort: a.effort,
    level: a.level, modelSteps: a.modelSteps, effortSteps: a.effortSteps, taskKind: r.taskKind?.choice ?? null, difficulty: r.difficulty?.choice ?? null,
    reason: rec.policy && 'reason' in rec.policy ? rec.policy.reason : null, line: card.text.split('\n')[0] });
  if (card.badge && a.level !== 'fits') showBadge(stateDir, appKind, a.level, card.badge);
  if (a.level === 'stop') { markHeld(stateDir, session); return block([opts.lead, card.text].filter(Boolean).join('\n')); }
  emit(card.text);
}

function statusText(appKind: 'claude' | 'codex', session: string, stateDir: string, app: AppProfile): string {
  const on = guardEnabled(stateDir, session), last = lastDecision(stateDir, session);
  const source = appKind === 'codex' ? 'laut Verlauf' : claudeMenu(session) ? 'laut Menü der App' : 'laut letzter Antwort';
  return ['Jev-Status für diesen Chat',
    `  Jev:          ${on ? `AN – prüft jede Nachricht selbst; ab ${STOP_STEPS} Stufen daneben wird einmal angehalten` : 'AUS (einschalten: #jev an)'}`,
    `  Eingestellt:  ${showSetting(app.display, app.current())} (${source})`,
    last ? `  Zuletzt:      ${last.event === 'no-new-task' ? 'keine neue Aufgabe – nichts zu tun' : last.event === 'failed' ? `keine Einschätzung (${last.reason})` : last.line}` : null,
    `  Jev-Figur:    ${badgeEnabled(stateDir) ? 'an' : 'aus'}${process.platform === 'win32' ? '' : ' (nur unter Windows)'}`,
    `  Umstellen geht nur im Menü: ${app.name} lässt Modell und Effort nicht von Plugins ändern.`,
  ].filter(Boolean).join('\n');
}

export async function handle(event: any, appKind: 'claude' | 'codex', stateDir = stateDirectory()): Promise<void> {
  const session = String(event.session_id ?? event.thread_id ?? '');
  if (SESSION_ID.test(session)) { try { writeFocus(stateDir, { kind: appKind, id: session, at: Date.now(), cwd: event.cwd ?? null }); } catch {} }
  const prompt = String(event.prompt ?? '');
  const command = parseJevCommand(prompt);
  const app = appKind === 'codex' ? codexProfile(event) : claudeProfile(event);
  const commandWord = (text: string) => prompt.trim().slice(0, prompt.trim().length - text.length).trim();

  if (command) {
    if (command.kind === 'help') return block(HELP(app.name));
    if (command.kind === 'status') return block(statusText(appKind, session, stateDir, app));
    if (command.kind === 'badge') {
      if (command.action !== 'test') { setBadge(stateDir, command.action === 'an'); return block(`Jev-Figur ist ${command.action === 'an' ? 'AN – sie erscheint unten rechts am Fenster, wenn Modell oder Effort nicht passen' : 'AUS – Jev meldet sich nur noch im Chat'}.`); }
      const shown = showBadge(stateDir, appKind, 'note', { title: `${appKind === 'codex' ? 'Denkaufwand' : 'Effort'} → Mittel`, body: 'So sieht die Jev-Figur aus · ein Klick schließt sie' });
      return block(shown ? 'Jev-Figur: Test läuft – sie erscheint gleich unten rechts am Fenster und verschwindet nach 15 Sekunden.' : 'Jev-Figur ist aus (#jev figur an) oder hier nicht verfügbar (nur Windows).');
    }
    if (command.kind === 'guard') {
      if (!SESSION_ID.test(session)) return command.rest ? undefined : block('Jev: Dieser Chat hat keine erkennbare ID – nicht aktiviert.');
      setGuard(stateDir, session, command.enabled);
      if (!command.rest) return block(command.enabled ? GUARD_ON(app.name) : `Jev ist für diesen Chat AUS. Nachrichten gehen wieder unverändert an ${app.name}.`);
      // Text after the command is a normal message: never hold it back.
      if (!command.enabled) { process.stdout.write(JSON.stringify({ systemMessage: 'Jev ist für diesen Chat jetzt AUS.', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Hinweis: Das vorangestellte „${commandWord(command.rest)}“ ist ein Befehl an das Jev-Plugin und gehört nicht zur Nachricht.` } }) + '\n'); return; }
      return checkMessage(event, appKind, app, session, command.rest, stateDir, { gate: false, command: commandWord(command.rest), lead: 'Jev ist für diesen Chat jetzt AN.' });
    }
    if (command.kind === 'once') return checkMessage(event, appKind, app, session, command.task, stateDir, { gate: false, command: commandWord(command.task) });
    try {
      const r = await runJev(app, command.kind === 'question' ? { question: command.question } : {});
      return block(formatResult(r, r.stats ? describeContext(r.stats) : null, app));
    } catch (e) { return block(`Jev konnte den Chat nicht lesen (${e instanceof Error ? e.message : 'Fehler'}).`); }
  }

  // Guard mode: every message except slash commands; Jev decides whether it needs a look.
  if (!guardEnabled(stateDir, session) || prompt.trim().startsWith('/')) return;
  try { await checkMessage(event, appKind, app, session, prompt, stateDir, { gate: true }); } catch { /* never hold up the user's work because of Jev */ }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2_000_000) return; }
  let event: any; try { event = JSON.parse(raw); } catch { return; }
  const appArg = process.argv.indexOf('--app');
  await handle(event, process.argv[appArg + 1] === 'codex' && appArg > 0 ? 'codex' : 'claude');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => {}).finally(() => { process.exitCode = 0; });
