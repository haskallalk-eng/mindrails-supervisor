#!/usr/bin/env node
// Claude Code UserPromptSubmit hook.
// - Records which chat the user last typed in (for the Jev side panel).
// - `#jev …` commands are answered by Jev in the chat; they never reach Claude.
// - Guard mode (`#jev an`): every new prompt is first shown to Jev, which
//   recommends model and effort. Sending the identical prompt again lets it
//   through, so the user decides (switch model/effort first, or ignore).
// A hook cannot switch the model itself; the user does that in the model menu.
import { mkdirSync, writeFileSync, renameSync, readFileSync, openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CLAUDE_TIERS, CLAUDE_MODELS, EFFORTS, guardDecision, inspectChat, inspectLabels, modelDisplay, priceRatio, readClaudeSession, tierOf, type InspectResult } from './chat-inspect.js';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describeContext } from './routing-context.js';

export type Focus = { kind: 'claude' | 'codex'; id: string; at: number; cwd?: string | null };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASS_WINDOW_MS = 15 * 60_000;

export function focusFile(stateDir: string) { return join(stateDir, 'focus.json'); }
function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, file);
}
function readJson(file: string): any { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

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
export function sameModel(current: string | null, recommended: string): boolean {
  const t = tierOf(current); return Boolean(t) && (t!.id === recommended || t!.id === tierOf(recommended)?.id);
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

/** The model of the latest assistant message in the transcript, if any. */
export function currentModel(transcriptPath: string): string | null {
  try {
    const size = statSync(transcriptPath).size, len = Math.min(size, 524_288);
    const fd = openSync(transcriptPath, 'r'); const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    const models = [...buf.toString('utf8').matchAll(/"role":"assistant"[^\n]*?"model":"([a-z0-9.\-\[\]]+)"|"model":"(claude-[a-z0-9.\-\[\]]+)"[^\n]*?"role":"assistant"/g)];
    const last = models.at(-1); return last ? (last[1] ?? last[2] ?? null) : null;
  } catch { return null; }
}

const modelLabel = (id: string | null) => id ? modelDisplay(id) : null;
const tierLabel = (id: string) => { const t = CLAUDE_TIERS.find(x => x.id === id); return t ? `${t.label} (${modelDisplay(t.defaultModel)})` : id; };
/** Current model from the transcript, else the model configured in Claude Code settings. */
export function effectiveModel(transcriptPath: string, settingsPath = join(homedir(), '.claude', 'settings.json')): string | null {
  return currentModel(transcriptPath) ?? (typeof readJson(settingsPath)?.model === 'string' ? readJson(settingsPath).model : null);
}
const pct = (p: number | undefined) => `${Math.round((p ?? 0) * 100)} %`;
const ranked = (probs: Record<string, number>, label: (id: string) => string, n = 4) =>
  Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, p]) => `${label(id)} ${pct(p)}`).join(' · ');

export const HELP = [
  'Jev-Befehle (werden nicht an Claude gesendet):',
  '  #jev              – diesen Chat analysieren',
  '  #jev <Aufgabe>    – Modell + Effort für die Aufgabe empfehlen',
  '  #jev? <Frage>     – Ja/Nein-Frage zum Chat, Antwort in %',
  '  #jev an / #jev aus – Wächter: jede neue Nachricht erst von Jev prüfen lassen',
].join('\n');

