// Codex UserPromptSubmit hook: remembers which conversation the user last typed
// in, so the local Jev side panel can analyze that one. Stores only the id.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let raw = '';
for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2_000_000) process.exit(0); }
try {
  const event = JSON.parse(raw);
  const id = String(event.session_id ?? event.thread_id ?? '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    const dir = process.env.JEV_PANEL_HOME ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'mindrails-jev') : join(homedir(), '.mindrails-jev'));
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `focus.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ kind: 'codex', id, at: Date.now(), cwd: event.cwd ?? null }));
    renameSync(tmp, join(dir, 'focus.json'));
  }
} catch {
  // Best effort; never interrupts a Codex turn.
}
