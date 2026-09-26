#!/usr/bin/env node
// UserPromptSubmit hook for Claude Code (`--app claude`, default) and Codex (`--app codex`).
// - Records which chat the user last typed in (for the Jev side panel).
// - `#jev …` commands are answered in the chat and never reach the model.
// - Guard mode (`#jev an`, per chat): Jev classifies each new task; the model is
//   chosen from published benchmarks (src/model-policy.ts), the effort from the
//   weighted per-model evidence (src/model-spectrum.ts).
// - Claude: a hook cannot switch model or effort, but a skill can: skill frontmatter
//   `model`/`effort` applies to the rest of the current message. The hook asks Claude
//   to invoke Jev's plugin skills first, so effort changes happen automatically and a
//   model change takes one click ("Jev folgen", AskUserQuestion). The next message
//   checks in the transcript what really ran.
// - Codex: hooks and skills have no such override, so a clear model change holds the
//   message once and the user switches in the menu.
import { mkdirSync, writeFileSync, renameSync, readFileSync, openSync, readSync, closeSync, statSync, realpathSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CLAUDE_TIERS, EFFORTS, codexTiers, effortLabel, guardDecision, inspectChat, inspectLabels, modelDisplay, pickEffort, readClaudeSession, tierOf, userText, type InspectResult, type ModelTier } from './chat-inspect.js';
import { codexTurnSettings, findCodexRollout, readCodexCatalog, readCodexRollout } from './codex-rollout.js';
import { BENCHMARKS, BENCHMARKS_AS_OF, MODEL_FACTS, modelKey } from './model-benchmarks.js';
import { DIFFICULTIES, MIN_SAVING, MIN_SWITCH_POINTS, SPECTRUM_MIN_GAP, TASK_KINDS, TOLERANCE, decideModel, spectrumEffort, type PolicyResult } from './model-policy.js';
import { describeContext, type HistoryTurn } from './routing-context.js';
import { gatewayKey } from './gateway-key.js';
import { stateDirectory } from './state-dir.js';

export type Focus = { kind: 'claude' | 'codex'; id: string; at: number; cwd?: string | null };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASS_WINDOW_MS = 15 * 60_000;
/** Prompts shorter than this ("weiter", "ok") are follow-ups: no new Jev call. */
const SHORT_PROMPT = 20;