export function formatResult(r: InspectResult, description: string | null, opts: { current?: string | null; guard?: boolean } = {}): string {
  if (!r.ok) return `Jev konnte nicht antworten (${r.reason}). Keine Werte erfunden, kein Neuversuch.`;
  const L = inspectLabels as Record<string, Record<string, string>>;
  const lines: string[] = [];
  if (r.nextModel) {
    const mLabel = tierLabel;
    const eLabel = (id: string) => EFFORTS.find(e => e.id === id)?.label ?? id;
    lines.push(opts.guard ? 'Jev-Wächter – Empfehlung für diese Nachricht' : 'Jev – Empfehlung für die Aufgabe');
    const tier = CLAUDE_TIERS.find(t => t.id === r.nextModel!.choice);
    lines.push(`  Stufe:   ${mLabel(r.nextModel.choice)}   (${ranked(r.nextModel.probabilities, id => CLAUDE_TIERS.find(t => t.id === id)?.label ?? id)})`);
    if (tier) lines.push(`           gleichwertig: ${tier.members}`);
    if (r.effort) lines.push(`  Effort:  ${eLabel(r.effort.choice)}   (${ranked(r.effort.probabilities, eLabel, 3)})`);
    if (opts.current) {
      const same = sameModel(opts.current, r.nextModel.choice);
      lines.push(`  Aktuell: ${modelLabel(opts.current)} (Stufe ${tierOf(opts.current)?.label ?? 'unbekannt'})${same ? ' – passt bereits' : ''}`);
      const from = tierOf(opts.current);
      if (from && tier && !same) {
        const ratio = priceRatio(from, tier);
        lines.push(`  Kosten:  ${modelDisplay(tier.defaultModel)} kostet pro Token ${ratio < 1 ? `nur ${Math.round(ratio * 100)} %` : `das ${ratio.toFixed(1).replace('.', ',')}-Fache`} von ${modelLabel(opts.current)} (Listenpreis; pro Aufgabe kann es abweichen)`);
      }
    }
  }
  lines.push(`  Chat:    ${L.progress![r.progress.choice] ?? r.progress.choice} · Hindernis: ${L.blocker![r.blocker.choice] ?? r.blocker.choice} · nächster Schritt: ${L.next_step![r.next_step.choice] ?? r.next_step.choice}`);
  if (r.question) lines.push(`  Frage:   „${r.question.text}“ → ${pct(r.question.yes)} ja`);
  if (opts.guard) lines.push('', 'Weiter: Modell/Effort bei Bedarf im Modellmenü umstellen, dann dieselbe Nachricht nochmal senden (↑ und Enter).', 'Nochmal senden ohne Umstellen = Jev ignorieren. Wächter ausschalten: #jev aus');
  else if (r.nextModel) lines.push('', 'Übernehmen: Modell/Effort im Modellmenü umstellen und die Aufgabe ohne „#jev“ senden.');
  lines.push(`Gelesen: ${description ?? '–'} · ${r.usage.input_tokens} Tokens. Jev-Wahrscheinlichkeiten, gestützt auf Anthropics eigene Messwerte (nicht unabhängig, für Fable 5/Opus 5 gemessen) – keine Garantie.`);
  return lines.join('\n');
}

