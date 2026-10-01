import { join } from 'node:path';
import { homedir } from 'node:os';

/** Per-user directory for Jev's local state (focus, guard, locks, log). */
export function stateDirectory(): string {
  return process.env.JEV_PANEL_HOME ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'mindrails-jev') : join(homedir(), '.mindrails-jev'));
}
