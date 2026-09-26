import { execFileSync } from 'node:child_process';

/** Only the explicitly configured AI Gateway key; never enumerates other credentials. */
export function gatewayKey(): string | undefined {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  // Apps started before the key was set do not see it in their environment; read the user-scoped value.
  if (process.platform === 'win32' && !process.env.JEV_NO_USER_KEY) try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('AI_GATEWAY_API_KEY','User')"], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {}
  return undefined;
}