/** Local decision log (no prompt text) so recommendations can later be checked against what actually happened. */
export function logDecision(stateDir: string, entry: Record<string, unknown>) {
  try { mkdirSync(stateDir, { recursive: true }); appendFileSync(join(stateDir, 'guard-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}
const block = (reason: string) => process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');

async function runJev(event: any, opts: { task?: string; question?: string }) {
  const turns = readClaudeSession(String(event.transcript_path));
  const { gatewayKey } = await import('./jev.js');
  return inspectChat({ turns, question: opts.question, task: opts.task, models: opts.task ? CLAUDE_MODELS : undefined, efforts: opts.task ? EFFORTS : undefined, key: gatewayKey(), source: 'Claude Code session' });
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2_000_000) return; }
  let event: any; try { event = JSON.parse(raw); } catch { return; }
  const { stateDirectory } = await import('./jev-panel.js');
  const stateDir = stateDirectory();
  const session = String(event.session_id ?? '');
  if (SESSION_ID.test(session)) { try { writeFocus(stateDir, { kind: 'claude', id: session, at: Date.now(), cwd: event.cwd ?? null }); } catch {} }
  const prompt = String(event.prompt ?? '');
  const command = parseJevCommand(prompt);

  if (command) {
    if (command.kind === 'help') return block(HELP);
    if (command.kind === 'guard') {
      if (!SESSION_ID.test(session)) return block('Jev-Wächter: Dieser Chat hat keine erkennbare ID – nicht aktiviert.');
      setGuard(stateDir, session, command.enabled);
      return block(command.enabled
        ? 'Jev-Wächter ist für DIESEN Chat AN – du musst ab jetzt kein #jev mehr schreiben.\n• Empfiehlt Jev dasselbe Modell, das du gerade nutzt, geht deine Nachricht sofort durch (mit kurzer Info).\n• Empfiehlt er ein anderes Modell, wird die Nachricht angehalten: Modell/Effort umstellen und dieselbe Nachricht nochmal senden (↑, Enter) – oder einfach nochmal senden, um Jev zu ignorieren.\nAusschalten: #jev aus'
        : 'Jev-Wächter ist für diesen Chat AUS. Nachrichten gehen wieder direkt an Claude.');
    }
    try {
      const r = await runJev(event, command.kind === 'question' ? { question: command.question } : { task: command.task });
      return block(formatResult(r, r.stats ? describeContext(r.stats) : null, { current: effectiveModel(String(event.transcript_path)) }));
    } catch (e) { return block(`Jev konnte den Chat nicht lesen (${e instanceof Error ? e.message : 'Fehler'}).`); }
  }

  // Guard mode: slash commands and very short replies pass without a Jev call.
  if (!guardEnabled(stateDir, session) || prompt.trim().startsWith('/') || prompt.trim().length < 20) return;
  const hash = createHash('sha256').update(session + '\0' + prompt.trim()).digest('hex');
  const pendingFile = join(stateDir, 'guard-pending.json');
  const pending = readJson(pendingFile);
  if (pending?.hash === hash && Date.now() - pending.at < PASS_WINDOW_MS) { // second send: user decided
    writeJson(pendingFile, {});
    const now = effectiveModel(String(event.transcript_path));
    logDecision(stateDir, { event: 'resent', session, current: now, recommended: pending.recommended ?? null, followed: pending.recommended ? tierOf(now)?.id === pending.recommended : null });
    return;
  }
  try {
    const r = await runJev(event, { task: prompt });
    if (!r.ok) { process.stdout.write(JSON.stringify({ systemMessage: `Jev-Wächter: keine Empfehlung (${r.reason}) – Nachricht wurde normal gesendet.` }) + '\n'); return; }
    const current = effectiveModel(String(event.transcript_path));
    const decision = r.nextModel ? guardDecision(current, r.nextModel) : null;
    if (decision && !decision.interrupt) {
      logDecision(stateDir, { event: 'passed', session, current, recommended: r.nextModel?.choice ?? null, reason: decision.reason, probabilities: r.nextModel?.probabilities ?? null });
      const effort = r.effort ? EFFORTS.find(e => e.id === r.effort!.choice)?.label : null;
      const why = decision.reason === 'same-tier' ? `${modelLabel(current)} passt (Stufe ${decision.current!.label})`
        : decision.reason === 'unclear' ? `Jev tendiert zu ${decision.recommended.label}, aber nicht deutlich genug – ${modelLabel(current)} bleibt`
        : `aktuelles Modell unbekannt – Jev empfiehlt Stufe ${decision.recommended.label}`;
      process.stdout.write(JSON.stringify({ systemMessage: `Jev: ${why}${effort ? ` · Effort-Tipp: ${effort}` : ''} – Nachricht gesendet.` }) + '\n');
      return;
    }
    writeJson(pendingFile, { hash, at: Date.now(), recommended: r.nextModel?.choice ?? null });
    logDecision(stateDir, { event: 'held', session, current, recommended: r.nextModel?.choice ?? null, probabilities: r.nextModel?.probabilities ?? null, effort: r.effort?.choice ?? null });
    return block(formatResult(r, r.stats ? describeContext(r.stats) : null, { current, guard: true }));
  } catch { /* never hold up the user's work because of Jev */ }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => {}).finally(() => { process.exitCode = 0; });
