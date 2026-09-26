#!/usr/bin/env node
// Claude Code UserPromptSubmit hook.
// 1. Records which chat the user last typed in, so the Jev panel can target it.
// 2. `#jev` / `#jev <next task>` / `#jev? <yes/no question>` is answered by Jev
//    directly in the chat; the prompt is blocked and never reaches Claude.
// Any failure lets the prompt through unchanged, except for #jev commands.
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { CLAUDE_MODELS, inspectChat, inspectLabels, readClaudeSession, type InspectResult } from './chat-inspect.js';
import { describeContext } from './routing-context.js';

export type Focus = { kind: 'claude' | 'codex'; id: string; at: number; cwd?: string | null };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function focusFile(stateDir: string) { return join(stateDir, 'focus.json'); }

export function writeFocus(stateDir: string, focus: Focus) {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${focusFile(stateDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(focus)); renameSync(tmp, focusFile(stateDir));
}
export function readFocus(stateDir: string): Focus | null {
  try { const f = JSON.parse(readFileSync(focusFile(stateDir), 'utf8')); return (f.kind === 'claude' || f.kind === 'codex') && SESSION_ID.test(f.id) && Number.isFinite(f.at) ? f : null; } catch { return null; }
}

export function parseJevCommand(prompt: string): { question?: string; task?: string } | null {
  const m = /^\s*#jev(\?)?(?:\s+([\s\S]*))?$/i.exec(prompt);
  if (!m) return null;
  const rest = m[2]?.trim() || undefined;
  return m[1] ? { question: rest } : { task: rest };
}

export function formatResult(r: InspectResult, description: string | null): string {
  if (!r.ok) return `Jev konnte nicht antworten (${r.reason}). Keine Werte erfunden, kein Neuversuch.`;
  const L = inspectLabels as Record<string, Record<string, string>>;
  const pct = (j: { choice: string; probabilities: Record<string, number> }) => `${Math.round((j.probabilities[j.choice] ?? 0) * 100)} %`;
  const lines = [
    `Jev: ${L.progress![r.progress.choice] ?? r.progress.choice} (${pct(r.progress)}) · Hindernis: ${L.blocker![r.blocker.choice] ?? r.blocker.choice} (${pct(r.blocker)}) · Nächster Schritt: ${L.next_step![r.next_step.choice] ?? r.next_step.choice} (${pct(r.next_step)})`,
  ];
  if (r.nextModel) {
    const label = (id: string) => CLAUDE_MODELS.find(m => m.id === id)?.label ?? id;
    const ranked = Object.entries(r.nextModel.probabilities).sort((a, b) => b[1] - a[1]).map(([id, p]) => `${label(id)} ${Math.round(p * 100)} %`).join(' · ');
    lines.push(`Empfohlenes Modell für die Aufgabe: ${label(r.nextModel.choice)} (${ranked}). Modell umstellen und die Aufgabe ohne „#jev“ erneut senden.`);
  }
  if (r.question) lines.push(`„${r.question.text}“: ${Math.round(r.question.yes * 100)} % ja`);
  lines.push(`Gelesen: ${description ?? '–'} · ${r.usage.input_tokens} Tokens. Wahrscheinlichkeiten, keine geprüften Fakten.`);
  return lines.join('\n');
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2_000_000) return; }
  let event: any; try { event = JSON.parse(raw); } catch { return; }
  const { stateDirectory } = await import('./jev-panel.js');
  const stateDir = stateDirectory();
  if (SESSION_ID.test(String(event.session_id ?? ''))) {
    try { writeFocus(stateDir, { kind: 'claude', id: event.session_id, at: Date.now(), cwd: event.cwd ?? null }); } catch {}
  }
  const command = parseJevCommand(String(event.prompt ?? ''));
  if (!command) return;
  let text: string;
  try {
    const turns = readClaudeSession(String(event.transcript_path));
    const { gatewayKey } = await import('./jev.js');
    const result = await inspectChat({ turns, question: command.question, task: command.task, models: command.task ? CLAUDE_MODELS : undefined, key: gatewayKey(), source: 'Claude Code session' });
    text = formatResult(result, result.stats ? describeContext(result.stats) : null);
  } catch (e) { text = `Jev konnte den Chat nicht lesen (${e instanceof Error ? e.message : 'Fehler'}).`; }
  process.stdout.write(JSON.stringify({ decision: 'block', reason: text }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => {}).finally(() => { process.exitCode = 0; });
