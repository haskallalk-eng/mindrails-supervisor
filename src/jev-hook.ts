#!/usr/bin/env node
// UserPromptSubmit hook for Claude Code (`--app claude`, default) and Codex (`--app codex`).
// - Records which chat the user last typed in (for the Jev side panel).
// - `#jev …` commands are answered in the chat and never reach the model.
// - Guard mode (`#jev an`, per chat): Jev classifies each new task; the model is
//   chosen from published benchmarks (src/model-policy.ts). Only a clear quality
//   gap or a large saving holds the message; sending it again lets it through.
// Hooks cannot switch model or effort; the user does that in the app's menu.
import { mkdirSync, writeFileSync, renameSync, readFileSync, openSync, readSync, closeSync, statSync, realpathSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CLAUDE_TIERS, EFFORTS, codexTiers, effortLabel, guardDecision, inspectChat, inspectLabels, modelDisplay, pickEffort, readClaudeSession, tierOf, type InspectResult, type ModelTier } from './chat-inspect.js';
import { codexTurnSettings, findCodexRollout, readCodexCatalog, readCodexRollout } from './codex-rollout.js';
import { BENCHMARKS, BENCHMARKS_AS_OF, MODEL_FACTS, modelKey } from './model-benchmarks.js';
import { DIFFICULTIES, MIN_SAVING, MIN_SWITCH_POINTS, SPECTRUM_MIN_GAP, TASK_KINDS, TOLERANCE, decideModel, spectrumEffort, type PolicyResult } from './model-policy.js';
import { describeContext, type HistoryTurn } from './routing-context.js';
import { gatewayKey } from './gateway-key.js';
import { stateDirectory } from './state-dir.js';

export type Focus = { kind: 'claude' | 'codex'; id: string; at: number; cwd?: string | null };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASS_WINDOW_MS = 15 * 60_000;

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

export type JevCommand = { kind: 'analyze'; task?: string } | { kind: 'question'; question?: string } | { kind: 'guard'; enabled: boolean } | { kind: 'help' };
export function parseJevCommand(prompt: string): JevCommand | null {
  const m = /^\s*#jev(\?)?(?:\s+([\s\S]*))?$/i.exec(prompt);
  if (!m) return null;
  const rest = m[2]?.trim() || undefined;
  if (m[1]) return { kind: 'question', question: rest };
  if (rest && /^(an|ein|on)$/i.test(rest)) return { kind: 'guard', enabled: true };
  if (rest && /^(aus|off)$/i.test(rest)) return { kind: 'guard', enabled: false };
  if (rest && /^(hilfe|help|\?)$/i.test(rest)) return { kind: 'help' };
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
/** Current Claude model from the transcript, else the model configured in Claude Code settings. */
export function effectiveModel(transcriptPath: string, settingsPath = join(homedir(), '.claude', 'settings.json')): string | null {
  return currentModel(transcriptPath) ?? (typeof readJson(settingsPath)?.model === 'string' ? readJson(settingsPath).model : null);
}

// ---------- app profiles ----------
export type AppProfile = {
  kind: 'claude' | 'codex'; name: string; tiers: ModelTier[]; candidates: string[];
  readTurns: () => HistoryTurn[]; current: () => { model: string | null; effort: string | null };
  efforts: (model: string) => string[]; display: (model: string | null) => string;
};
const CLAUDE_EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function claudeProfile(event: any): AppProfile {
  const path = String(event.transcript_path ?? '');
  return { kind: 'claude', name: 'Claude', tiers: CLAUDE_TIERS,
    candidates: Object.keys(MODEL_FACTS).filter(k => MODEL_FACTS[k]!.app === 'claude'),
    readTurns: () => readClaudeSession(path), current: () => ({ model: effectiveModel(path), effort: null }),
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

export function recommend(r: Extract<InspectResult, { ok: true }>, app: AppProfile): Recommendation {
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
  const effortModel = model ?? cur.model ?? '';
  // Effort differs per model: prefer the level the weighted evidence points to for THIS model, if the app offers it.
  const kind = (r.taskKind?.choice ?? 'coding') as keyof typeof TASK_KINDS;
  const fromSpectrum = spectrumEffort(effortModel, kind);
  const offered = app.efforts(effortModel);
  const useSpectrum = fromSpectrum && offered.includes(fromSpectrum.effort);
  const effort = useSpectrum ? fromSpectrum!.effort : pickEffort(r.effort, offered);
  return { model, interrupt, why, basis, effort, effortSource: effort ? (useSpectrum ? 'erfahrung' : 'jev') : null,
    effortAvoidFrom: useSpectrum && fromSpectrum!.avoidFrom && offered.includes(fromSpectrum!.avoidFrom) ? fromSpectrum!.avoidFrom : null,
    currentEffort: cur.effort, current: cur.model, policy };
}

export const HELP = (app = 'Claude') => [
  `Jev-Befehle (werden nicht an ${app} gesendet):`,
  '  #jev               – diesen Chat analysieren',
  '  #jev <Aufgabe>     – Modell + Effort für die Aufgabe empfehlen',
  '  #jev? <Frage>      – Ja/Nein-Frage zum Chat, Antwort in %',
  '  #jev an / #jev aus – Wächter für DIESEN Chat: jede neue Nachricht erst von Jev prüfen lassen',
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
  else if (r.taskKind) lines.push('', 'Übernehmen: Modell/Effort im Modellmenü umstellen und die Aufgabe ohne „#jev“ senden.');
  lines.push(`Gelesen: ${description ?? '–'} · ${r.usage.input_tokens} Tokens. Benchmarks Stand ${BENCHMARKS_AS_OF}; Jev ordnet nur die Aufgabe ein – keine Garantie.`);
  return lines.join('\n');
}

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
    if (command.kind === 'guard') {
      if (!SESSION_ID.test(session)) return block('Jev-Wächter: Dieser Chat hat keine erkennbare ID – nicht aktiviert.');
      setGuard(stateDir, session, command.enabled);
      return block(command.enabled
        ? `Jev-Wächter ist für DIESEN Chat AN – ab jetzt ohne #jev.\n• Passt dein aktuelles Modell (Benchmark-Unterschied unter ${MIN_SWITCH_POINTS} Punkten), geht die Nachricht sofort durch – mit kurzer Info und Effort-Tipp.\n• Ist ein anderes Modell klar besser oder mindestens ${Math.round(MIN_SAVING * 100)} % günstiger bei gleicher Qualität, wird die Nachricht angehalten: Modell/Effort umstellen und dieselbe Nachricht nochmal senden (↑, Enter) – oder einfach nochmal senden, um Jev zu ignorieren.\nAusschalten: #jev aus`
        : `Jev-Wächter ist für diesen Chat AUS. Nachrichten gehen wieder direkt an ${app.name}.`);
    }
    try {
      const r = await runJev(app, command.kind === 'question' ? { question: command.question } : { task: command.task });
      return block(formatResult(r, r.stats ? describeContext(r.stats) : null, app));
    } catch (e) { return block(`Jev konnte den Chat nicht lesen (${e instanceof Error ? e.message : 'Fehler'}).`); }
  }

  // Guard mode: slash commands and very short replies pass without a Jev call.
  if (!guardEnabled(stateDir, session) || prompt.trim().startsWith('/') || prompt.trim().length < 20) return;
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