function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, file);
}
function readJson(file: string): any { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

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

export type JevCommand = { kind: 'analyze'; task?: string } | { kind: 'question'; question?: string } | { kind: 'guard'; enabled: boolean } | { kind: 'help' } | { kind: 'status' };
export function parseJevCommand(prompt: string): JevCommand | null {
  const m = /^\s*#jev(\?)?(?:\s+([\s\S]*))?$/i.exec(prompt);
  if (!m) return null;
  const rest = m[2]?.trim() || undefined;
  if (m[1]) return { kind: 'question', question: rest };
  if (rest && /^(an|ein|on)$/i.test(rest)) return { kind: 'guard', enabled: true };
  if (rest && /^(aus|off)$/i.test(rest)) return { kind: 'guard', enabled: false };
  if (rest && /^(hilfe|help|\?)$/i.test(rest)) return { kind: 'help' };
  if (rest && /^status$/i.test(rest)) return { kind: 'status' };
  return { kind: 'analyze', task: rest };
}

/** The model of the latest assistant message in a Claude transcript, if any. */
export function currentModel(transcriptPath: string): string | null {
  try {
    const size = statSync(transcriptPath).size, len = Math.min(size, 524_288);
    const fd = openSync(transcriptPath, 'r'); const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    const models = [...buf.toString('utf8').matchAll(/"role":"assistant"[^\n]*?"model":"([a-z0-9.\-\[\]]+)"|"model":"(claude-[a-z0-9.\-\[\]]+)"[^\n]*?"role":"assistant"/g)];
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

// ---------- app profiles ----------
export type Setting = { model: string | null; effort: string | null };
export type AppProfile = {
  kind: 'claude' | 'codex'; name: string; tiers: ModelTier[]; candidates: string[];
  readTurns: () => HistoryTurn[]; current: () => Setting;
  efforts: (model: string) => string[]; display: (model: string | null) => string;
};
const CLAUDE_EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** `running`: what this chat currently runs on (Jev's model if the user accepted one, else the menu). */
export function claudeProfile(event: any, running?: Setting): AppProfile {
  const path = String(event.transcript_path ?? '');
  return { kind: 'claude', name: 'Claude', tiers: CLAUDE_TIERS,
    candidates: Object.keys(MODEL_FACTS).filter(k => MODEL_FACTS[k]!.app === 'claude'),
    readTurns: () => readClaudeSession(path), current: () => running ?? { model: effectiveModel(path), effort: null },
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
  const effort = useSpectrum ? fromSpectrum!.effort : pickEffort(r.effort, offered);
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

export const HELP = (app = 'Claude') => [
  `Jev-Befehle (werden nicht an ${app} gesendet):`,
  '  #jev               – diesen Chat analysieren',
  '  #jev <Aufgabe>     – Modell + Effort für die Aufgabe empfehlen',
  '  #jev? <Frage>      – Ja/Nein-Frage zum Chat, Antwort in %',
  app === 'Claude'
    ? '  #jev an / #jev aus – für DIESEN Chat: Effort stellt Jev pro Nachricht selbst ein, ein Modellwechsel braucht einen Klick'
    : '  #jev an / #jev aus – Wächter für DIESEN Chat: jede neue Nachricht erst von Jev prüfen lassen',
  '  #jev status        – was Jev in diesem Chat eingestellt hat und was wirklich lief',
].join('\n');

export function formatResult(r: InspectResult, description: string | null, app: AppProfile, opts: { guard?: boolean } = {}): string {
  if (!r.ok) return `Jev konnte nicht antworten (${r.reason}). Keine Werte erfunden, kein Neuversuch.`;
  const L = inspectLabels as Record<string, Record<string, string>>;
  const lines: string[] = [];
  if (r.taskKind || r.nextModel) {
    const rec = recommend(r, app);
    lines.push(opts.guard ? 'Jev-Wächter – Empfehlung für diese Nachricht' : 'Jev – Empfehlung für die Aufgabe');
    if (r.taskKind && r.difficulty) lines.push(`  Aufgabe: ${KIND_LABEL[r.taskKind.choice] ?? r.taskKind.choice} · ${DIFF_LABEL[r.difficulty.choice] ?? r.difficulty.choice}   (Jev: ${pct(r.taskKind.probabilities[r.taskKind.choice])} / ${pct(r.difficulty.probabilities[r.difficulty.choice])})`);
    const same = rec.model && rec.current && (modelKey(rec.model) ?? rec.model) === (modelKey(rec.current) ?? rec.current);
    lines.push(`  Modell:  ${app.display(rec.model)}${same ? ' – passt bereits' : `   (aktuell: ${app.display(rec.current)})`}`);
    lines.push(`  Grund:   ${rec.why}`);
    if (rec.effort) lines.push(`  Effort:  ${effortLabel(rec.effort)}${rec.effortAvoidFrom ? ` – nicht ${effortLabel(rec.effortAvoidFrom)} oder höher` : ''}${rec.currentEffort ? `   (aktuell: ${effortLabel(rec.currentEffort)})` : ''}   [${rec.effortSource === 'erfahrung' ? 'Erfahrungswert für dieses Modell' : 'Jev-Einschätzung'}]`);
    else if (rec.model) lines.push(`  Effort:  – (${app.display(rec.model)} hat in ${app.name} keine Effort-Stufe)`);
  }
  lines.push(`  Chat:    ${L.progress![r.progress.choice] ?? r.progress.choice} · Hindernis: ${L.blocker![r.blocker.choice] ?? r.blocker.choice} · nächster Schritt: ${L.next_step![r.next_step.choice] ?? r.next_step.choice}`);
  if (r.question) lines.push(`  Frage:   „${r.question.text}“ → ${pct(r.question.yes)} ja`);
  if (opts.guard) lines.push('', 'Weiter: Modell/Effort im Modellmenü umstellen, dann dieselbe Nachricht nochmal senden (↑ und Enter).', 'Nochmal senden ohne Umstellen = Jev ignorieren. Wächter ausschalten: #jev aus');
  else if (r.taskKind) lines.push('', app.kind === 'claude'
    ? 'Automatisch übernehmen: #jev an – dann stellt Jev den Effort pro Nachricht selbst ein, ein Modellwechsel braucht einen Klick.'
    : 'Übernehmen: Modell/Effort im Modellmenü umstellen und die Aufgabe ohne „#jev“ senden.');
  lines.push(`Gelesen: ${description ?? '–'} · ${r.usage.input_tokens} Tokens. Benchmarks Stand ${BENCHMARKS_AS_OF}; Jev ordnet nur die Aufgabe ein – keine Garantie.`);
  return lines.join('\n');
}

// ---------- Claude: model and effort per message through Jev's plugin skills ----------
/** Model keys Jev can switch to and the model id each skill sets (plugins/jev-claude/skills/model-*). */
export const SKILL_MODELS: Record<string, string> = {
  'claude-fable-5-1': 'claude-fable-5-1', 'claude-opus-5-5': 'claude-opus-5-5', 'claude-opus-5': 'claude-opus-5',
  'claude-sonnet-5': 'claude-sonnet-5', 'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};
export const SKILL_EFFORTS = CLAUDE_EFFORT_IDS;
export function modelSkill(model: string | null | undefined): string | null {
  const k = modelKey(model); return k && SKILL_MODELS[k] ? `jev:model-${k.replace(/^claude-/, '')}` : null;
}
export const effortSkill = (effort: string | null | undefined) => effort && CLAUDE_EFFORT_IDS.includes(effort) ? `jev:effort-${effort}` : null;
/** Skills that make the rest of a message run on `model`/`effort` while the app menu is set to `menu`. */
export function skillsFor(model: string | null, effort: string | null, menu: Setting): string[] {
  const skills: string[] = [];
  if (model && !sameKey(model, menu.model)) { const s = modelSkill(model); if (s) skills.push(s); }
  if (effort && effort !== menu.effort) { const s = effortSkill(effort); if (s) skills.push(s); }
  return skills;
}

export type ClaudeTurn = { menu: Setting; ran: Setting; jevSkills: string[]; asked: boolean };
/**
 * The latest answered message of a Claude Code transcript. Its first reply runs on
 * the model/effort set in the app menu; Jev's skills change both for the rest of
 * that message, so the last reply shows what the work really ran on
 * (`message.model`, `perTurnEffort`).
 */
export function lastClaudeTurn(transcriptPath: string, maxBytes = 32 * 1024 * 1024): ClaudeTurn | null {
  let text: string;
  try {
    const size = statSync(transcriptPath).size, len = Math.min(size, maxBytes);
    const fd = openSync(transcriptPath, 'r'); const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    text = buf.toString('utf8'); if (len < size) text = text.slice(text.indexOf('\n') + 1);
  } catch { return null; }
  let turn: ClaudeTurn | null = null, answered: ClaudeTurn | null = null;
  for (const line of text.split('\n')) {
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type === 'user') {
      if (!o.isMeta && userText(o.message?.content)) turn = { menu: { model: null, effort: null }, ran: { model: null, effort: null }, jevSkills: [], asked: false };
      continue;
    }
    const model = o.type === 'assistant' ? o.message?.model : null;
    if (!turn || typeof model !== 'string' || model === '<synthetic>' || o.isApiErrorMessage) continue;
    const effort = typeof o.effort === 'string' ? o.effort : null, perTurn = typeof o.perTurnEffort === 'string' ? o.perTurnEffort : effort;
    if (!turn.menu.model) turn.menu = { model, effort: effort ?? perTurn };
    turn.ran = { model, effort: perTurn };
    for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
      if (b?.type !== 'tool_use') continue;
      if (b.name === 'Skill' && typeof b.input?.skill === 'string' && b.input.skill.startsWith('jev:')) turn.jevSkills.push(b.input.skill);
      if (b.name === 'AskUserQuestion' && JSON.stringify(b.input ?? {}).includes('Jev empfiehlt')) turn.asked = true;
    }
    answered = turn;
  }
  // The prompt being submitted may already be recorded without a reply: use the last answered one.
  return answered;
}

/** Per-chat memory of what Jev set up (chats/<session>.json in the state directory). */
export type ChatState = {
  jevModel?: string;        // model the user accepted with one click; set per message through its skill
  lastEffort?: string;      // effort Jev chose last; short follow-ups reuse it
  pendingAsk?: { model: string; effort: string | null; stayEffort: string | null; at: number };
  declinedModel?: string;   // not offered again until Jev once recommends staying
  expect?: Setting;         // what the previous message should have run on
  lastCheck?: { at: string; expected: string; ran: string; ok: boolean };
};
// One file per chat, so chats running at the same time never overwrite each other.
const chatFile = (stateDir: string, session: string) => join(stateDir, 'chats', `${session.replace(/[^0-9a-z-]/gi, '')}.json`);
export function readChatState(stateDir: string, session: string): ChatState { return readJson(chatFile(stateDir, session)) ?? {}; }
export function writeChatState(stateDir: string, session: string, state: ChatState | null) {
  if (state && Object.keys(state).length) writeJson(chatFile(stateDir, session), state);
  else try { rmSync(chatFile(stateDir, session)); } catch {}
}

const effortName = (e: string | null | undefined) => e ? (EFFORTS.find(x => x.id === e)?.label ?? e) : null;
const showSetting = (display: (m: string | null) => string, s: Setting) =>
  [s.model ? display(s.model) : 'Modell unbekannt', /haiku/i.test(s.model ?? '') ? null : effortName(s.effort)].filter(Boolean).join(' · ');
const ranAsExpected = (expected: Setting, ran: Setting) =>
  (!expected.model || sameKey(ran.model, expected.model)) && (!expected.effort || !ran.effort || ran.effort === expected.effort);

/** Resolves last message's one-click question and checks that it ran on what Jev set. */
export function settleChat(prev: ChatState, turn: ClaudeTurn | null, menu: Setting, display: (m: string | null) => string): { state: ChatState; events: Record<string, unknown>[]; warning: string | null } {
  const state: ChatState = { ...prev }; const events: Record<string, unknown>[] = []; let warning: string | null = null;
  const ran = turn?.ran ?? null;
  const record = (expected: Setting, r: Setting) => {
    const ok = ranAsExpected(expected, r);
    state.lastCheck = { at: new Date().toISOString(), expected: showSetting(display, expected), ran: showSetting(display, r), ok };
    if (!ok) warning = `⚠ letzte Nachricht lief auf ${state.lastCheck.ran} statt ${state.lastCheck.expected}`;
    return ok;
  };
  if (state.pendingAsk) {
    const p = state.pendingAsk; delete state.pendingAsk;
    const skill = modelSkill(p.model);
    if (ran && sameKey(ran.model, p.model)) {
      if (sameKey(p.model, menu.model)) delete state.jevModel; else state.jevModel = p.model;
      delete state.declinedModel;
      if (p.effort) state.lastEffort = p.effort; else delete state.lastEffort;
      events.push({ event: 'accepted', model: p.model, ok: record({ model: p.model, effort: p.effort }, ran), ran });
    } else if (ran && skill && turn!.jevSkills.includes(skill)) {
      // "Jev folgen" was chosen, but Claude Code kept the session model (e.g. a model auto mode does not allow).
      state.declinedModel = p.model;
      events.push({ event: 'not-applied', model: p.model, ran });
      warning = `⚠ „Jev folgen“ gewählt, aber Claude Code hat ${display(p.model)} nicht angewendet (lief auf ${showSetting(display, ran)})`;
    } else if (turn?.asked) {
      state.declinedModel = p.model;
      if (p.stayEffort) state.lastEffort = p.stayEffort; else delete state.lastEffort;
      events.push({ event: 'declined', model: p.model, ran });
    } else events.push({ event: 'not-asked', model: p.model, ran }); // Claude skipped the question: offer it again next time
  }
  if (state.expect) {
    const expected = state.expect; delete state.expect;
    if (ran) events.push({ event: 'applied', ok: record(expected, ran), expected, ran });
  }
  // The user picked Jev's model in the menu: no skill needed any more.
  if (state.jevModel && sameKey(state.jevModel, menu.model)) delete state.jevModel;
  return { state, events, warning };
}

export type Decision = { model: string | null; effort: string | null; stayEffort: string | null; switchModel: boolean; why: string; reason: string | null };
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
/** Jev's answer turned into what this message should run on. `app.current()` is what the chat runs on now. */
export function decideClaude(r: JevAnswer, app: AppProfile): Decision {
  const running = app.current().model;
  const rec = recommend(r, app);
  const switchModel = rec.interrupt && !!rec.model && !!running && !sameKey(rec.model, running);
  const model = switchModel ? rec.model : running;
  return { model, effort: effortFor(model, r, app).effort, stayEffort: effortFor(running, r, app).effort, switchModel,
    why: shortWhy(rec, app, model, running), reason: rec.policy && 'reason' in rec.policy ? rec.policy.reason : null };
}

export type AskOption = { label: string; description: string; skills: string[] };
export type MessagePlan = { skills: string[]; ask: { question: string; follow: AskOption; stay: AskOption } | null; notice: string; state: ChatState; event: string };
/** What this message runs on. `decision` null: short follow-up or no Jev answer, so keep what Jev set last. */
export function planClaudeMessage(input: { menu: Setting; state: ChatState; decision: Decision | null; display: (m: string | null) => string }): MessagePlan {
  const { menu, decision, display } = input;
  const state: ChatState = { ...input.state };
  const running = state.jevModel ?? menu.model;
  const show = (model: string | null, effort: string | null) => showSetting(display, { model, effort: effort ?? menu.effort });
  const menuNote = (skills: string[]) => skills.length && menu.model ? ` (Menü: ${showSetting(display, menu)})` : '';
  if (!decision) {
    const effort = state.lastEffort ?? null;
    const skills = skillsFor(running, effort, menu);
    if (skills.length) state.expect = { model: running, effort: effort ?? menu.effort }; else delete state.expect;
    return { skills, ask: null, state, event: 'kept', notice: skills.length ? `läuft wie zuletzt auf ${show(running, effort)}${menuNote(skills)}` : '' };
  }
  if (decision.switchModel && decision.model && !sameKey(decision.model, state.declinedModel)) {
    const follow = skillsFor(decision.model, decision.effort, menu), stay = skillsFor(running, decision.stayEffort, menu);
    state.pendingAsk = { model: decision.model, effort: decision.effort, stayEffort: decision.stayEffort, at: Date.now() };
    delete state.expect;
    const target = show(decision.model, decision.effort);
    const now = sameKey(running, menu.model) ? showSetting(display, menu) : display(running);
    const stayEffortNote = decision.stayEffort && decision.stayEffort !== menu.effort && stay.length ? `Effort nur auf ${effortName(decision.stayEffort)}.` : 'Nichts umstellen.';
    return { skills: [], state, event: 'asked', notice: `empfiehlt ${target} – Claude fragt gleich nach, ein Klick auf „Jev folgen“ stellt um.`,
      ask: { question: `Jev empfiehlt ${target} statt ${now}. Umstellen?`,
        follow: { label: 'Jev folgen', description: `${target} – ${decision.why}. Gilt dann für diesen Chat.`, skills: follow },
        stay: { label: `${display(running)} behalten`, description: stayEffortNote, skills: stay } } };
  }
  // Stay on the running model; the effort follows Jev automatically.
  const declined = decision.switchModel ? state.declinedModel : undefined;
  if (!decision.switchModel) delete state.declinedModel; // settled once: a later switch may be offered again
  const effort = decision.stayEffort;
  const skills = skillsFor(running, effort, menu);
  if (effort) state.lastEffort = effort; else delete state.lastEffort;
  state.expect = { model: running, effort: effort ?? menu.effort };
  const now = show(running, effort);
  const text = !running ? (skills.length ? `Effort für diese Nachricht: ${effortName(effort)} (Modell noch unbekannt – erst nach der ersten Antwort in diesem Chat)` : '')
    : skills.length ? `diese Nachricht läuft auf ${now}${menuNote(skills)}` : `${now} passt`;
  return { skills, ask: null, state, event: skills.length ? 'auto' : 'passed',
    notice: text + (declined ? ` – Wechsel zu ${display(declined)} hattest du abgelehnt` : '') };
}

const JEV_HEAD = 'Hinweis des Jev-Plugins (vom Nutzer mit „#jev an“ für diesen Chat eingeschaltet; es stellt Modell und Effort nur für diese eine Nachricht um):';
const callSkills = (skills: string[]) => skills.length > 1
  ? `das Skill-Tool ${skills.length === 2 ? 'zweimal' : `${skills.length}-mal`} im selben Schritt auf: ${skills.map(s => `mit skill "${s}"`).join(' und ')}`
  : `das Skill-Tool mit skill "${skills[0]}" auf`;
/** Instructions added to the prompt so Claude invokes Jev's skills (or asks the one-click question) before the task. */
export function claudeInstructions(plan: MessagePlan): string | null {
  if (plan.ask) {
    const { question, follow, stay } = plan.ask;
    const then = (o: AskOption) => o.skills.length ? `rufe sofort ${callSkills(o.skills)}.` : 'rufe kein Skill auf.';
    return [JEV_HEAD,
      'Beginne noch nicht mit der Aufgabe. Stelle als Allererstes mit dem AskUserQuestion-Tool genau diese eine Frage (Texte wörtlich übernehmen, multiSelect: false):',
      `- question: "${question}"`, '- header: "Jev"',
      `- Option 1: label "${follow.label}", description "${follow.description}"`,
      `- Option 2: label "${stay.label}", description "${stay.description}"`,
      `Antwort „${follow.label}“: ${then(follow)}`,
      `Antwort „${stay.label}“: ${then(stay)}`,
      'Freie Antwort: folge ihr sinngemäß. Danach bearbeite die Nachricht ganz normal und erwähne Jev nicht weiter.'].join('\n');
  }
  if (!plan.skills.length) return null;
  return [JEV_HEAD,
    `Rufe als Allererstes – vor jedem anderen Werkzeug und bevor du mit der Aufgabe beginnst – ${callSkills(plan.skills)}.`,
    'Danach bearbeite die Nachricht ganz normal und erwähne diese Umstellung nicht.'].join('\n');
}

function menuOf(turn: ClaudeTurn | null): Setting {
  return { model: turn?.menu.model ?? settingsModel(), effort: turn?.menu.effort ?? (process.env.CLAUDE_EFFORT || null) };
}

async function claudeGuard(event: any, session: string, prompt: string, stateDir: string): Promise<void> {
  const transcript = String(event.transcript_path ?? '');
  const turn = transcript ? lastClaudeTurn(transcript) : null;
  const menu = menuOf(turn);
  const display = claudeProfile(event).display;
  const settled = settleChat(readChatState(stateDir, session), turn, menu, display);
  for (const e of settled.events) logDecision(stateDir, { app: 'claude', session, ...e });
  const trimmed = prompt.trim();
  // Slash commands carry their own model/effort; leave them alone.
  if (trimmed.startsWith('/')) { writeChatState(stateDir, session, settled.state); return; }
  const app = claudeProfile(event, { model: settled.state.jevModel ?? menu.model, effort: menu.effort });
  let decision: Decision | null = null, failure: string | null = null;
  if (trimmed.length >= SHORT_PROMPT) {
    try { const r = await runJev(app, { task: prompt }); if (r.ok) decision = decideClaude(r, app); else failure = r.reason; }
    catch (e) { failure = e instanceof Error ? e.message : 'Fehler'; }
  }
  const plan = planClaudeMessage({ menu, state: settled.state, decision, display });
  writeChatState(stateDir, session, plan.state);
  logDecision(stateDir, { event: plan.event, app: 'claude', session, menu, running: app.current().model, target: decision?.model ?? null,
    effort: decision?.stayEffort ?? null, skills: plan.skills, ask: plan.ask?.follow.skills ?? null, reason: decision?.reason ?? failure });
  const context = claudeInstructions(plan);
  const text = [settled.warning, failure ? `keine Empfehlung (${failure}) – ${plan.notice || 'Nachricht wurde normal gesendet.'}` : plan.notice].filter(Boolean).join(' · ');
  const out: Record<string, unknown> = {};
  if (text) out.systemMessage = `Jev: ${text}`;
  if (context) out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context };
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out) + '\n');
}

function statusText(event: any, appKind: 'claude' | 'codex', session: string, stateDir: string, app: AppProfile): string {
  const on = guardEnabled(stateDir, session);
  const lines = ['Jev-Status für diesen Chat', `  Jev:      ${on ? 'AN' : 'AUS (einschalten: #jev an)'}`];
  if (appKind === 'codex') {
    const cur = app.current();
    lines.push(`  Aktuell:  ${app.display(cur.model)}${cur.effort ? ` · ${effortLabel(cur.effort)}` : ''} (laut Verlauf)`,
      '  Codex bietet keine Schnittstelle, über die Jev Modell oder Effort selbst umstellen kann – bei klarer Empfehlung wird die Nachricht einmal angehalten.');
    return lines.join('\n');
  }
  const turn = lastClaudeTurn(String(event.transcript_path ?? '')), st = readChatState(stateDir, session);
  const show = (s: Setting) => showSetting(app.display, s);
  lines.push(`  Menü:     ${turn ? `${show(turn.menu)} (laut letzter Antwort)` : 'unbekannt – noch keine Antwort in diesem Chat'}`,
    `  Modell:   ${st.jevModel ? `${app.display(st.jevModel)} – per Klick übernommen, Jev stellt es pro Nachricht ein` : 'wie im Menü'}`);
  if (turn) lines.push(`  Zuletzt:  lief auf ${show(turn.ran)}${turn.jevSkills.length ? ` – von Jev gesetzt (${turn.jevSkills.join(', ')})` : ''}`);
  if (st.lastCheck) lines.push(`  Prüfung:  ${st.lastCheck.ok ? `✓ lief wie von Jev gesetzt (${st.lastCheck.ran})` : `⚠ Jev wollte ${st.lastCheck.expected}, lief auf ${st.lastCheck.ran}`}`);
  if (st.declinedModel) lines.push(`  Abgelehnt: ${app.display(st.declinedModel)} (wird erst wieder angeboten, wenn Jev einmal „passt“ sagt)`);
  return lines.join('\n');
}

const GUARD_ON = {
  claude: [
    'Jev ist für DIESEN Chat AN – ab jetzt ohne #jev.',
    '• Effort: Jev stellt ihn für jede Nachricht selbst passend zu Aufgabe und Modell ein (gilt nur für diese Nachricht, das Menü bleibt).',
    `• Modell: Ist ein anderes Modell klar besser (ab ${MIN_SWITCH_POINTS} Benchmark-Punkten) oder bei gleicher Qualität mindestens ${Math.round(MIN_SAVING * 100)} % günstiger, fragt Claude einmal nach – ein Klick auf „Jev folgen“ stellt um, danach bleibt der Chat darauf.`,
    '• Kurze Nachrichten („weiter“, „ok“) laufen ohne neue Prüfung mit der letzten Einstellung.',
    'Status: #jev status · Ausschalten: #jev aus',
  ].join('\n'),
  codex: [
    'Jev-Wächter ist für DIESEN Chat AN – ab jetzt ohne #jev.',
    `• Passt dein aktuelles Modell (Benchmark-Unterschied unter ${MIN_SWITCH_POINTS} Punkten), geht die Nachricht sofort durch – mit kurzer Info und Effort-Tipp.`,
    `• Ist ein anderes Modell klar besser oder mindestens ${Math.round(MIN_SAVING * 100)} % günstiger bei gleicher Qualität, wird die Nachricht angehalten: Modell/Effort umstellen und dieselbe Nachricht nochmal senden (↑, Enter) – oder einfach nochmal senden, um Jev zu ignorieren.`,
    'Codex bietet keine Schnittstelle, über die Jev Modell oder Effort selbst umstellen kann.',
    'Ausschalten: #jev aus',
  ].join('\n'),
} as const;

/** Local decision log (no prompt text) so recommendations can later be checked against what actually happened. */
export function logDecision(stateDir: string, entry: Record<string, unknown>) {
  try { mkdirSync(stateDir, { recursive: true }); appendFileSync(join(stateDir, 'guard-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}
const block = (reason: string): void => { process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n'); };
const notice = (systemMessage: string): void => { process.stdout.write(JSON.stringify({ systemMessage }) + '\n'); };

async function runJev(app: AppProfile, opts: { task?: string; question?: string }) {
  return inspectChat({ turns: app.readTurns(), question: opts.question, task: opts.task,
    models: opts.task ? app.tiers : undefined, efforts: opts.task ? EFFORTS : undefined, key: gatewayKey(),
    source: app.kind === 'claude' ? 'Claude Code session' : 'Codex conversation' });
}

export async function handle(event: any, appKind: 'claude' | 'codex', stateDir = stateDirectory()): Promise<void> {
  const session = String(event.session_id ?? event.thread_id ?? '');
  if (SESSION_ID.test(session)) { try { writeFocus(stateDir, { kind: appKind, id: session, at: Date.now(), cwd: event.cwd ?? null }); } catch {} }
  const prompt = String(event.prompt ?? '');
  const command = parseJevCommand(prompt);
  const app = appKind === 'codex' ? codexProfile(event) : claudeProfile(event);

  if (command) {
    if (command.kind === 'help') return block(HELP(app.name));
    if (command.kind === 'status') return block(statusText(event, appKind, session, stateDir, app));
    if (command.kind === 'guard') {
      if (!SESSION_ID.test(session)) return block('Jev: Dieser Chat hat keine erkennbare ID – nicht aktiviert.');
      setGuard(stateDir, session, command.enabled);
      if (!command.enabled) writeChatState(stateDir, session, null);
      return block(command.enabled ? GUARD_ON[appKind] : `Jev ist für diesen Chat AUS. Nachrichten gehen wieder unverändert an ${app.name}.`);
    }
    try {
      const r = await runJev(app, command.kind === 'question' ? { question: command.question } : { task: command.task });
      return block(formatResult(r, r.stats ? describeContext(r.stats) : null, app));
    } catch (e) { return block(`Jev konnte den Chat nicht lesen (${e instanceof Error ? e.message : 'Fehler'}).`); }
  }

  if (!guardEnabled(stateDir, session)) return;
  if (appKind === 'claude') { try { await claudeGuard(event, session, prompt, stateDir); } catch { /* never hold up the user's work because of Jev */ } return; }

  // Codex guard: slash commands and very short replies pass without a Jev call.
  if (prompt.trim().startsWith('/') || prompt.trim().length < SHORT_PROMPT) return;
  const hash = createHash('sha256').update(session + '\0' + prompt.trim()).digest('hex');
  const pendingFile = join(stateDir, 'guard-pending.json');
  const pending = readJson(pendingFile);
  if (pending?.hash === hash && Date.now() - pending.at < PASS_WINDOW_MS) { // second send: user decided
    writeJson(pendingFile, {});
    const now = app.current().model;
    logDecision(stateDir, { event: 'resent', app: appKind, session, current: now, recommended: pending.recommended ?? null, followed: pending.recommended ? (modelKey(now) ?? now) === (modelKey(pending.recommended) ?? pending.recommended) : null });
    return;
  }
  try {
    const r = await runJev(app, { task: prompt });
    if (!r.ok) return notice(`Jev-Wächter: keine Empfehlung (${r.reason}) – Nachricht wurde normal gesendet.`);
    const rec = recommend(r, app);
    const logBase = { app: appKind, session, current: rec.current, recommended: rec.model, basis: rec.basis, taskKind: r.taskKind?.choice ?? null, difficulty: r.difficulty?.choice ?? null, effort: rec.effort, reason: rec.policy && 'reason' in rec.policy ? rec.policy.reason : null };
    if (!rec.interrupt) {
      logDecision(stateDir, { event: 'passed', ...logBase });
      const effortTip = rec.effort && rec.effort !== rec.currentEffort ? ` · Effort-Tipp: ${effortLabel(rec.effort)}` : '';
      return notice(`Jev: ${app.display(rec.current)} passt – ${rec.why}${effortTip}`);
    }
    writeJson(pendingFile, { hash, at: Date.now(), recommended: rec.model });
    logDecision(stateDir, { event: 'held', ...logBase });
    return block(formatResult(r, r.stats ? describeContext(r.stats) : null, app, { guard: true }));
  } catch { /* never hold up the user's work because of Jev */ }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2_000_000) return; }
  let event: any; try { event = JSON.parse(raw); } catch { return; }
  const appArg = process.argv.indexOf('--app');
  await handle(event, process.argv[appArg + 1] === 'codex' && appArg > 0 ? 'codex' : 'claude');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => {}).finally(() => { process.exitCode = 0; });
